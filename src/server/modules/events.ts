import { z } from "zod";
import type { Driver, Tx } from "../db";
import { runIn } from "../db/context";
import { AppError, fromDbError } from "../errors";
import { loadAccess } from "./access";
import { parseOrThrow } from "./identity";
import { privilegedMfaRequired } from "./organizations";
import { parseZipList } from "./projects";
import { writeAudit } from "./shared";
import { zipMatchesCounty } from "./zipcounty";

/**
 * Disaster-response events and logistics. Private by default; creating an event never exposes staging sites or
 * operations. The public sees only a coordinator-written summary, ZIP codes, dates and status.
 */
export const EVENT_CATEGORIES = ["HURRICANE", "FLOOD", "WINTER_STORM", "TORNADO", "WILDFIRE", "LANDSLIDE", "EXTREME_HEAT", "OTHER"] as const;
export type EventCategory = (typeof EVENT_CATEGORIES)[number];
export const EVENT_CATEGORY_LABELS: Record<EventCategory, string> = {
  HURRICANE: "Hurricane / tropical storm", FLOOD: "Flood", WINTER_STORM: "Winter storm", TORNADO: "Tornado / severe storm",
  WILDFIRE: "Wildfire", LANDSLIDE: "Landslide", EXTREME_HEAT: "Extreme heat", OTHER: "Other event",
};
export const EVENT_STATUSES = ["SCHEDULED", "ACTIVE", "COMPLETED", "CANCELED"] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];
export const EVENT_STATUS_LABELS: Record<EventStatus, string> = { SCHEDULED: "Scheduled", ACTIVE: "Active", COMPLETED: "Completed", CANCELED: "Canceled" };
const EVENT_MOVES: [EventStatus, EventStatus][] = [["SCHEDULED", "ACTIVE"], ["SCHEDULED", "CANCELED"], ["ACTIVE", "COMPLETED"], ["ACTIVE", "CANCELED"]];
export const nextEventStatuses = (from: EventStatus): EventStatus[] => EVENT_MOVES.filter(([f]) => f === from).map(([, t]) => t);

