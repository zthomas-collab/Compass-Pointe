import { z } from "zod";
import { PROJECT_AUDIENCES, type ProjectStatus } from "@/lib/projects";
import type { Driver, Tx } from "../db";
import { runIn } from "../db/context";
import { AppError, fromDbError } from "../errors";
import { canManageCounty, loadAccess } from "./access";
import { membershipRole } from "./directory";
import { parseOrThrow } from "./identity";
import { writeAudit } from "./shared";

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
  audience: string;
  status: ProjectStatus;
  privateLocationNotes: string | null;
  reviewNote: string | null;
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
  countyId: z.string().uuid(),
  zip: z.string().trim().regex(/^[0-9]{5}$/, "Enter a 5-digit ZIP code"),
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

/** The organization must serve the county, and the ZIP must be a real ZIP inside it. */
async function assertProjectArea(tx: Tx, orgId: string, countyId: string, zip: string): Promise<void> {
  const county = await tx.query<{ fips: string | null; served: boolean }>(
    `SELECT c.fips, EXISTS (SELECT 1 FROM organization_counties oc WHERE oc.org_id = $1 AND oc.county_id = c.id) AS served
       FROM counties c WHERE c.id = $2 AND c.active`,
    [orgId, countyId],
  );
  const fail = (field: string, msg: string) => new AppError("VALIDATION", "Please correct the highlighted fields.", { [field]: [msg] });
  if (!county.length) throw fail("countyId", "Choose a county");
  if (!county[0].served) throw fail("countyId", "Your organization's profile does not list this county as served");
  const known = await tx.query(`SELECT 1 FROM zip_county WHERE zip = $1 LIMIT 1`, [zip]);
  if (!known.length) throw fail("zip", "Unknown ZIP code");
  if (county[0].fips) {
    const inside = await tx.query(`SELECT 1 FROM zip_county WHERE zip = $1 AND county_fips = $2`, [zip, county[0].fips]);
    if (!inside.length) throw fail("zip", "That ZIP code is not in the chosen county");
  }
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
      await assertProjectArea(tx, org, input.countyId, input.zip);
      const rows = await tx.query<{ id: string }>(
        `INSERT INTO projects (org_id, title, description, county_id, zip, audience, private_location_notes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [org, input.title, input.description, input.countyId, input.zip, input.audience, input.privateLocationNotes ?? null, userId],
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
      await assertProjectArea(tx, p.org_id, input.countyId, input.zip);
      await tx.query(
        `UPDATE projects SET title = $2, description = $3, county_id = $4, zip = $5, audience = $6, private_location_notes = $7,
                ${REVIEW_RESET}
          WHERE id = $1`,
        [projectId, input.title, input.description, input.countyId, input.zip, input.audience, input.privateLocationNotes ?? null],
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
  state: string; zip: string; audience: string; status: ProjectStatus; private_location_notes: string | null; review_note: string | null;
};
type DbNeed = {
  id: string; title: string; details: string | null; urgency: "NORMAL" | "URGENT"; slots_needed: number;
  starts_at: Date | null; ends_at: Date | null; skills: string | null; instructions: string | null;
};

export const PROJECT_SELECT = `
  SELECT p.id, p.org_id, o.display_name AS org_name, p.title, p.description, p.county_id, c.name AS county_name, c.state,
         p.zip, p.audience, p.status, p.private_location_notes, p.review_note
    FROM projects p JOIN organizations o ON o.id = p.org_id JOIN counties c ON c.id = p.county_id`;

const toNeed = (n: DbNeed): NeedRow => ({
  id: n.id, title: n.title, details: n.details, urgency: n.urgency, slotsNeeded: n.slots_needed,
  startsAt: n.starts_at ? new Date(n.starts_at).toISOString() : null,
  endsAt: n.ends_at ? new Date(n.ends_at).toISOString() : null,
  skills: n.skills, instructions: n.instructions,
});

const toProject = (p: DbProject, needs: NeedRow[]): ProjectRow => ({
  id: p.id, orgId: p.org_id, orgName: p.org_name, title: p.title, description: p.description, countyId: p.county_id,
  countyName: p.county_name, state: p.state, zip: p.zip, audience: p.audience, status: p.status,
  privateLocationNotes: p.private_location_notes, reviewNote: p.review_note, needs,
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
    return toProject(rows[0], await loadNeeds(tx, id));
  });
}

/** Org members: every project the organization has posted (needs are not loaded in this list). */
export async function listOrgProjects(driver: Driver, userId: string, orgId: string): Promise<ProjectRow[]> {
  const org = uuid(orgId);
  return runIn(driver, { kind: "system" }, async (tx) => {
    if (!(await membershipRole(tx, org, userId))) throw new AppError("FORBIDDEN", "You are not a member of this organization.");
    const rows = await tx.query<DbProject>(`${PROJECT_SELECT} WHERE p.org_id = $1 ORDER BY p.created_at DESC, p.id`, [org]);
    return rows.map((r) => toProject(r, []));
  });
}
