import { z } from "zod";
import { PROJECT_AUDIENCES, type ProjectStatus } from "@/lib/projects";
import type { Driver, Tx } from "../db";
import { runIn } from "../db/context";
import { AppError, fromDbError } from "../errors";
import { canManageCounty, loadAccess } from "./access";
import { DEFAULT_RADIUS_MILES, RADIUS_OPTIONS_MILES, membershipRole } from "./directory";
import { parseOrThrow } from "./identity";
import { writeAudit } from "./shared";
import { suggestForProject } from "./suggestions";
import { TAKEN_SQL, noticeProjectCancelled } from "./volunteers";

export type NeedRow = {
  id: string;
  title: string;
  details: string | null;
  urgency: "NORMAL" | "URGENT";
  slotsNeeded: number;
  startsAt: string | null;
  endsAt: string | null;
  skills: string | null;
  instructions: string | null;
};

export type ProjectRow = {
  id: string;
  orgId: string;
  orgName: string;
  title: string;
  description: string;
  countyId: string;
  countyName: string;
  state: string;
  zip: string;
  /** The site the project is placed at (its pin on the map); null only for projects created before migration 0019. */
  siteId: string | null;
  audience: string;
  status: ProjectStatus;
  privateLocationNotes: string | null;
  reviewNote: string | null;
  /** True when the reader is an editor of the owning org and the org may currently publish. Drives which controls the UI shows. */
  canEdit: boolean;
  needs: NeedRow[];
};

const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .or(z.literal("").transform(() => undefined));

export const projectSchema = z.object({
  title: z.string().trim().min(5).max(140),
  description: z.string().trim().min(10).max(4000),
  /** The organization's site the project starts at; county and ZIP are taken from it. */
  siteId: z.string().uuid("Choose a location"),
  audience: z.enum(PROJECT_AUDIENCES),
  privateLocationNotes: optText(1000),
});

const uuid = (v: unknown) => parseOrThrow(z.string().uuid(), v);

/** The actor must be an ORG_ADMIN or EDITOR of an APPROVED, non-suspended organization. */
async function assertOrgEditor(tx: Tx, userId: string, orgId: string): Promise<void> {
  const org = await tx.query<{ status: string; publication_suspended: boolean }>(
    `SELECT status::text AS status, publication_suspended FROM organizations WHERE id = $1`,
    [orgId],
  );
  const role = await membershipRole(tx, orgId, userId);
  if (!org.length || !role || !["ORG_ADMIN", "EDITOR"].includes(role)) {
    throw new AppError("FORBIDDEN", "Only editors of this organization can change its projects.");
  }
  if (org[0].status !== "APPROVED" || org[0].publication_suspended) {
    throw new AppError("FORBIDDEN", "Only approved organizations can post projects.");
  }
}

const NOT_COVERED = "This location's ZIP is not in a county we cover";
const NOT_SERVED = "Your organization's profile does not list this location's county as served";

/**
 * The site a project starts at: an active site of the same organization whose ZIP lies in a platform county the
 * organization serves. Returns the county and 5-digit ZIP the project takes from it.
 */
async function resolveProjectSite(tx: Tx, orgId: string, siteId: string): Promise<{ countyId: string; zip: string }> {
  const rows = await tx.query<{ county_id: string | null; zip: string | null; served: boolean }>(
    `SELECT s.county_id, left(s.postal_code, 5) AS zip,
            EXISTS (SELECT 1 FROM organization_counties oc WHERE oc.org_id = s.org_id AND oc.county_id = s.county_id) AS served
       FROM staging_sites s WHERE s.id = $1 AND s.org_id = $2 AND s.status = 'ACTIVE'`,
    [siteId, orgId],
  );
  const fail = (msg: string) => new AppError("VALIDATION", "Please correct the highlighted fields.", { siteId: [msg] });
  if (!rows.length) throw fail("Choose one of your organization's locations");
  if (!rows[0].county_id || !rows[0].zip) throw fail(NOT_COVERED);
  if (!rows[0].served) throw fail(NOT_SERVED);
  return { countyId: rows[0].county_id, zip: rows[0].zip };
}

export type ProjectSiteOption = {
  id: string; name: string; city: string | null; zip: string | null; countyName: string | null; usable: boolean; reason: string | null;
};

const ARCHIVED = "This location was archived — choose another";

