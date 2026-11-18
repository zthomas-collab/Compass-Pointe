import { z } from "zod";
import type { Driver, Tx } from "../db";
import { runIn } from "../db/context";
import { AppError, fromDbError } from "../errors";
import type { EventStatus } from "./events";
import { publicNeeds, toPublicProject, type DbPublicProject, type PublicProject } from "./projects";
import { canManageCounty, loadAccess } from "./access";
import { membershipRole } from "./directory";
import { parseOrThrow } from "./identity";
import { inEventAreaSql } from "./sql";
import { writeAudit } from "./shared";

/** In what capacity someone decides about a link: as the owning organization, or as an administrator of the county. */
export type DecisionRole = "ORG" | "ADMIN";

const uuid = (v: unknown) => parseOrThrow(z.string().uuid(), v);

/** Is the project inside the event's area right now? (The rule is inEventAreaSql in ./sql.) False for an unknown project. */
export async function projectInEventArea(tx: Tx, projectId: string, eventId: string): Promise<boolean> {
  const r = await tx.query<{ ok: boolean }>(
    `SELECT ${inEventAreaSql("$2::uuid", "p.zip", "p.county_id")} AS ok FROM projects p WHERE p.id = $1`,
    [projectId, eventId],
  );
  return r[0]?.ok ?? false;
}

/**
 * The capacity in which this user may decide about the project's links, re-derived inside the transaction:
 * an admin or editor of the owning (approved, non-suspended) organization acts as ORG, which also covers someone who
 * is both an editor and a county administrator; otherwise an administrator of the project's county or an executive
 * acts as ADMIN; everyone else (viewers, other organizations, other counties, the public) cannot decide.
 */
export async function decisionRole(tx: Tx, userId: string, project: { org_id: string; county_id: string; org_ok: boolean }): Promise<DecisionRole | null> {
  const role = await membershipRole(tx, project.org_id, userId);
  // A member of the owning org decides as the organization or not at all: being a county administrator as well does not
  // let them override their own organization's project (the same rule as reviewing a project).
  if (role) return (role === "ORG_ADMIN" || role === "EDITOR") && project.org_ok ? "ORG" : null;
  const access = await loadAccess(tx, userId);
  return canManageCounty(access, project.county_id) ? "ADMIN" : null;
}

type LockedProject = { id: string; org_id: string; county_id: string; status: string; org_ok: boolean };

async function lockProject(tx: Tx, projectId: string): Promise<LockedProject> {
  const rows = await tx.query<LockedProject>(
    `SELECT p.id, p.org_id, p.county_id, p.status, (o.status = 'APPROVED' AND NOT o.publication_suspended) AS org_ok
       FROM projects p JOIN organizations o ON o.id = p.org_id WHERE p.id = $1 FOR UPDATE OF p`,
    [projectId],
  );
  if (!rows.length) throw new AppError("NOT_FOUND", "Project not found.");
  return rows[0];
}

/**
 * Attach a project to an event whose area contains it. Idempotent when already attached. The organization's editors
 * and the county's administrators may do it; an administrator's earlier removal cannot be undone by the organization.
 */
export async function linkProjectToEvent(driver: Driver, userId: string, projectId: string, eventId: string): Promise<void> {
  const pid = uuid(projectId);
  const eid = uuid(eventId);
  try {
    await runIn(driver, { kind: "system" }, async (tx) => {
      const p = await lockProject(tx, pid);
      // FOR SHARE: an event cannot be closed between this check and the insert, which would leave a link to a closed event.
      const ev = await tx.query<{ status: string }>(`SELECT status FROM events WHERE id = $1 FOR SHARE`, [eid]);
      if (!ev.length) throw new AppError("NOT_FOUND", "Event not found.");
      const role = await decisionRole(tx, userId, p);
      if (!role) throw new AppError("FORBIDDEN", "You cannot change this project's events.");
      const existing = await tx.query<{ state: string; decided_by_role: string | null }>(
        `SELECT state, decided_by_role FROM project_event_links WHERE project_id = $1 AND event_id = $2 FOR UPDATE`,
        [pid, eid],
      );
      if (existing[0]?.state === "CONFIRMED") return;
      if (existing[0]?.state === "DISMISSED" && existing[0].decided_by_role === "ADMIN" && role !== "ADMIN") {
        throw new AppError("FORBIDDEN", "A county administrator removed this project from the event. Ask them to restore it.");
      }
      if (ev[0].status !== "ACTIVE" && ev[0].status !== "RECOVERY") throw new AppError("VALIDATION", "Projects can only be attached to an event that is active or in recovery.");
      if (p.status === "COMPLETED" || p.status === "CANCELLED") throw new AppError("VALIDATION", "A finished project cannot be attached to an event.");
      if (!(await projectInEventArea(tx, pid, eid))) throw new AppError("VALIDATION", "This project is not inside the event's area.");
      await tx.query(
        `INSERT INTO project_event_links (project_id, event_id, state, decided_by, decided_by_role, decided_at)
         VALUES ($1, $2, 'CONFIRMED', $3, $4, now())
         ON CONFLICT (project_id, event_id)
         DO UPDATE SET state = 'CONFIRMED', decided_by = EXCLUDED.decided_by, decided_by_role = EXCLUDED.decided_by_role, decided_at = now()`,
        [pid, eid, userId, role],
      );
      await writeAudit(tx, {
        actorUserId: userId, action: "EVENT_PROJECT_LINKED", subjectType: "project", subjectId: pid, details: { eventId: eid, role },
      });
    });
  } catch (err) {
    throw fromDbError(err);
  }
}

