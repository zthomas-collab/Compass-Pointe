import { z } from "zod";
import type { Driver, Tx } from "../db";
import { runIn } from "../db/context";
import { AppError, fromDbError } from "../errors";
import { canManageCounty, loadAccess } from "./access";
import { membershipRole } from "./directory";
import { parseOrThrow } from "./identity";
import { writeAudit } from "./shared";

/** In what capacity someone decides about a link: as the owning organization, or as an administrator of the county. */
export type DecisionRole = "ORG" | "ADMIN";

const uuid = (v: unknown) => parseOrThrow(z.string().uuid(), v);

/**
 * Is the project inside the event's area right now? When the event names ZIP codes, the project's ZIP must be one of
 * them; otherwise the project's county must be one of the event's counties. (The same rule the event's Help list and
 * the public_event_links view use.)
 */
export async function projectInEventArea(tx: Tx, projectId: string, eventId: string): Promise<boolean> {
  const r = await tx.query<{ ok: boolean }>(
    `SELECT CASE WHEN EXISTS (SELECT 1 FROM event_zips WHERE event_id = $2)
                 THEN EXISTS (SELECT 1 FROM event_zips z JOIN projects p ON p.id = $1 WHERE z.event_id = $2 AND z.zip = p.zip)
                 ELSE EXISTS (SELECT 1 FROM event_counties ec JOIN projects p ON p.id = $1 WHERE ec.event_id = $2 AND ec.county_id = p.county_id)
            END AS ok`,
    [projectId, eventId],
  );
  return r[0].ok;
}

/**
 * The capacity in which this user may decide about the project's links, re-derived inside the transaction:
 * an admin or editor of the owning (approved, non-suspended) organization acts as ORG, which also covers someone who
 * is both an editor and a county administrator; otherwise an administrator of the project's county or an executive
 * acts as ADMIN; everyone else (viewers, other organizations, other counties, the public) cannot decide.
 */
export async function decisionRole(tx: Tx, userId: string, project: { org_id: string; county_id: string; org_ok: boolean }): Promise<DecisionRole | null> {
  const role = await membershipRole(tx, project.org_id, userId);
  if ((role === "ORG_ADMIN" || role === "EDITOR") && project.org_ok) return "ORG";
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
      const ev = await tx.query<{ status: string }>(`SELECT status FROM events WHERE id = $1`, [eid]);
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