/**
 * Org members: the organization's active sites a project can start at, each marked usable or not with the reason.
 * `includeSiteId` (a project's current site) is always listed, even when archived, so an edit form can show it and
 * require a deliberate choice instead of silently falling back to another location. Ignored for another org's site.
 */
export async function listProjectSites(driver: Driver, userId: string, orgId: string, includeSiteId?: string | null): Promise<ProjectSiteOption[]> {
  const org = uuid(orgId);
  return runIn(driver, { kind: "system" }, async (tx) => {
    if (!(await membershipRole(tx, org, userId))) throw new AppError("FORBIDDEN", "You are not a member of this organization.");
    const include = includeSiteId && z.string().uuid().safeParse(includeSiteId).success ? includeSiteId : null;
    const rows = await tx.query<{ id: string; name: string; city: string | null; zip: string | null; county_name: string | null; served: boolean; active: boolean }>(
      `SELECT s.id, s.name, s.city, left(s.postal_code, 5) AS zip, c.name AS county_name, s.status = 'ACTIVE' AS active,
              EXISTS (SELECT 1 FROM organization_counties oc WHERE oc.org_id = s.org_id AND oc.county_id = s.county_id) AS served
         FROM staging_sites s LEFT JOIN counties c ON c.id = s.county_id
        WHERE s.org_id = $1 AND (s.status = 'ACTIVE' OR s.id = $2::uuid)
        ORDER BY s.name, s.id`,
      [org, include],
    );
    return rows.map((r) => {
      const reason = !r.active ? ARCHIVED : !r.county_name || !r.zip ? NOT_COVERED : !r.served ? NOT_SERVED : null;
      return { id: r.id, name: r.name, city: r.city, zip: r.zip, countyName: r.county_name, usable: reason === null, reason };
    });
  });
}

type LockedProject = { id: string; org_id: string; status: ProjectStatus };

/** Lock a project and require an org editor of its owning org. Content edits are allowed in DRAFT, OPEN and PAUSED. */
async function lockEditableProject(tx: Tx, userId: string, projectId: string): Promise<LockedProject> {
  const rows = await tx.query<LockedProject>(`SELECT id, org_id, status FROM projects WHERE id = $1 FOR UPDATE`, [projectId]);
  if (!rows.length) throw new AppError("NOT_FOUND", "Project not found.");
  await assertOrgEditor(tx, userId, rows[0].org_id);
  if (!["DRAFT", "OPEN", "PAUSED"].includes(rows[0].status)) {
    throw new AppError("VALIDATION", `A project that is ${rows[0].status} cannot be edited.`);
  }
  return rows[0];
}

/** Content changed on a published project: it goes back to review and leaves the public until re-approved. */
const REVIEW_RESET = `status = CASE WHEN status IN ('OPEN','PAUSED') THEN 'PENDING_REVIEW' ELSE status END`;