/** Take a project off an event (the link becomes DISMISSED). Idempotent; NOT_FOUND when it was never attached. */
export async function unlinkProjectFromEvent(driver: Driver, userId: string, projectId: string, eventId: string): Promise<void> {
  const pid = uuid(projectId);
  const eid = uuid(eventId);
  try {
    await runIn(driver, { kind: "system" }, async (tx) => {
      const p = await lockProject(tx, pid);
      const role = await decisionRole(tx, userId, p);
      if (!role) throw new AppError("FORBIDDEN", "You cannot change this project's events.");
      const existing = await tx.query<{ state: string }>(
        `SELECT state FROM project_event_links WHERE project_id = $1 AND event_id = $2 FOR UPDATE`,
        [pid, eid],
      );
      if (!existing.length || existing[0].state === "SUGGESTED") throw new AppError("NOT_FOUND", "This project is not attached to that event.");
      if (existing[0].state === "DISMISSED") return;
      await tx.query(
        `UPDATE project_event_links SET state = 'DISMISSED', decided_by = $3, decided_by_role = $4, decided_at = now() WHERE project_id = $1 AND event_id = $2`,
        [pid, eid, userId, role],
      );
      await writeAudit(tx, {
        actorUserId: userId, action: "EVENT_PROJECT_UNLINKED", subjectType: "project", subjectId: pid, details: { eventId: eid, role },
      });
    });
  } catch (err) {
    throw fromDbError(err);
  }
}

export type ProjectEventLink = {
  eventId: string;
  eventName: string;
  eventSlug: string;
  eventStatus: EventStatus;
  state: "CONFIRMED" | "DISMISSED";
  /** For a dismissed link: who removed it (so a page never blames the wrong person). Null while confirmed. */
  dismissedBy: DecisionRole | null;
  /** Is the project inside the event's area right now? (Editing a project or an event can move it out.) */
  inArea: boolean;
  /** The reader may take a confirmed link off. */
  canUnlink: boolean;
  /** The reader may put a dismissed link back, and doing so would succeed right now (area, event and project status included). */
  canRelink: boolean;
};

type ReadableProject = { org_id: string; county_id: string; status: string; org_ok: boolean };

/** Same audience as getProjectForEditor: members of the owning org, administrators of the project's county, executives. */
async function readableProject(tx: Tx, userId: string, projectId: string): Promise<ReadableProject | null> {
  const rows = await tx.query<ReadableProject>(
    `SELECT p.org_id, p.county_id, p.status, (o.status = 'APPROVED' AND NOT o.publication_suspended) AS org_ok
       FROM projects p JOIN organizations o ON o.id = p.org_id WHERE p.id = $1`,
    [projectId],
  );
  if (!rows.length) return null;
  const member = await membershipRole(tx, rows[0].org_id, userId);
  const access = await loadAccess(tx, userId);
  return member || canManageCounty(access, rows[0].county_id) ? rows[0] : null;
}

const finished = (status: string) => status === "COMPLETED" || status === "CANCELLED";