export const TASK_STATUSES = ["TODO", "IN_PROGRESS", "BLOCKED", "DONE"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TASK_STATUS_LABELS: Record<TaskStatus, string> = { TODO: "To do", IN_PROGRESS: "In progress", BLOCKED: "Blocked", DONE: "Done" };
export const TASK_PRIORITIES = ["LOW", "NORMAL", "HIGH", "CRITICAL"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export const REQUIREMENT_KINDS = ["SUPPLY", "EQUIPMENT", "VOLUNTEER"] as const;
export type RequirementKind = (typeof REQUIREMENT_KINDS)[number];
export const REQUIREMENT_LABELS: Record<RequirementKind, string> = { SUPPLY: "Supply", EQUIPMENT: "Equipment", VOLUNTEER: "Volunteers" };

const uuid = z.string().uuid();
const dateText = z.string().trim().optional().transform((v) => (v ? v : null)).refine((v) => v === null || /^\d{4}-\d{2}-\d{2}$/.test(v), "Use a valid date");
const requiredDate = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date");

type Who = { executive: boolean; countyIds: string[]; orgIds: string[] };
async function whoIs(tx: Tx, userId: string): Promise<Who> {
  const a = await loadAccess(tx, userId);
  return { executive: a.executive, countyIds: a.countyIds, orgIds: a.orgIds };
}
const manages = (w: Who, countyId: string) => w.executive || w.countyIds.includes(countyId);
async function requireMfaIfStaff(tx: Tx, userId: string, w: Who): Promise<void> {
  if (!(w.executive || w.countyIds.length) || !privilegedMfaRequired()) return;
  const r = await tx.query<{ mfa: boolean }>(`SELECT mfa_enrolled_at IS NOT NULL AS mfa FROM users WHERE id = $1`, [userId]);
  if (!r[0]?.mfa) throw new AppError("FORBIDDEN", "Multi-factor authentication is required.");
}
async function managedEvent(tx: Tx, userId: string, eventId: string): Promise<{ county_id: string; status: EventStatus }> {
  const who = await whoIs(tx, userId);
  const e = await tx.query<{ county_id: string; status: EventStatus }>(`SELECT county_id, status FROM events WHERE id = $1 FOR UPDATE`, [eventId]);
  if (!e.length || !manages(who, e[0].county_id)) throw new AppError("NOT_FOUND", "Event not found.");
  await requireMfaIfStaff(tx, userId, who);
  return e[0];
}

// --------------------------- create / edit ---------------------------
export const eventSchema = z.object({
  name: z.string().trim().min(3, "Name the event").max(140),
  description: z.string().trim().min(5, "Describe the event").max(4000),
  category: z.enum(EVENT_CATEGORIES),
  countyId: uuid,
  zips: z.string().trim().min(5, "Enter at least one ZIP code"),
  startDate: requiredDate,
  endDate: dateText,
});

export async function createEvent(driver: Driver, userId: string, raw: unknown): Promise<{ id: string; reference: string }> {
  const input = parseOrThrow(eventSchema, raw);
  const zips = parseZipList(input.zips);
  if (zips.length === 0 || zips.length > 40 || zips.some((z) => !/^\d{5}$/.test(z))) {
    throw new AppError("VALIDATION", "Enter 5-digit ZIP codes separated by commas.", { zips: ["Use 5-digit ZIP codes, up to 40"] });
  }
  if (input.endDate && input.endDate < input.startDate) throw new AppError("VALIDATION", "The end date is before the start date.", { endDate: ["Must be on or after the start"] });
  try {
    return await runIn(driver, { kind: "system" }, async (tx) => {
      const who = await whoIs(tx, userId);
      if (!manages(who, input.countyId)) throw new AppError("FORBIDDEN", "You can only create events in counties you administer.");
      await requireMfaIfStaff(tx, userId, who);
      if (!(await tx.query(`SELECT 1 FROM counties WHERE id = $1 AND active`, [input.countyId])).length) throw new AppError("VALIDATION", "Choose a county.", { countyId: ["Unknown county"] });
      for (const z of zips) {
        if (!(await zipMatchesCounty(tx, z, input.countyId))) throw new AppError("VALIDATION", `ZIP code ${z} is not in the county you chose.`, { zips: [`${z} is not in this county`] });
      }
      const r = await tx.query<{ id: string; reference: string }>(
        `INSERT INTO events (name, description, category, county_id, start_date, end_date, lead_coordinator_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$7) RETURNING id, reference`,
        [input.name, input.description, input.category, input.countyId, input.startDate, input.endDate, userId]);
      await tx.query(`INSERT INTO event_zips (event_id, zip) SELECT $1, unnest($2::text[])`, [r[0].id, zips]);
      await writeAudit(tx, { actorUserId: userId, action: "EVENT_CREATED", subjectType: "event", subjectId: r[0].id });
      return r[0];
    });
  } catch (err) {
    throw fromDbError(err);
  }
}

export const eventEditSchema = z.object({
  eventId: uuid,
  name: z.string().trim().min(3).max(140),
  description: z.string().trim().min(5).max(4000),
  startDate: requiredDate,
  endDate: dateText,
  internalNotes: z.string().trim().max(4000).optional().transform((v) => (v ? v : null)),
});
export async function updateEvent(driver: Driver, userId: string, raw: unknown): Promise<void> {
  const i = parseOrThrow(eventEditSchema, raw);
  if (i.endDate && i.endDate < i.startDate) throw new AppError("VALIDATION", "The end date is before the start date.", { endDate: ["Must be on or after the start"] });
  try {
    await runIn(driver, { kind: "system" }, async (tx) => {
      const e = await managedEvent(tx, userId, i.eventId);
      if (e.status === "COMPLETED" || e.status === "CANCELED") throw new AppError("CONFLICT", "This event is closed.");
      await tx.query(`UPDATE events SET name=$2, description=$3, start_date=$4, end_date=$5, internal_notes=$6 WHERE id=$1`, [i.eventId, i.name, i.description, i.startDate, i.endDate, i.internalNotes]);
      await writeAudit(tx, { actorUserId: userId, action: "EVENT_EDITED", subjectType: "event", subjectId: i.eventId });
    });
  } catch (err) {
    throw fromDbError(err);
  }
}

export async function setEventStatus(driver: Driver, userId: string, eventId: unknown, to: unknown): Promise<void> {
  const id = parseOrThrow(uuid, eventId);
  const next = parseOrThrow(z.enum(EVENT_STATUSES), to);
  try {
    await runIn(driver, { kind: "system" }, async (tx) => {
      const e = await managedEvent(tx, userId, id);
      if (!EVENT_MOVES.some(([f, t]) => f === e.status && t === next)) throw new AppError("CONFLICT", "That status change is not allowed from the current state.");
      await tx.query(`UPDATE events SET status = $2 WHERE id = $1`, [id, next]);
      await writeAudit(tx, { actorUserId: userId, action: `EVENT_${next}`, subjectType: "event", subjectId: id, details: { from: e.status } });
    });
  } catch (err) {
    throw fromDbError(err);
  }
}

export const eventPublishSchema = z.object({
  eventId: uuid,
  visibility: z.enum(["PRIVATE", "PUBLIC"]),
  publicSummary: z.string().trim().max(600).optional().transform((v) => (v ? v : null)),
});
export async function setEventVisibility(driver: Driver, userId: string, raw: unknown): Promise<void> {
  const i = parseOrThrow(eventPublishSchema, raw);
  if (i.visibility === "PUBLIC" && (!i.publicSummary || i.publicSummary.length < 10)) {
    throw new AppError("VALIDATION", "Write a short public summary (at least 10 characters). Do not include staging locations, names or addresses.", { publicSummary: ["Required to publish"] });
  }
  try {
    await runIn(driver, { kind: "system" }, async (tx) => {
      await managedEvent(tx, userId, i.eventId);
      await tx.query(`UPDATE events SET visibility = $2, public_summary = coalesce($3, public_summary) WHERE id = $1`, [i.eventId, i.visibility, i.publicSummary]);
      await writeAudit(tx, { actorUserId: userId, action: `EVENT_${i.visibility === "PUBLIC" ? "PUBLISHED" : "UNPUBLISHED"}`, subjectType: "event", subjectId: i.eventId });
    });
  } catch (err) {
    throw fromDbError(err);
  }
}

export async function addEventOrganization(driver: Driver, userId: string, eventId: unknown, orgId: unknown): Promise<void> {
  const eid = parseOrThrow(uuid, eventId);
  const oid = parseOrThrow(uuid, orgId);
  try {
    await runIn(driver, { kind: "system" }, async (tx) => {
      await managedEvent(tx, userId, eid);
      if (!(await tx.query(`SELECT 1 FROM organizations WHERE id = $1 AND status = 'APPROVED' AND NOT publication_suspended`, [oid])).length) {
        throw new AppError("VALIDATION", "That organization is not an approved provider.", { orgId: ["Not available"] });
      }
      await tx.query(`INSERT INTO event_organizations (event_id, org_id, added_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [eid, oid, userId]);
      await writeAudit(tx, { actorUserId: userId, action: "EVENT_PARTICIPANT_ADDED", subjectType: "event", subjectId: eid, details: { orgId: oid } });
    });
  } catch (err) {
    throw fromDbError(err);
  }
}

export const taskSchema = z.object({
  eventId: uuid,
  title: z.string().trim().min(3, "Name the task").max(140),
  description: z.string().trim().max(2000).optional().transform((v) => (v ? v : null)),
  priority: z.enum(TASK_PRIORITIES).default("NORMAL"),
  dueDate: dateText,
  assigneeOrgId: uuid.optional().or(z.literal("").transform(() => undefined)),
  assigneeEmail: z.string().trim().toLowerCase().max(254).optional().transform((v) => (v ? v : null)),
});
export async function addTask(driver: Driver, userId: string, raw: unknown): Promise<string> {
  const i = parseOrThrow(taskSchema, raw);
  try {
    return await runIn(driver, { kind: "system" }, async (tx) => {
      const e = await managedEvent(tx, userId, i.eventId);
      if (e.status === "COMPLETED" || e.status === "CANCELED") throw new AppError("CONFLICT", "This event is closed.");
      let assigneeUser: string | null = null;
      if (i.assigneeEmail) {
        const u = await tx.query<{ id: string }>(`SELECT id FROM users WHERE email = $1 AND status = 'ACTIVE'`, [i.assigneeEmail]);
        if (!u.length) throw new AppError("VALIDATION", "No active account has that email address.", { assigneeEmail: ["Unknown account"] });
        const w = await whoIs(tx, u[0].id);
        const member = w.orgIds.length
          ? (await tx.query(`SELECT 1 FROM event_organizations WHERE event_id = $1 AND org_id = ANY($2::uuid[])`, [i.eventId, w.orgIds])).length > 0
          : false;
        if (!(manages(w, e.county_id) || member)) throw new AppError("VALIDATION", "That person is not a coordinator for this county or a member of a participating organization.", { assigneeEmail: ["Not eligible"] });
        assigneeUser = u[0].id;
      }
      if (i.assigneeOrgId && !(await tx.query(`SELECT 1 FROM event_organizations WHERE event_id = $1 AND org_id = $2`, [i.eventId, i.assigneeOrgId])).length) {
        throw new AppError("VALIDATION", "Add the organization to the event before assigning it a task.", { assigneeOrgId: ["Not a participant"] });
      }
      const r = await tx.query<{ id: string }>(
        `INSERT INTO event_tasks (event_id, title, description, priority, due_date, assignee_user_id, assignee_org_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [i.eventId, i.title, i.description, i.priority, i.dueDate, assigneeUser, i.assigneeOrgId ?? null, userId]);
      await writeAudit(tx, { actorUserId: userId, action: "EVENT_TASK_ADDED", subjectType: "event", subjectId: i.eventId });
      return r[0].id;
    });
  } catch (err) {
    throw fromDbError(err);
  }
}

/** Coordinators move any task; a member of the assigned organization (or the assigned person) moves their own. */
export async function setTaskStatus(driver: Driver, userId: string, taskId: unknown, to: unknown): Promise<void> {
  const id = parseOrThrow(uuid, taskId);
  const next = parseOrThrow(z.enum(TASK_STATUSES), to);
  try {
    await runIn(driver, { kind: "system" }, async (tx) => {
      const t = await tx.query<{ event_id: string; county_id: string; assignee_user_id: string | null; assignee_org_id: string | null }>(
        `SELECT t.event_id, e.county_id, t.assignee_user_id, t.assignee_org_id FROM event_tasks t JOIN events e ON e.id = t.event_id WHERE t.id = $1 FOR UPDATE OF t`, [id]);
      if (!t.length) throw new AppError("NOT_FOUND", "Task not found.");
      const who = await whoIs(tx, userId);
      const mine = t[0].assignee_user_id === userId || (t[0].assignee_org_id !== null && who.orgIds.includes(t[0].assignee_org_id));
      if (!manages(who, t[0].county_id) && !mine) throw new AppError("NOT_FOUND", "Task not found.");
      await requireMfaIfStaff(tx, userId, who);
      await tx.query(`UPDATE event_tasks SET status = $2, completed_at = CASE WHEN $2 = 'DONE' THEN now() ELSE NULL END WHERE id = $1`, [id, next]);
      await writeAudit(tx, { actorUserId: userId, action: "EVENT_TASK_MOVED", subjectType: "event", subjectId: t[0].event_id, details: { to: next } });
    });
  } catch (err) {
    throw fromDbError(err);
  }
}

export const requirementSchema = z.object({
  eventId: uuid,
  kind: z.enum(REQUIREMENT_KINDS),
  label: z.string().trim().min(2, "Name the requirement").max(120),
  quantity: z.coerce.number().positive("Enter a number above zero").max(1e9),
  unit: z.string().trim().min(1, "Enter a unit").max(40),
});
export async function addRequirement(driver: Driver, userId: string, raw: unknown): Promise<void> {
  const i = parseOrThrow(requirementSchema, raw);
  try {
    await runIn(driver, { kind: "system" }, async (tx) => {
      await managedEvent(tx, userId, i.eventId);
      await tx.query(`INSERT INTO event_requirements (event_id, kind, label, quantity, unit) VALUES ($1,$2,$3,$4,$5)`, [i.eventId, i.kind, i.label, i.quantity, i.unit]);
      await writeAudit(tx, { actorUserId: userId, action: "EVENT_REQUIREMENT_ADDED", subjectType: "event", subjectId: i.eventId });
    });
  } catch (err) {
    throw fromDbError(err);
  }
}

export async function addEventUpdate(driver: Driver, userId: string, eventId: unknown, body: unknown, isPublic: boolean): Promise<void> {
  const id = parseOrThrow(uuid, eventId);
  const text = parseOrThrow(z.string().trim().min(2, "Write an update").max(2000), body);
  await runIn(driver, { kind: "system" }, async (tx) => {
    await managedEvent(tx, userId, id);
    await tx.query(`INSERT INTO event_updates (event_id, author_user_id, body, is_public) VALUES ($1,$2,$3,$4)`, [id, userId, text, isPublic]);
    await writeAudit(tx, { actorUserId: userId, action: "EVENT_UPDATE_POSTED", subjectType: "event", subjectId: id, details: { isPublic } });
  });
}

/** Links a project to an event so its commitments and verified deliveries appear in the event report. Same county only. */
export async function linkProject(driver: Driver, userId: string, eventId: unknown, projectId: unknown): Promise<void> {
  const eid = parseOrThrow(uuid, eventId);
  const pid = parseOrThrow(uuid, projectId);
  try {
    await runIn(driver, { kind: "system" }, async (tx) => {
      const e = await managedEvent(tx, userId, eid);
      const p = await tx.query<{ county_id: string }>(`SELECT county_id FROM community_projects WHERE id = $1`, [pid]);
      if (!p.length || p[0].county_id !== e.county_id) throw new AppError("VALIDATION", "That project is not in this event's county.", { projectId: ["Not available"] });
      await tx.query(`UPDATE community_projects SET event_id = $2 WHERE id = $1`, [pid, eid]);
      await writeAudit(tx, { actorUserId: userId, action: "EVENT_PROJECT_LINKED", subjectType: "event", subjectId: eid, details: { projectId: pid } });
    });
  } catch (err) {
    throw fromDbError(err);
  }
}

// --------------------------- reads ---------------------------
export type EventSummary = {
  id: string; reference: string; name: string; category: EventCategory; status: EventStatus; countyName: string; state: string;
  startDate: string; endDate: string | null; zips: string[]; visibility: string; taskTotal: number; taskDone: number;
};
export type TaskRow = {
  id: string; eventId: string; eventName?: string; title: string; description: string | null; status: TaskStatus; priority: TaskPriority;
  dueDate: string | null; assigneeOrg: string | null; assigneeUser: string | null; overdue: boolean;
};
export type EventDetail = EventSummary & {
  description: string; publicSummary: string | null; countyId: string; leadName: string | null; internalNotes: string | null; canManage: boolean;
  allowedNext: EventStatus[]; tasks: TaskRow[]; requirements: { id: string; kind: RequirementKind; label: string; quantity: number; unit: string }[];
  participants: { orgId: string; name: string }[]; updates: { id: string; body: string; isPublic: boolean; at: Date }[];
  projects: { id: string; reference: string; title: string; status: string; percentVerified: number }[];
  metrics: { tasksTotal: number; tasksDone: number; tasksBlocked: number; tasksOverdue: number; percentTasksDone: number };
};

const EVENT_SELECT = `e.id, e.reference, e.name, e.category, e.status, c.name AS county_name, c.state, e.start_date::text AS start_date, e.end_date::text AS end_date, e.visibility,
  coalesce((SELECT array_agg(z.zip ORDER BY z.zip) FROM event_zips z WHERE z.event_id = e.id), '{}') AS zips`;

export const eventFilterSchema = z.object({
  status: z.enum(EVENT_STATUSES).optional().or(z.literal("").transform(() => undefined)),
  countyId: uuid.optional().or(z.literal("").transform(() => undefined)),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal("").transform(() => undefined)),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal("").transform(() => undefined)),
});

async function assertAnyAccess(driver: Driver, userId: string): Promise<Who> {
  return runIn(driver, { kind: "system" }, async (tx) => {
    const w = await whoIs(tx, userId);
    if (!w.executive && w.countyIds.length === 0 && w.orgIds.length === 0) throw new AppError("FORBIDDEN", "You do not have access to events.");
    await requireMfaIfStaff(tx, userId, w);
    return w;
  });
}

export async function listEvents(driver: Driver, userId: string, raw: unknown = {}): Promise<EventSummary[]> {
  const f = parseOrThrow(eventFilterSchema, raw);
  await assertAnyAccess(driver, userId);
  const rows = await runIn(driver, { kind: "viewer", userId }, (tx) =>
    tx.query<Record<string, unknown>>(
      `SELECT ${EVENT_SELECT} FROM events e JOIN counties c ON c.id = e.county_id
        WHERE ($1::text IS NULL OR e.status = $1) AND ($2::uuid IS NULL OR e.county_id = $2)
          AND ($3::date IS NULL OR coalesce(e.end_date, e.start_date) >= $3) AND ($4::date IS NULL OR e.start_date <= $4)
        ORDER BY e.start_date, e.id LIMIT 500`, [f.status ?? null, f.countyId ?? null, f.from ?? null, f.to ?? null]));
  const ids = rows.map((r) => r.id as string);
  const counts = ids.length
    ? await runIn(driver, { kind: "system" }, (tx) => tx.query<{ event_id: string; total: number; done: number }>(
        `SELECT event_id, count(*)::int AS total, count(*) FILTER (WHERE status = 'DONE')::int AS done FROM event_tasks WHERE event_id = ANY($1::uuid[]) GROUP BY event_id`, [ids]))
    : [];
  const byId = new Map(counts.map((c) => [c.event_id, c]));
  return rows.map((r) => ({
    id: r.id as string, reference: r.reference as string, name: r.name as string, category: r.category as EventCategory, status: r.status as EventStatus,
    countyName: r.county_name as string, state: r.state as string, startDate: r.start_date as string, endDate: (r.end_date as string | null) ?? null,
    zips: r.zips as string[], visibility: r.visibility as string, taskTotal: byId.get(r.id as string)?.total ?? 0, taskDone: byId.get(r.id as string)?.done ?? 0,
  }));
}

export async function getEvent(driver: Driver, userId: string, id: string): Promise<EventDetail> {
  if (!uuid.safeParse(id).success) throw new AppError("NOT_FOUND", "Event not found.");
  const who = await assertAnyAccess(driver, userId);
  const d = await runIn(driver, { kind: "viewer", userId }, async (tx) => {
    const e = await tx.query<Record<string, unknown>>(
      `SELECT ${EVENT_SELECT}, e.description, e.public_summary, e.county_id, e.lead_coordinator_id FROM events e JOIN counties c ON c.id = e.county_id WHERE e.id = $1`, [id]);
    if (!e.length) return null;
    const tasks = await tx.query<Record<string, unknown>>(`SELECT t.id, t.title, t.description, t.status, t.priority, t.due_date::text AS due_date, t.assignee_user_id, t.assignee_org_id,
        (t.due_date IS NOT NULL AND t.due_date < current_date AND t.status <> 'DONE') AS overdue FROM event_tasks t WHERE t.event_id = $1 ORDER BY array_position(ARRAY['CRITICAL','HIGH','NORMAL','LOW'], t.priority), t.due_date NULLS LAST, t.created_at`, [id]);
    const reqs = await tx.query<Record<string, unknown>>(`SELECT id, kind, label, quantity, unit FROM event_requirements WHERE event_id = $1 ORDER BY kind, label`, [id]);
    const orgs = await tx.query<{ org_id: string; name: string }>(`SELECT eo.org_id, o.display_name AS name FROM event_organizations eo JOIN organizations o ON o.id = eo.org_id WHERE eo.event_id = $1 ORDER BY o.display_name`, [id]);
    const ups = await tx.query<Record<string, unknown>>(`SELECT id, body, is_public, created_at FROM event_updates WHERE event_id = $1 ORDER BY created_at DESC LIMIT 100`, [id]);
    return { e: e[0], tasks, reqs, orgs, ups };
  });
  if (!d) throw new AppError("NOT_FOUND", "Event not found.");
  const countyId = d.e.county_id as string;
  const canManage = manages(who, countyId);
  const extra = await runIn(driver, { kind: "system" }, async (tx) => {
    const notes = canManage ? await tx.query<{ internal_notes: string | null }>(`SELECT internal_notes FROM events WHERE id = $1`, [id]) : [];
    const lead = d.e.lead_coordinator_id ? await tx.query<{ display_name: string }>(`SELECT display_name FROM users WHERE id = $1`, [d.e.lead_coordinator_id]) : [];
    const projects = canManage ? await tx.query<Record<string, unknown>>(
      `SELECT p.id, p.reference, p.title, p.status,
              coalesce((SELECT round(100 * avg(least(1, v.verified / n.quantity_requested))) FROM project_needs n
                         CROSS JOIN LATERAL (SELECT coalesce(sum(k.qty_verified) FILTER (WHERE k.status NOT IN ('DECLINED','CANCELED')), 0) AS verified FROM project_commitments k WHERE k.need_id = n.id) v
                        WHERE n.project_id = p.id), 0) AS pct
         FROM community_projects p WHERE p.event_id = $1 ORDER BY p.created_at`, [id]) : [];
    const names = new Map<string, string>();
    const uids = d.tasks.map((t) => t.assignee_user_id as string | null).filter((x): x is string => Boolean(x));
    if (uids.length) for (const u of await tx.query<{ id: string; display_name: string }>(`SELECT id, display_name FROM users WHERE id = ANY($1::uuid[])`, [uids])) names.set(u.id, u.display_name);
    return { notes: notes[0]?.internal_notes ?? null, lead: lead[0]?.display_name ?? null, projects, names };
  });
  const orgNames = new Map(d.orgs.map((o) => [o.org_id, o.name]));
  const tasks: TaskRow[] = d.tasks.map((t) => ({
    id: t.id as string, eventId: id, title: t.title as string, description: (t.description as string | null) ?? null, status: t.status as TaskStatus, priority: t.priority as TaskPriority,
    dueDate: (t.due_date as string | null) ?? null, assigneeOrg: t.assignee_org_id ? orgNames.get(t.assignee_org_id as string) ?? "Organization" : null,
    assigneeUser: t.assignee_user_id ? extra.names.get(t.assignee_user_id as string) ?? null : null, overdue: Boolean(t.overdue),
  }));
  const done = tasks.filter((t) => t.status === "DONE").length;
  const status = d.e.status as EventStatus;
  return {
    id, reference: d.e.reference as string, name: d.e.name as string, category: d.e.category as EventCategory, status, countyName: d.e.county_name as string, state: d.e.state as string,
    startDate: d.e.start_date as string, endDate: (d.e.end_date as string | null) ?? null, zips: d.e.zips as string[], visibility: d.e.visibility as string,
    taskTotal: tasks.length, taskDone: done, description: d.e.description as string, publicSummary: (d.e.public_summary as string | null) ?? null, countyId,
    leadName: extra.lead, internalNotes: extra.notes, canManage, allowedNext: canManage ? nextEventStatuses(status) : [], tasks,
    requirements: d.reqs.map((r) => ({ id: r.id as string, kind: r.kind as RequirementKind, label: r.label as string, quantity: Number(r.quantity), unit: r.unit as string })),
    participants: d.orgs.map((o) => ({ orgId: o.org_id, name: o.name })),
    updates: d.ups.map((u) => ({ id: u.id as string, body: u.body as string, isPublic: u.is_public as boolean, at: u.created_at as Date })),
    projects: extra.projects.map((p) => ({ id: p.id as string, reference: p.reference as string, title: p.title as string, status: p.status as string, percentVerified: Number(p.pct) })),
    metrics: {
      tasksTotal: tasks.length, tasksDone: done, tasksBlocked: tasks.filter((t) => t.status === "BLOCKED").length, tasksOverdue: tasks.filter((t) => t.overdue).length,
      percentTasksDone: tasks.length ? Math.round((done / tasks.length) * 100) : 0,
    },
  };
}

export const LOGISTICS_SORTS = ["due", "status", "priority", "event", "assignee"] as const;
export type LogisticsSort = (typeof LOGISTICS_SORTS)[number];
const SORT_SQL: Record<LogisticsSort, { asc: string; desc: string }> = {
  due: { asc: "t.due_date ASC NULLS LAST, e.start_date ASC", desc: "t.due_date DESC NULLS LAST, e.start_date DESC" },
  status: {
    asc: "array_position(ARRAY['BLOCKED','IN_PROGRESS','TODO','DONE'], t.status) ASC, t.due_date ASC NULLS LAST",
    desc: "array_position(ARRAY['BLOCKED','IN_PROGRESS','TODO','DONE'], t.status) DESC, t.due_date ASC NULLS LAST",
  },
  priority: {
    asc: "array_position(ARRAY['CRITICAL','HIGH','NORMAL','LOW'], t.priority) ASC, t.due_date ASC NULLS LAST",
    desc: "array_position(ARRAY['CRITICAL','HIGH','NORMAL','LOW'], t.priority) DESC, t.due_date ASC NULLS LAST",
  },
  event: { asc: "e.name ASC, t.due_date ASC NULLS LAST", desc: "e.name DESC, t.due_date ASC NULLS LAST" },
  assignee: { asc: "t.due_date ASC NULLS LAST", desc: "t.due_date ASC NULLS LAST" }, // names live in tables request roles cannot join; sorted by name in code below
};
export const logisticsSchema = z.object({
  sort: z.enum(LOGISTICS_SORTS).default("due"),
  dir: z.enum(["asc", "desc"]).default("asc"),
  status: z.enum(TASK_STATUSES).optional().or(z.literal("").transform(() => undefined)),
  eventId: uuid.optional().or(z.literal("").transform(() => undefined)),
});

/** One sortable table of tasks across the events the caller may see (a participant sees only tasks assigned to its organization). */
export async function listLogistics(driver: Driver, userId: string, raw: unknown = {}): Promise<TaskRow[]> {
  const f = parseOrThrow(logisticsSchema, raw);
  await assertAnyAccess(driver, userId);
  const tasks = await runIn(driver, { kind: "viewer", userId }, (tx) =>
    tx.query<Record<string, unknown>>(
      `SELECT t.id, t.event_id, e.name AS event_name, t.title, t.description, t.status, t.priority, t.due_date::text AS due_date, t.assignee_org_id, t.assignee_user_id,
              (t.due_date IS NOT NULL AND t.due_date < current_date AND t.status <> 'DONE') AS overdue
         FROM event_tasks t JOIN events e ON e.id = t.event_id
        WHERE ($1::text IS NULL OR t.status = $1) AND ($2::uuid IS NULL OR t.event_id = $2)
        ORDER BY ${SORT_SQL[f.sort][f.dir]}, t.id LIMIT 500`, [f.status ?? null, f.eventId ?? null]));
  const orgIds = [...new Set(tasks.map((t) => t.assignee_org_id as string | null).filter((x): x is string => Boolean(x)))];
  const userIds = [...new Set(tasks.map((t) => t.assignee_user_id as string | null).filter((x): x is string => Boolean(x)))];
  const names = await runIn(driver, { kind: "system" }, async (tx) => ({
    orgs: new Map((orgIds.length ? await tx.query<{ id: string; display_name: string }>(`SELECT id, display_name FROM organizations WHERE id = ANY($1::uuid[])`, [orgIds]) : []).map((o) => [o.id, o.display_name])),
    users: new Map((userIds.length ? await tx.query<{ id: string; display_name: string }>(`SELECT id, display_name FROM users WHERE id = ANY($1::uuid[])`, [userIds]) : []).map((u) => [u.id, u.display_name])),
  }));
  const rows = tasks.map((t) => ({
    id: t.id as string, eventId: t.event_id as string, eventName: t.event_name as string, title: t.title as string, description: (t.description as string | null) ?? null,
    status: t.status as TaskStatus, priority: t.priority as TaskPriority, dueDate: (t.due_date as string | null) ?? null,
    assigneeOrg: t.assignee_org_id ? names.orgs.get(t.assignee_org_id as string) ?? null : null, assigneeUser: t.assignee_user_id ? names.users.get(t.assignee_user_id as string) ?? null : null,
    overdue: Boolean(t.overdue),
  }));
  if (f.sort === "assignee") {
    const key = (r: TaskRow) => (r.assigneeOrg ?? r.assigneeUser ?? "￿").toLowerCase();
    rows.sort((a, b) => (f.dir === "desc" ? -1 : 1) * key(a).localeCompare(key(b)));
  }
  return rows;
}

// --------------------------- public ---------------------------
export type PublicEvent = { id: string; reference: string; name: string; category: EventCategory; summary: string; countyName: string; state: string; startDate: string; endDate: string | null; status: EventStatus; zips: string[] };
const toPublic = (r: Record<string, unknown>): PublicEvent => ({
  id: r.id as string, reference: r.reference as string, name: r.name as string, category: r.category as EventCategory, summary: r.summary as string,
  countyName: r.county_name as string, state: r.state as string, startDate: String(r.start_date).slice(0, 10), endDate: r.end_date ? String(r.end_date).slice(0, 10) : null,
  status: r.status as EventStatus, zips: r.zips as string[],
});
export async function listPublicEvents(driver: Driver, filter: { zip?: string } = {}): Promise<PublicEvent[]> {
  const zip = filter.zip && /^\d{5}$/.test(filter.zip) ? filter.zip : null;
  return runIn(driver, { kind: "anon" }, async (tx) => {
    const r = await tx.query<Record<string, unknown>>(
      `SELECT id, reference, name, category, summary, county_name, state, start_date::text AS start_date, end_date::text AS end_date, status, zips FROM public_events WHERE ($1::text IS NULL OR $1 = ANY (zips)) ORDER BY (status = 'ACTIVE') DESC, start_date LIMIT 100`, [zip]);
    return r.map(toPublic);
  });
}
export async function getPublicEvent(driver: Driver, reference: string): Promise<{ event: PublicEvent; updates: { id: string; body: string; at: Date }[] } | null> {
  if (!/^EVT-\d{4}-\d{6}$/.test(reference)) return null;
  return runIn(driver, { kind: "anon" }, async (tx) => {
    const r = await tx.query<Record<string, unknown>>(`SELECT id, reference, name, category, summary, county_name, state, start_date::text AS start_date, end_date::text AS end_date, status, zips FROM public_events WHERE reference = $1`, [reference]);
    if (!r.length) return null;
    const u = await tx.query<{ id: string; body: string; created_at: Date }>(`SELECT id, body, created_at FROM public_event_updates WHERE event_id = $1 ORDER BY created_at DESC LIMIT 50`, [r[0].id]);
    return { event: toPublic(r[0]), updates: u.map((x) => ({ id: x.id, body: x.body, at: x.created_at })) };
  });
}

// --------------------------- public event area: current needs and resources by ZIP ---------------------------
export type AreaNeed = {
  projectReference: string; projectTitle: string; priority: "LOW" | "NORMAL" | "HIGH" | "CRITICAL"; category: string;
  label: string; unit: string; requested: number; verified: number; remaining: number; percent: number;
};
export type AreaResource = { id: string; name: string; category: string; status: string; freshness: string; quantity: number | null; unit: string | null; lastConfirmedAt: Date | null };
export type AreaSite = {
  id: string; name: string; orgName: string; serviceLabel: string | null; address: string | null; city: string | null; state: string | null;
  phone: string | null; hours: string | null; lat: number; lng: number; resources: AreaResource[];
};
export type PublicEventArea = {
  zips: string[];
  needsByZip: { zip: string; needs: AreaNeed[]; metCount: number }[];
  resourcesByZip: { zip: string; sites: AreaSite[] }[];
  totals: { openNeeds: number; sites: number; resources: number };
};

/**
 * What a visitor needs to act on one public event: the current unmet needs of its published projects and the publicly listed
 * resource sites, both grouped by ZIP code. Built only from the public read models (published projects, public sites and
 * resources), so nothing private, no people and no internal tasks can appear. Pass `zip` to narrow to one ZIP of the event.
 */
export async function getPublicEventArea(driver: Driver, reference: string, filter: { zip?: string } = {}): Promise<PublicEventArea | null> {
  if (!/^EVT-\d{4}-\d{6}$/.test(reference)) return null;
  return runIn(driver, { kind: "anon" }, async (tx) => {
    const ev = await tx.query<{ id: string; zips: string[] }>(`SELECT id, zips FROM public_events WHERE reference = $1`, [reference]);
    if (!ev.length) return null;
    const allZips = ev[0].zips;
    const zips = filter.zip && /^\d{5}$/.test(filter.zip) && allZips.includes(filter.zip) ? [filter.zip] : allZips;

    const projects = await tx.query<Record<string, unknown>>(
      `SELECT reference, title, priority, category, zips, needs FROM public_projects WHERE event_id = $1 AND status IN ('ACTIVE','COMPLETED')
        ORDER BY array_position(ARRAY['CRITICAL','HIGH','NORMAL','LOW'], priority), reference`, [ev[0].id]);
    const needsByZip = new Map<string, { needs: AreaNeed[]; metCount: number }>(zips.map((z) => [z, { needs: [], metCount: 0 }]));
    for (const p of projects) {
      const pzips = p.zips as string[];
      const here = pzips.filter((z) => needsByZip.has(z));
      // A project with no ZIP in the event's list is shown under every ZIP of the event rather than being hidden.
      const targets = here.length ? here : pzips.length === 0 || allZips.every((z) => !pzips.includes(z)) ? zips : [];
      for (const n of p.needs as { label: string; unit: string; requested: number | string; verified: number | string }[]) {
        const requested = Number(n.requested);
        const verified = Number(n.verified);
        for (const z of targets) {
          const slot = needsByZip.get(z)!;
          if (verified >= requested) { slot.metCount += 1; continue; }
          slot.needs.push({
            projectReference: p.reference as string, projectTitle: p.title as string, priority: p.priority as AreaNeed["priority"], category: p.category as string,
            label: n.label, unit: n.unit, requested, verified, remaining: requested - verified, percent: Math.min(100, Math.round((verified / requested) * 100)),
          });
        }
      }
    }

    const sites = await tx.query<Record<string, unknown>>(
      `SELECT id, name, org_name, service_label, address_line, city, state, left(postal_code, 5) AS zip, public_phone, hours_text, lat, lng
         FROM public_sites WHERE left(postal_code, 5) = ANY($1::text[]) ORDER BY name`, [zips]);
    const ids = sites.map((s) => s.id as string);
    const resources = ids.length
      ? await tx.query<Record<string, unknown>>(
          `SELECT id, site_id, name, category_label, reported_status, freshness, reported_quantity, quantity_unit, last_confirmed_at FROM public_resources WHERE site_id = ANY($1::uuid[]) ORDER BY name`, [ids])
      : [];
    const bySite = new Map<string, AreaResource[]>();
    for (const r of resources) {
      const list = bySite.get(r.site_id as string) ?? [];
      list.push({
        id: r.id as string, name: r.name as string, category: r.category_label as string, status: r.reported_status as string, freshness: r.freshness as string,
        quantity: r.reported_quantity === null || r.reported_quantity === undefined ? null : Number(r.reported_quantity), unit: (r.quantity_unit as string | null) ?? null,
        lastConfirmedAt: (r.last_confirmed_at as Date | null) ?? null,
      });
      bySite.set(r.site_id as string, list);
    }
    const resourcesByZip = zips.map((zip) => ({
      zip,
      sites: sites.filter((s) => s.zip === zip).map((s): AreaSite => ({
        id: s.id as string, name: s.name as string, orgName: s.org_name as string, serviceLabel: (s.service_label as string | null) ?? null,
        address: (s.address_line as string | null) ?? null, city: (s.city as string | null) ?? null, state: (s.state as string | null) ?? null,
        phone: (s.public_phone as string | null) ?? null, hours: (s.hours_text as string | null) ?? null, lat: Number(s.lat), lng: Number(s.lng), resources: bySite.get(s.id as string) ?? [],
      })),
    }));
    return {
      zips: allZips,
      needsByZip: zips.map((zip) => ({ zip, ...needsByZip.get(zip)! })),
      resourcesByZip,
      totals: {
        openNeeds: [...needsByZip.values()].reduce((a, v) => a + v.needs.length, 0),
        sites: sites.length,
        resources: resources.length,
      },
    };
  });
}