/** Org editor: create a DRAFT project. */
export async function createProject(driver: Driver, userId: string, orgId: string, raw: unknown): Promise<string> {
  const input = parseOrThrow(projectSchema, raw);
  const org = uuid(orgId);
  try {
    return await runIn(driver, { kind: "system" }, async (tx) => {
      await assertOrgEditor(tx, userId, org);
      const area = await resolveProjectSite(tx, org, input.siteId);
      const rows = await tx.query<{ id: string }>(
        `INSERT INTO projects (org_id, title, description, county_id, zip, site_id, audience, private_location_notes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [org, input.title, input.description, area.countyId, area.zip, input.siteId, input.audience, input.privateLocationNotes ?? null, userId],
      );
      await writeAudit(tx, {
        actorUserId: userId, actorOrgId: org, action: "PROJECT_CREATED", subjectType: "project", subjectId: rows[0].id,
        details: { title: input.title },
      });
      return rows[0].id;
    });
  } catch (err) {
    throw fromDbError(err);
  }
}

/** Org editor: edit a project's details. An OPEN or PAUSED project goes back to PENDING_REVIEW. */
export async function updateProject(driver: Driver, userId: string, id: string, raw: unknown): Promise<void> {
  const projectId = uuid(id);
  const input = parseOrThrow(projectSchema, raw);
  try {
    await runIn(driver, { kind: "system" }, async (tx) => {
      const p = await lockEditableProject(tx, userId, projectId);
      const area = await resolveProjectSite(tx, p.org_id, input.siteId);
      await tx.query(
        `UPDATE projects SET title = $2, description = $3, county_id = $4, zip = $5, site_id = $6, audience = $7,
                private_location_notes = $8, ${REVIEW_RESET}
          WHERE id = $1`,
        [projectId, input.title, input.description, area.countyId, area.zip, input.siteId, input.audience, input.privateLocationNotes ?? null],
      );
      await writeAudit(tx, {
        actorUserId: userId, actorOrgId: p.org_id, action: "PROJECT_UPDATED", subjectType: "project", subjectId: projectId,
        details: { from: p.status },
      });
    });
  } catch (err) {
    throw fromDbError(err);
  }
}

type DbProject = {
  id: string; org_id: string; org_name: string; title: string; description: string; county_id: string; county_name: string;
  state: string; zip: string; site_id: string | null; audience: string; status: ProjectStatus; private_location_notes: string | null;
  review_note: string | null; org_ok: boolean;
};
type DbNeed = {
  id: string; title: string; details: string | null; urgency: "NORMAL" | "URGENT"; slots_needed: number;
  starts_at: Date | null; ends_at: Date | null; skills: string | null; instructions: string | null;
};

export const PROJECT_SELECT = `
  SELECT p.id, p.org_id, o.display_name AS org_name, p.title, p.description, p.county_id, c.name AS county_name, c.state,
         p.zip, p.site_id, p.audience, p.status, p.private_location_notes, p.review_note,
         (o.status = 'APPROVED' AND NOT o.publication_suspended) AS org_ok
    FROM projects p JOIN organizations o ON o.id = p.org_id JOIN counties c ON c.id = p.county_id`;

const toNeed = (n: DbNeed): NeedRow => ({
  id: n.id, title: n.title, details: n.details, urgency: n.urgency, slotsNeeded: n.slots_needed,
  startsAt: n.starts_at ? new Date(n.starts_at).toISOString() : null,
  endsAt: n.ends_at ? new Date(n.ends_at).toISOString() : null,
  skills: n.skills, instructions: n.instructions,
});

const toProject = (p: DbProject, needs: NeedRow[], role: string | null = null): ProjectRow => ({
  id: p.id, orgId: p.org_id, orgName: p.org_name, title: p.title, description: p.description, countyId: p.county_id,
  countyName: p.county_name, state: p.state, zip: p.zip, siteId: p.site_id, audience: p.audience, status: p.status,
  privateLocationNotes: p.private_location_notes, reviewNote: p.review_note,
  canEdit: p.org_ok && (role === "ORG_ADMIN" || role === "EDITOR"), needs,
});

export async function loadNeeds(tx: Tx, projectId: string): Promise<NeedRow[]> {
  const rows = await tx.query<DbNeed>(
    `SELECT id, title, details, urgency, slots_needed, starts_at, ends_at, skills, instructions
       FROM project_needs WHERE project_id = $1 ORDER BY starts_at NULLS LAST, created_at, id`,
    [projectId],
  );
  return rows.map(toNeed);
}

/**
 * Editor read: members of the owning org, administrators of the project's county, and executives.
 * Returns null for anyone else, so the existence of a project does not leak.
 */
export async function getProjectForEditor(driver: Driver, userId: string, id: string): Promise<ProjectRow | null> {
  if (!z.string().uuid().safeParse(id).success) return null;
  return runIn(driver, { kind: "system" }, async (tx) => {
    const rows = await tx.query<DbProject>(`${PROJECT_SELECT} WHERE p.id = $1`, [id]);
    if (!rows.length) return null;
    const access = await loadAccess(tx, userId);
    const member = await membershipRole(tx, rows[0].org_id, userId);
    if (!member && !canManageCounty(access, rows[0].county_id)) return null;
    return toProject(rows[0], await loadNeeds(tx, id), member);
  });
}

/** Org members: every project the organization has posted (needs are not loaded in this list). */
export async function listOrgProjects(driver: Driver, userId: string, orgId: string): Promise<ProjectRow[]> {
  const org = uuid(orgId);
  return runIn(driver, { kind: "system" }, async (tx) => {
    const role = await membershipRole(tx, org, userId);
    if (!role) throw new AppError("FORBIDDEN", "You are not a member of this organization.");
    const rows = await tx.query<DbProject>(`${PROJECT_SELECT} WHERE p.org_id = $1 ORDER BY p.created_at DESC, p.id`, [org]);
    return rows.map((r) => toProject(r, [], role));
  });
}

// An empty form field means "no shift time"; anything else must parse as a date and is normalized to ISO.
const optShift = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  z
    .string()
    .trim()
    .optional()
    .refine((v) => v === undefined || !Number.isNaN(Date.parse(v)), "Enter a valid date and time")
    .transform((v) => (v === undefined ? undefined : new Date(v).toISOString())),
);

export const needSchema = z
  .object({
    title: z.string().trim().min(3).max(120),
    details: optText(1000),
    urgency: z.enum(["NORMAL", "URGENT"]).default("NORMAL"),
    slotsNeeded: z.coerce.number().int("Use a whole number").min(1, "At least 1").max(500, "At most 500"),
    startsAt: optShift,
    endsAt: optShift,
    skills: optText(200),
    instructions: optText(1000),
  })
  .refine((n) => !n.startsAt || !n.endsAt || Date.parse(n.endsAt) > Date.parse(n.startsAt), {
    message: "The shift must end after it starts",
    path: ["endsAt"],
  });

const needValues = (n: z.infer<typeof needSchema>) => [
  n.title, n.details ?? null, n.urgency, n.slotsNeeded, n.startsAt ?? null, n.endsAt ?? null, n.skills ?? null, n.instructions ?? null,
];

/** Org editor: add a people need. An OPEN or PAUSED project goes back to PENDING_REVIEW. */
export async function addNeed(driver: Driver, userId: string, projectId: string, raw: unknown): Promise<string> {
  const id = uuid(projectId);
  const input = parseOrThrow(needSchema, raw);
  try {
    return await runIn(driver, { kind: "system" }, async (tx) => {
      const p = await lockEditableProject(tx, userId, id);
      const rows = await tx.query<{ id: string }>(
        `INSERT INTO project_needs (project_id, title, details, urgency, slots_needed, starts_at, ends_at, skills, instructions)
         VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz, $8, $9) RETURNING id`,
        [id, ...needValues(input)],
      );
      await tx.query(`UPDATE projects SET ${REVIEW_RESET} WHERE id = $1`, [id]);
      await writeAudit(tx, {
        actorUserId: userId, actorOrgId: p.org_id, action: "PROJECT_NEED_ADDED", subjectType: "project", subjectId: id,
        details: { needId: rows[0].id, from: p.status },
      });
      return rows[0].id;
    });
  } catch (err) {
    throw fromDbError(err);
  }
}

async function projectOfNeed(tx: Tx, needId: string): Promise<string> {
  const rows = await tx.query<{ project_id: string }>(`SELECT project_id FROM project_needs WHERE id = $1`, [needId]);
  if (!rows.length) throw new AppError("NOT_FOUND", "Need not found.");
  return rows[0].project_id;
}

/**
 * Volunteers may already be counting on a need. Slots cannot drop below the number taken, and the shift time cannot
 * move while anyone is signed up. Takes the need lock (the project lock is already held; sign-ups lock only the need).
 */
async function assertNeedChangeAllowed(tx: Tx, needId: string, input: z.infer<typeof needSchema>): Promise<void> {
  const cur = await tx.query<{ starts_at: Date | null; ends_at: Date | null }>(
    `SELECT starts_at, ends_at FROM project_needs WHERE id = $1 FOR UPDATE`,
    [needId],
  );
  const taken = (
    await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM volunteer_commitments WHERE need_id = $1 AND ${TAKEN_SQL}`, [needId])
  )[0].n;
  const fail = (field: string, msg: string) => new AppError("VALIDATION", msg, { [field]: [msg] });
  if (input.slotsNeeded < taken) {
    throw fail("slotsNeeded", `${taken} volunteers have already signed up for this role, so it needs at least ${taken} slots.`);
  }
  const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
  const moved = iso(cur[0].starts_at) !== (input.startsAt ?? null) || iso(cur[0].ends_at) !== (input.endsAt ?? null);
  if (moved && taken > 0) {
    throw fail("startsAt", "Volunteers have signed up for this shift. Cancel their sign-ups before changing its time.");
  }
}

/** Org editor: replace a need's details. An OPEN or PAUSED project goes back to PENDING_REVIEW. */
export async function updateNeed(driver: Driver, userId: string, needId: string, raw: unknown): Promise<void> {
  const id = uuid(needId);
  const input = parseOrThrow(needSchema, raw);
  try {
    await runIn(driver, { kind: "system" }, async (tx) => {
      const projectId = await projectOfNeed(tx, id);
      const p = await lockEditableProject(tx, userId, projectId);
      await assertNeedChangeAllowed(tx, id, input);
      await tx.query(
        `UPDATE project_needs SET title = $2, details = $3, urgency = $4, slots_needed = $5, starts_at = $6::timestamptz,
                ends_at = $7::timestamptz, skills = $8, instructions = $9 WHERE id = $1`,
        [id, ...needValues(input)],
      );
      await tx.query(`UPDATE projects SET ${REVIEW_RESET} WHERE id = $1`, [projectId]);
      await writeAudit(tx, {
        actorUserId: userId, actorOrgId: p.org_id, action: "PROJECT_NEED_UPDATED", subjectType: "project", subjectId: projectId,
        details: { needId: id, from: p.status },
      });
    });
  } catch (err) {
    throw fromDbError(err);
  }
}

/** Org editor: remove a need. An OPEN or PAUSED project goes back to PENDING_REVIEW. */
export async function removeNeed(driver: Driver, userId: string, needId: string): Promise<void> {
  const id = uuid(needId);
  try {
    await runIn(driver, { kind: "system" }, async (tx) => {
      const projectId = await projectOfNeed(tx, id);
      const p = await lockEditableProject(tx, userId, projectId);
      await tx.query(`SELECT 1 FROM project_needs WHERE id = $1 FOR UPDATE`, [id]);
      const history = await tx.query(`SELECT 1 FROM volunteer_commitments WHERE need_id = $1 LIMIT 1`, [id]);
      if (history.length) {
        throw new AppError("VALIDATION", "This role has volunteer sign-ups on record, so it cannot be removed. Cancel the sign-ups and mark the project completed instead.");
      }
      await tx.query(`DELETE FROM project_needs WHERE id = $1`, [id]);
      await tx.query(`UPDATE projects SET ${REVIEW_RESET} WHERE id = $1`, [projectId]);
      await writeAudit(tx, {
        actorUserId: userId, actorOrgId: p.org_id, action: "PROJECT_NEED_REMOVED", subjectType: "project", subjectId: projectId,
        details: { needId: id, from: p.status },
      });
    });
  } catch (err) {
    throw fromDbError(err);
  }
}

/** Moves an organization may make itself. Review decisions are separate (reviewProject); content edits reset to review. */
export const PROJECT_TRANSITIONS: Record<ProjectStatus, ProjectStatus[]> = {
  DRAFT: ["CANCELLED"],
  PENDING_REVIEW: [],
  OPEN: ["PAUSED", "COMPLETED", "CANCELLED"],
  PAUSED: ["OPEN", "COMPLETED", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
};

/** Lock a project and require an org editor, without restricting its status (callers check the transition). */
async function lockProjectForEditor(tx: Tx, userId: string, projectId: string): Promise<LockedProject> {
  const rows = await tx.query<LockedProject>(`SELECT id, org_id, status FROM projects WHERE id = $1 FOR UPDATE`, [projectId]);
  if (!rows.length) throw new AppError("NOT_FOUND", "Project not found.");
  await assertOrgEditor(tx, userId, rows[0].org_id);
  return rows[0];
}

/** Org editor: send a DRAFT project for review. It needs at least one need. */
export async function submitProject(driver: Driver, userId: string, id: string): Promise<void> {
  const projectId = uuid(id);
  try {
    await runIn(driver, { kind: "system" }, async (tx) => {
      const p = await lockProjectForEditor(tx, userId, projectId);
      if (p.status !== "DRAFT") throw new AppError("VALIDATION", `A project that is ${p.status} cannot be submitted.`);
      const n = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM project_needs WHERE project_id = $1`, [projectId]);
      if (n[0].n < 1) throw new AppError("VALIDATION", "Add at least one need before submitting for review.");
      const pinned = await tx.query<{ site_id: string | null }>(`SELECT site_id FROM projects WHERE id = $1`, [projectId]);
      if (!pinned[0].site_id) throw new AppError("VALIDATION", "Choose a location for this project");
      // The location may have been archived, or left a covered county, since the project was saved.
      await resolveProjectSite(tx, p.org_id, pinned[0].site_id);
      await tx.query(`UPDATE projects SET status = 'PENDING_REVIEW', review_note = NULL WHERE id = $1`, [projectId]);
      await writeAudit(tx, {
        actorUserId: userId, actorOrgId: p.org_id, action: "PROJECT_SUBMITTED", subjectType: "project", subjectId: projectId,
      });
    });
  } catch (err) {
    throw fromDbError(err);
  }
}

export const projectReviewSchema = z.object({
  decision: z.enum(["APPROVE", "RETURN"]),
  note: z.string().trim().min(5, "Add a short note").max(2000),
});

/**
 * Executive or a county administrator of the project's county: approve (publish) or return a pending project.
 * Nobody reviews their own organization's project.
 */
export async function reviewProject(driver: Driver, actorId: string, id: string, raw: unknown): Promise<void> {
  const projectId = uuid(id);
  const input = parseOrThrow(projectReviewSchema, raw);
  try {
    await runIn(driver, { kind: "system" }, async (tx) => {
      const rows = await tx.query<LockedProject & { county_id: string }>(
        `SELECT id, org_id, status, county_id FROM projects WHERE id = $1 FOR UPDATE`,
        [projectId],
      );
      if (!rows.length) throw new AppError("NOT_FOUND", "Project not found.");
      const p = rows[0];
      const access = await loadAccess(tx, actorId);
      if (!canManageCounty(access, p.county_id)) throw new AppError("FORBIDDEN", "You do not administer this project's county.");
      if (await membershipRole(tx, p.org_id, actorId)) {
        throw new AppError("FORBIDDEN", "You cannot review your own organization's project.");
      }
      if (p.status !== "PENDING_REVIEW") throw new AppError("VALIDATION", `A project that is ${p.status} is not waiting for review.`);
      if (input.decision === "APPROVE") {
        const org = await tx.query<{ ok: boolean }>(
          `SELECT (status = 'APPROVED' AND NOT publication_suspended) AS ok FROM organizations WHERE id = $1`,
          [p.org_id],
        );
        if (!org[0]?.ok) throw new AppError("VALIDATION", "The organization is not currently approved to publish.");
      }
      await tx.query(
        `UPDATE projects SET status = $2, review_note = $3, reviewed_by = $4, reviewed_at = now() WHERE id = $1`,
        [projectId, input.decision === "APPROVE" ? "OPEN" : "DRAFT", input.decision === "RETURN" ? input.note : null, actorId],
      );
      if (input.decision === "APPROVE") {
        const suggested = await suggestForProject(tx, projectId);
        if (suggested > 0) {
          await writeAudit(tx, { actorUserId: actorId, action: "EVENT_LINKS_SUGGESTED", subjectType: "project", subjectId: projectId, details: { count: suggested } });
        }
      }
      await writeAudit(tx, {
        actorUserId: actorId, actorOrgId: p.org_id, action: input.decision === "APPROVE" ? "PROJECT_APPROVED" : "PROJECT_RETURNED",
        subjectType: "project", subjectId: projectId, details: { note: input.note },
      });
    });
  } catch (err) {
    throw fromDbError(err);
  }
}

/** Org editor: pause, resume, complete or cancel. None of these change content, so none go back to review. */
export async function setProjectStatus(driver: Driver, userId: string, id: string, to: ProjectStatus): Promise<void> {
  const projectId = uuid(id);
  const target = parseOrThrow(z.enum(["DRAFT", "PENDING_REVIEW", "OPEN", "PAUSED", "COMPLETED", "CANCELLED"]), to);
  try {
    await runIn(driver, { kind: "system" }, async (tx) => {
      const p = await lockProjectForEditor(tx, userId, projectId);
      if (!PROJECT_TRANSITIONS[p.status].includes(target)) {
        throw new AppError("VALIDATION", `A project cannot move from ${p.status} to ${target}.`);
      }
      await tx.query(`UPDATE projects SET status = $2 WHERE id = $1`, [projectId, target]);
      // People who were counting on this project are told it is off (pausing or completing does not cancel anyone).
      if (target === "CANCELLED") await noticeProjectCancelled(tx, projectId);
      await writeAudit(tx, {
        actorUserId: userId, actorOrgId: p.org_id, action: "PROJECT_STATUS_CHANGED", subjectType: "project", subjectId: projectId,
        details: { from: p.status, to: target },
      });
    });
  } catch (err) {
    throw fromDbError(err);
  }
}

/** Reviewers: projects waiting for review. Executives see all; county administrators only their counties. */
export async function listProjectsForReview(driver: Driver, actorId: string): Promise<ProjectRow[]> {
  return runIn(driver, { kind: "system" }, async (tx) => {
    const access = await loadAccess(tx, actorId);
    if (!access.executive && access.countyIds.length === 0) throw new AppError("FORBIDDEN", "You do not review projects.");
    const rows = await tx.query<DbProject>(
      `${PROJECT_SELECT} WHERE p.status = 'PENDING_REVIEW' AND ($1::boolean OR p.county_id = ANY($2::uuid[]))
        ORDER BY p.updated_at, p.id`,
      [access.executive, access.countyIds],
    );
    const out: ProjectRow[] = [];
    for (const r of rows) out.push(toProject(r, await loadNeeds(tx, r.id)));
    return out;
  });
}

export type PublicNeed = {
  id: string;
  title: string;
  details: string | null;
  urgency: "NORMAL" | "URGENT";
  slotsNeeded: number;
  /** Real count of confirmed, attended, and unexpired-pending sign-ups. */
  slotsTaken: number;
  /** The shift's end time has passed: no spots are offered. */
  ended: boolean;
  spotsLeft: number;
  startsAt: string | null;
  endsAt: string | null;
  skills: string | null;
};

export type PublicProject = {
  id: string;
  orgId: string;
  orgName: string;
  title: string;
  description: string;
  countyName: string;
  state: string;
  zip: string;
  audience: string;
  totalSlots: number;
  /** Sum of the needs' spots left. */
  spotsLeft: number;
  hasUrgent: boolean;
  needs: PublicNeed[];
  distanceMiles: number | null;
  /** The site the project is placed at, and whether that site is on the public map. */
  siteId: string | null;
  sitePublic: boolean;
};

export const projectSearchSchema = z.object({
  q: z.string().trim().max(100).optional().default(""),
  zip: z
    .string()
    .trim()
    .regex(/^[0-9]{5}$/, "Enter a 5-digit ZIP code")
    .optional()
    .or(z.literal("").transform(() => undefined)),
  radius: z.coerce
    .number()
    .refine((v) => (RADIUS_OPTIONS_MILES as readonly number[]).includes(v), "Choose a listed radius")
    .optional()
    .default(DEFAULT_RADIUS_MILES),
  countyId: z
    .string()
    .uuid()
    .optional()
    .or(z.literal("").transform(() => undefined)),
});

const METERS_PER_MILE = 1609.344;
const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export type DbPublicProject = {
  id: string; org_id: string; org_name: string; title: string; description: string; county_name: string; state: string; zip: string;
  audience: string; total_slots: number; has_urgent: boolean; dist_m?: number | null;
  site_id?: string | null; site_public?: boolean;
};
type DbPublicNeed = {
  id: string; project_id: string; title: string; details: string | null; urgency: "NORMAL" | "URGENT"; slots_needed: number;
  slots_taken: number; starts_at: Date | null; ends_at: Date | null; skills: string | null;
};

const toPublicNeed = (n: DbPublicNeed): PublicNeed => {
  // A shift that has ended offers no spots (sign-up is refused for it), whatever its slot arithmetic says.
  const ended = n.ends_at !== null && new Date(n.ends_at).getTime() <= Date.now();
  return {
    id: n.id, title: n.title, details: n.details, urgency: n.urgency, slotsNeeded: n.slots_needed,
    slotsTaken: n.slots_taken, ended, spotsLeft: ended ? 0 : Math.max(0, n.slots_needed - n.slots_taken),
    startsAt: n.starts_at ? new Date(n.starts_at).toISOString() : null,
    endsAt: n.ends_at ? new Date(n.ends_at).toISOString() : null,
    skills: n.skills,
  };
};

export async function publicNeeds(tx: Tx, projectIds: string[]): Promise<Map<string, PublicNeed[]>> {
  const out = new Map<string, PublicNeed[]>();
  if (!projectIds.length) return out;
  const rows = await tx.query<DbPublicNeed>(
    `SELECT id, project_id, title, details, urgency, slots_needed, slots_taken, starts_at, ends_at, skills
       FROM public_project_needs WHERE project_id = ANY($1::uuid[]) ORDER BY starts_at NULLS LAST, title, id`,
    [projectIds],
  );
  for (const r of rows) out.set(r.project_id, [...(out.get(r.project_id) ?? []), toPublicNeed(r)]);
  return out;
}

export const toPublicProject = (p: DbPublicProject, needs: PublicNeed[]): PublicProject => ({
  id: p.id, orgId: p.org_id, orgName: p.org_name, title: p.title, description: p.description, countyName: p.county_name,
  state: p.state, zip: p.zip, audience: p.audience, totalSlots: p.total_slots, spotsLeft: needs.reduce((sum, n) => sum + n.spotsLeft, 0), hasUrgent: p.has_urgent, needs,
  distanceMiles: p.dist_m === null || p.dist_m === undefined ? null : Math.round((Number(p.dist_m) / METERS_PER_MILE) * 10) / 10,
  siteId: p.site_id ?? null, sitePublic: Boolean(p.site_public),
});

/**
 * Public project search (no sign-in). Reads only the public views and ics.zip_point.
 * With a ZIP, projects within the radius come nearest first (when either ZIP point is unknown, only an exact ZIP matches);
 * without one, projects with an urgent need come first, then the most recently opened.
 */
export async function searchProjects(
  driver: Driver,
  raw: unknown = {},
): Promise<{ projects: PublicProject[]; zip: string | null; radiusMiles: number }> {
  const q = parseOrThrow(projectSearchSchema, raw);
  const terms = q.q.split(/\s+/).filter(Boolean).slice(0, 6).map(likePattern);
  const zip = q.zip ?? null;
  return runIn(driver, { kind: "anon" }, async (tx) => {
    const rows = await tx.query<DbPublicProject>(
      `WITH origin AS (SELECT CASE WHEN $2::text IS NULL THEN NULL ELSE ics.zip_point($2) END AS pt),
            scored AS (
              SELECT p.*, CASE WHEN origin.pt IS NULL OR ics.zip_point(p.zip) IS NULL THEN NULL
                               ELSE ST_Distance(ics.zip_point(p.zip), origin.pt) END AS dist_m
                FROM public_projects p CROSS JOIN origin)
       SELECT s.id, s.org_id, s.org_name, s.title, s.description, s.county_name, s.state, s.zip, s.audience,
              s.total_slots, s.has_urgent, s.dist_m, s.site_id,
              EXISTS (SELECT 1 FROM public_sites ps WHERE ps.id = s.site_id) AS site_public
         FROM scored s
        WHERE NOT EXISTS (SELECT 1 FROM unnest($1::text[]) t
                           WHERE NOT (s.title ILIKE t OR s.description ILIKE t
                                      OR EXISTS (SELECT 1 FROM public_project_needs n
                                                  WHERE n.project_id = s.id AND (n.title ILIKE t OR coalesce(n.skills, '') ILIKE t))))
          AND ($3::uuid IS NULL OR s.county_id = $3)
          AND ($2::text IS NULL OR (s.dist_m IS NOT NULL AND s.dist_m <= $4) OR (s.dist_m IS NULL AND s.zip = $2))
        ORDER BY s.dist_m NULLS LAST, s.has_urgent DESC, s.opened_at DESC, s.title
        LIMIT 100`,
      [terms, zip, q.countyId ?? null, q.radius * METERS_PER_MILE],
    );
    const needs = await publicNeeds(tx, rows.map((r) => r.id));
    return { zip, radiusMiles: q.radius, projects: rows.map((r) => toPublicProject(r, needs.get(r.id) ?? [])) };
  });
}

/** Public: one OPEN project of an approved organization, or null. */
export async function getPublicProject(driver: Driver, id: string): Promise<PublicProject | null> {
  if (!z.string().uuid().safeParse(id).success) return null;
  return runIn(driver, { kind: "anon" }, async (tx) => {
    const rows = await tx.query<DbPublicProject>(
      `SELECT p.id, p.org_id, p.org_name, p.title, p.description, p.county_name, p.state, p.zip, p.audience, p.total_slots,
              p.has_urgent, p.site_id, EXISTS (SELECT 1 FROM public_sites ps WHERE ps.id = p.site_id) AS site_public
         FROM public_projects p WHERE p.id = $1`,
      [id],
    );
    if (!rows.length) return null;
    return toPublicProject(rows[0], (await publicNeeds(tx, [id])).get(id) ?? []);
  });
}