/** The project's attached and removed events, for the people who may see the project; [] for anyone else. */
export async function listProjectEventLinks(driver: Driver, userId: string, projectId: string): Promise<ProjectEventLink[]> {
  if (!z.string().uuid().safeParse(projectId).success) return [];
  return runIn(driver, { kind: "system" }, async (tx) => {
    const p = await readableProject(tx, userId, projectId);
    if (!p) return [];
    const role = await decisionRole(tx, userId, p);
    const rows = await tx.query<{
      event_id: string; name: string; slug: string; status: EventStatus; state: "CONFIRMED" | "DISMISSED"; decided_by_role: string | null;
      in_area: boolean;
    }>(
      `SELECT l.event_id, e.name, e.slug, e.status, l.state, l.decided_by_role,
              ${inEventAreaSql("l.event_id", "p.zip", "p.county_id")} AS in_area
         FROM project_event_links l JOIN events e ON e.id = l.event_id JOIN projects p ON p.id = l.project_id
        WHERE l.project_id = $1 AND l.state IN ('CONFIRMED','DISMISSED')
        ORDER BY e.starts_on DESC, e.name, e.id`,
      [projectId],
    );
    const out: ProjectEventLink[] = [];
    for (const r of rows) {
      const open = r.status === "ACTIVE" || r.status === "RECOVERY";
      const inArea = r.in_area;
      out.push({
        eventId: r.event_id, eventName: r.name, eventSlug: r.slug, eventStatus: r.status, state: r.state,
        dismissedBy: r.state === "DISMISSED" ? (r.decided_by_role as DecisionRole | null) : null,
        inArea,
        canUnlink: r.state === "CONFIRMED" && role !== null,
        canRelink: r.state === "DISMISSED" && role !== null && open && inArea && !finished(p.status) && (r.decided_by_role !== "ADMIN" || role === "ADMIN"),
      });
    }
    return out;
  });
}

export type LinkableEvent = { id: string; name: string; slug: string; status: EventStatus };

/** Events this reader could attach the project to right now; [] for anyone who may not decide or for a finished project. */
export async function listLinkableEvents(driver: Driver, userId: string, projectId: string): Promise<LinkableEvent[]> {
  if (!z.string().uuid().safeParse(projectId).success) return [];
  return runIn(driver, { kind: "system" }, async (tx) => {
    const p = await readableProject(tx, userId, projectId);
    if (!p || finished(p.status)) return [];
    const role = await decisionRole(tx, userId, p);
    if (!role) return [];
    return tx.query<LinkableEvent>(
      `SELECT e.id, e.name, e.slug, e.status
         FROM events e JOIN projects p ON p.id = $1
        WHERE e.status IN ('ACTIVE','RECOVERY')
          AND ${inEventAreaSql("e.id", "p.zip", "p.county_id")}
          AND NOT EXISTS (SELECT 1 FROM project_event_links l
                           WHERE l.project_id = p.id AND l.event_id = e.id
                             AND (l.state = 'CONFIRMED' OR (l.state = 'DISMISSED' AND l.decided_by_role = 'ADMIN' AND $2 = 'ORG')))
        ORDER BY e.starts_on DESC, e.name, e.id`,
      [projectId, role],
    );
  });
}

/**
 * Public: the volunteer projects attached to an event, for an event that is open (ACTIVE or RECOVERY); [] for an
 * unknown, draft or closed event. Reads only the public views, which re-check every condition now. Projects with an
 * urgent need come first, then the one whose next shift is soonest, then by title.
 */
export async function listEventProjects(driver: Driver, eventId: string): Promise<PublicProject[]> {
  if (!z.string().uuid().safeParse(eventId).success) return [];
  return runIn(driver, { kind: "anon" }, async (tx) => {
    const open = await tx.query(`SELECT 1 FROM public_events WHERE id = $1 AND status IN ('ACTIVE','RECOVERY')`, [eventId]);
    if (!open.length) return [];
    const rows = await tx.query<DbPublicProject>(
      `SELECT p.id, p.org_id, p.org_name, p.title, p.description, p.county_name, p.state, p.zip, p.audience, p.total_slots, p.has_urgent
         FROM public_event_links l JOIN public_projects p ON p.id = l.project_id
        WHERE l.event_id = $1
        ORDER BY p.has_urgent DESC,
                 (SELECT min(n.starts_at) FROM public_project_needs n
                   WHERE n.project_id = p.id AND (n.ends_at IS NULL OR n.ends_at > now())) NULLS LAST,
                 p.title, p.id`,
      [eventId],
    );
    const needs = await publicNeeds(tx, rows.map((r) => r.id));
    return rows.map((r) => toPublicProject(r, needs.get(r.id) ?? []));
  });
}

/** Public: the non-draft events a publicly visible project is attached to (closed ones included); [] otherwise. */
export async function listPublicProjectEvents(
  driver: Driver,
  projectId: string,
): Promise<{ id: string; name: string; slug: string; status: EventStatus }[]> {
  if (!z.string().uuid().safeParse(projectId).success) return [];
  return runIn(driver, { kind: "anon" }, (tx) =>
    tx.query<{ id: string; name: string; slug: string; status: EventStatus }>(
      `SELECT e.id, e.name, e.slug, e.status
         FROM public_event_links l JOIN public_events e ON e.id = l.event_id
        WHERE l.project_id = $1
        ORDER BY e.starts_on DESC, e.name, e.id`,
      [projectId],
    ),
  );
}

export type EventSuggestion = {
  projectId: string; projectTitle: string; orgName: string; eventId: string; eventName: string; eventSlug: string;
};

/**
 * Suggested (project, event) pairs this user may decide on, for one project or one event. Only pairs that could still
 * be confirmed right now are listed: the event is ACTIVE or RECOVERY, the project is not finished, and it is still
 * inside the event's area. Never public.
 */
export async function listSuggestions(
  driver: Driver, userId: string, scope: { projectId: string } | { eventId: string },
): Promise<EventSuggestion[]> {
  const byProject = "projectId" in scope;
  const id = byProject ? scope.projectId : scope.eventId;
  if (!z.string().uuid().safeParse(id).success) return [];
  return runIn(driver, { kind: "system" }, async (tx) => {
    const rows = await tx.query<{
      project_id: string; title: string; org_id: string; org_name: string; county_id: string; org_ok: boolean;
      event_id: string; event_name: string; event_slug: string;
    }>(
      `SELECT p.id AS project_id, p.title, p.org_id, o.display_name AS org_name, p.county_id,
              (o.status = 'APPROVED' AND NOT o.publication_suspended) AS org_ok,
              e.id AS event_id, e.name AS event_name, e.slug AS event_slug
         FROM project_event_links l
         JOIN projects p ON p.id = l.project_id
         JOIN organizations o ON o.id = p.org_id
         JOIN events e ON e.id = l.event_id
        WHERE l.state = 'SUGGESTED' AND ${byProject ? "l.project_id" : "l.event_id"} = $1
          AND e.status IN ('ACTIVE','RECOVERY') AND p.status NOT IN ('COMPLETED','CANCELLED')
          AND ${inEventAreaSql("e.id", "p.zip", "p.county_id")}
        ORDER BY e.starts_on DESC, e.name, p.title, p.id
        LIMIT 200`,
      [id],
    );
    // The decision role depends only on the project's org and county: look it up once per pair, not once per row.
    const roles = new Map<string, DecisionRole | null>();
    const out: EventSuggestion[] = [];
    for (const r of rows) {
      const key = `${r.org_id}|${r.county_id}|${r.org_ok}`;
      if (!roles.has(key)) roles.set(key, await decisionRole(tx, userId, r));
      if (!roles.get(key)) continue;
      out.push({
        projectId: r.project_id, projectTitle: r.title, orgName: r.org_name, eventId: r.event_id, eventName: r.event_name, eventSlug: r.event_slug,
      });
    }
    return out;
  });
}

/** Decline a suggestion (it becomes DISMISSED, recording who decided and in what capacity). NOT_FOUND when it is not one. */
export async function dismissSuggestion(driver: Driver, userId: string, projectId: string, eventId: string): Promise<void> {
  const pid = uuid(projectId);
  const eid = uuid(eventId);
  try {
    await runIn(driver, { kind: "system" }, async (tx) => {
      const p = await lockProject(tx, pid);
      const role = await decisionRole(tx, userId, p);
      if (!role) throw new AppError("FORBIDDEN", "You cannot change this project's events.");
      const existing = await tx.query<{ state: string }>(
        `SELECT state FROM project_event_links WHERE project_id = $1 AND event_id = $2 FOR UPDATE`, [pid, eid]);
      if (existing[0]?.state !== "SUGGESTED") throw new AppError("NOT_FOUND", "There is no suggestion for this project and event.");
      await tx.query(
        `UPDATE project_event_links SET state = 'DISMISSED', decided_by = $3, decided_by_role = $4, decided_at = now()
          WHERE project_id = $1 AND event_id = $2`,
        [pid, eid, userId, role],
      );
      await writeAudit(tx, {
        actorUserId: userId, action: "EVENT_SUGGESTION_DISMISSED", subjectType: "project", subjectId: pid, details: { eventId: eid, role },
      });
    });
  } catch (err) {
    throw fromDbError(err);
  }
}
