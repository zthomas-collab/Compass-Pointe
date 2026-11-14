import { z } from "zod";
import type { Driver, Tx } from "../db";
import { runIn } from "../db/context";
import { AppError, fromDbError } from "../errors";
import { loadAccess } from "./access";
import { parseOrThrow } from "./identity";
import { OFFER_TYPES, type OfferType } from "./offers";
import { privilegedMfaRequired } from "./organizations";
import { writeAudit } from "./shared";
import { zipMatchesCounty } from "./zipcounty";

/**
 * Community projects: a geographic need (county + ZIPs) with requested quantities, filled by commitments.
 *
 *  - Matching only SUGGESTS. A commitment starts PROPOSED and needs an authorized acceptance.
 *  - Five quantities are tracked separately (offered, accepted, dispatched, received, verified). The database
 *    enforces their ordering, refuses over-allocating an offer across projects, and refuses accepting more than requested.
 *  - Completion is computed from verified quantities, never typed in.
 *  - The public sees only the approved summary, ZIP-level location and aggregate verified progress.
 */

export const PROJECT_STATUSES = ["DRAFT", "ACTIVE", "ON_HOLD", "COMPLETED", "CANCELED"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  DRAFT: "Draft", ACTIVE: "Active", ON_HOLD: "On hold", COMPLETED: "Completed", CANCELED: "Canceled",
};
export const PRIORITIES = ["LOW", "NORMAL", "HIGH", "CRITICAL"] as const;
export type Priority = (typeof PRIORITIES)[number];
export const COMMITMENT_STATUSES = ["PROPOSED", "ACCEPTED", "DISPATCHED", "RECEIVED", "VERIFIED", "DECLINED", "CANCELED"] as const;
export type CommitmentStatus = (typeof COMMITMENT_STATUSES)[number];
export const COMMITMENT_LABELS: Record<CommitmentStatus, string> = {
  PROPOSED: "Proposed", ACCEPTED: "Accepted", DISPATCHED: "Dispatched", RECEIVED: "Received", VERIFIED: "Verified", DECLINED: "Declined", CANCELED: "Canceled",
};

const uuid = z.string().uuid();
const dateText = z.string().trim().optional().transform((v) => (v ? v : null)).refine((v) => v === null || /^\d{4}-\d{2}-\d{2}$/.test(v), "Use a valid date");
const qty = z.coerce.number().positive("Enter a number above zero").max(1e9);

/** "28801, 28803 28804" -> unique 5-digit ZIPs. */
export function parseZipList(raw: string): string[] {
  return [...new Set(raw.split(/[\s,;]+/).map((z) => z.trim()).filter(Boolean))];
}

// --------------------------- access ---------------------------
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

async function projectRow(tx: Tx, projectId: string): Promise<{ county_id: string; status: ProjectStatus; visibility: string }> {
  const p = await tx.query<{ county_id: string; status: ProjectStatus; visibility: string }>(`SELECT county_id, status, visibility FROM community_projects WHERE id = $1 FOR UPDATE`, [projectId]);
  if (!p.length) throw new AppError("NOT_FOUND", "Project not found.");
  return p[0];
}

async function requireManager(tx: Tx, userId: string, projectId: string): Promise<{ who: Who; project: Awaited<ReturnType<typeof projectRow>> }> {
  const who = await whoIs(tx, userId);
  const project = await projectRow(tx, projectId);
  if (!manages(who, project.county_id)) throw new AppError("NOT_FOUND", "Project not found."); // do not reveal it exists
  await requireMfaIfStaff(tx, userId, who);
  return { who, project };
}

// --------------------------- create / edit ---------------------------
export const projectSchema = z.object({
  title: z.string().trim().min(5, "Give the project a title").max(140),
  description: z.string().trim().min(10, "Describe the need").max(4000),
  countyId: uuid,
  zips: z.string().trim().min(5, "Enter at least one ZIP code"),
  category: z.enum(OFFER_TYPES),
  priority: z.enum(PRIORITIES).default("NORMAL"),
  startDate: dateText,
  targetDate: dateText,
});

export async function createProject(driver: Driver, userId: string, raw: unknown): Promise<{ id: string; reference: string }> {
  const input = parseOrThrow(projectSchema, raw);
  const zips = parseZipList(input.zips);
  if (zips.length === 0 || zips.length > 40 || zips.some((z) => !/^\d{5}$/.test(z))) {
    throw new AppError("VALIDATION", "Enter 5-digit ZIP codes separated by commas.", { zips: ["Use 5-digit ZIP codes, up to 40"] });
  }
  if (input.startDate && input.targetDate && input.targetDate < input.startDate) {
    throw new AppError("VALIDATION", "The target date is before the start date.", { targetDate: ["Must be on or after the start"] });
  }
  try {
    return await runIn(driver, { kind: "system" }, async (tx) => {
      const who = await whoIs(tx, userId);
      if (!manages(who, input.countyId)) throw new AppError("FORBIDDEN", "You can only create projects in counties you administer.");
      await requireMfaIfStaff(tx, userId, who);
      const c = await tx.query<{ id: string }>(`SELECT id FROM counties WHERE id = $1 AND active`, [input.countyId]);
      if (!c.length) throw new AppError("VALIDATION", "Choose a county.", { countyId: ["Unknown county"] });
      for (const z of zips) {
        if (!(await zipMatchesCounty(tx, z, input.countyId))) {
          throw new AppError("VALIDATION", `ZIP code ${z} is not in the county you chose.`, { zips: [`${z} is not in this county`] });
        }
      }
      const r = await tx.query<{ id: string; reference: string }>(
        `INSERT INTO community_projects (title, description, county_id, category, priority, start_date, target_date, responsible_admin_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING id, reference`,
        [input.title, input.description, input.countyId, input.category, input.priority, input.startDate, input.targetDate, userId],
      );
      await tx.query(`INSERT INTO project_zips (project_id, zip) SELECT $1, unnest($2::text[])`, [r[0].id, zips]);
      await writeAudit(tx, { actorUserId: userId, action: "PROJECT_CREATED", subjectType: "community_project", subjectId: r[0].id });
      return r[0];
    });
  } catch (err) {
    throw fromDbError(err);
  }
}

export const needSchema = z.object({
  projectId: uuid,
  label: z.string().trim().min(2, "Name the resource").max(120),
  contributionType: z.enum(OFFER_TYPES),
  unit: z.string().trim().min(1, "Enter a unit").max(40),
  quantity: qty,
});

export async function addNeed(driver: Driver, userId: string, raw: unknown): Promise<string> {
  const input = parseOrThrow(needSchema, raw);
  try {
    return await runIn(driver, { kind: "system" }, async (tx) => {
      const { project } = await requireManager(tx, userId, input.projectId);
      if (project.status === "COMPLETED" || project.status === "CANCELED") throw new AppError("CONFLICT", "This project is closed.");
      const r = await tx.query<{ id: string }>(
        `INSERT INTO project_needs (project_id, label, contribution_type, unit, quantity_requested) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [input.projectId, input.label, input.contributionType, input.unit, input.quantity]);
      await writeAudit(tx, { actorUserId: userId, action: "PROJECT_NEED_ADDED", subjectType: "community_project", subjectId: input.projectId });
      return r[0].id;
    });
  } catch (err) {
    throw fromDbError(err);
  }
}

export async function addParticipant(driver: Driver, userId: string, projectId: unknown, orgId: unknown): Promise<void> {
  const pid = parseOrThrow(uuid, projectId);
  const oid = parseOrThrow(uuid, orgId);
  try {
    await runIn(driver, { kind: "system" }, async (tx) => {
      await requireManager(tx, userId, pid);
      const o = await tx.query(`SELECT 1 FROM organizations WHERE id = $1 AND status = 'APPROVED' AND NOT publication_suspended`, [oid]);
      if (!o.length) throw new AppError("VALIDATION", "That organization is not an approved provider.", { orgId: ["Not available"] });
      await tx.query(`INSERT INTO project_organizations (project_id, org_id, added_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [pid, oid, userId]);
      await writeAudit(tx, { actorUserId: userId, action: "PROJECT_PARTICIPANT_ADDED", subjectType: "community_project", subjectId: pid, details: { orgId: oid } });
    });
  } catch (err) {
    throw fromDbError(err);
  }
}

const STATUS_MOVES: [ProjectStatus, ProjectStatus][] = [
  ["DRAFT", "ACTIVE"], ["DRAFT", "CANCELED"], ["ACTIVE", "ON_HOLD"], ["ON_HOLD", "ACTIVE"], ["ACTIVE", "CANCELED"], ["ON_HOLD", "CANCELED"],
];
export const nextProjectStatuses = (from: ProjectStatus): ProjectStatus[] => STATUS_MOVES.filter(([f]) => f === from).map(([, t]) => t);

/** Completion is automatic (see recomputeCompletion); managers can activate, hold or cancel. */
export async function setProjectStatus(driver: Driver, userId: string, projectId: unknown, to: unknown): Promise<void> {
  const pid = parseOrThrow(uuid, projectId);
  const next = parseOrThrow(z.enum(PROJECT_STATUSES), to);
  try {
    await runIn(driver, { kind: "system" }, async (tx) => {
      const { project } = await requireManager(tx, userId, pid);
      if (!STATUS_MOVES.some(([f, t]) => f === project.status && t === next)) throw new AppError("CONFLICT", "That status change is not allowed from the current state.");
      if (next === "ACTIVE") {
        const n = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM project_needs WHERE project_id = $1`, [pid]);
        if (n[0].n === 0) throw new AppError("VALIDATION", "Add at least one resource need before activating the project.");
      }
      await tx.query(`UPDATE community_projects SET status = $2 WHERE id = $1`, [pid, next]);
      if (next === "CANCELED") {
        await tx.query(`UPDATE project_commitments SET status = 'CANCELED' WHERE project_id = $1 AND status IN ('PROPOSED','ACCEPTED','DISPATCHED')`, [pid]);
      }
      await writeAudit(tx, { actorUserId: userId, action: `PROJECT_${next}`, subjectType: "community_project", subjectId: pid, details: { from: project.status } });
    });
  } catch (err) {
    throw fromDbError(err);
  }
}

export const publishSchema = z.object({
  projectId: uuid,
  visibility: z.enum(["PRIVATE", "PUBLIC"]),
  publicSummary: z.string().trim().max(600).optional().transform((v) => (v ? v : null)),
});

/** Publishing exposes only the summary written here, ZIP codes, and aggregate verified progress. */
export async function setProjectVisibility(driver: Driver, userId: string, raw: unknown): Promise<void> {
  const input = parseOrThrow(publishSchema, raw);
  if (input.visibility === "PUBLIC" && (!input.publicSummary || input.publicSummary.length < 10)) {
    throw new AppError("VALIDATION", "Write a short public summary (at least 10 characters). Do not include names or addresses.", { publicSummary: ["Required to publish"] });
  }
  try {
    await runIn(driver, { kind: "system" }, async (tx) => {
      await requireManager(tx, userId, input.projectId);
      await tx.query(`UPDATE community_projects SET visibility = $2, public_summary = coalesce($3, public_summary) WHERE id = $1`, [input.projectId, input.visibility, input.publicSummary]);
      await writeAudit(tx, { actorUserId: userId, action: `PROJECT_${input.visibility === "PUBLIC" ? "PUBLISHED" : "UNPUBLISHED"}`, subjectType: "community_project", subjectId: input.projectId });
    });
  } catch (err) {
    throw fromDbError(err);
  }
}

export async function addProjectUpdate(driver: Driver, userId: string, projectId: unknown, body: unknown, isPublic: boolean): Promise<void> {
  const pid = parseOrThrow(uuid, projectId);
  const text = parseOrThrow(z.string().trim().min(2, "Write an update").max(2000), body);
  await runIn(driver, { kind: "system" }, async (tx) => {
    await requireManager(tx, userId, pid);
    await tx.query(`INSERT INTO project_updates (project_id, author_user_id, body, is_public) VALUES ($1,$2,$3,$4)`, [pid, userId, text, isPublic]);
    await writeAudit(tx, { actorUserId: userId, action: "PROJECT_UPDATE_POSTED", subjectType: "community_project", subjectId: pid, details: { isPublic } });
  });
}

// --------------------------- matching (suggest only) ---------------------------
export type MatchSuggestion = {
  offerId: string; reference: string; contributorLabel: string; type: OfferType; unit: string | null;
  quantity: number; allocated: number; available: number; zip: string; countyName: string | null;
  sameZip: boolean; sameCounty: boolean; distanceKm: number | null; windowOk: boolean; score: number; reasons: string[];
};

/**
 * Ranks open offers for a need. Pure suggestion: it commits nothing and reads only what the caller may see.
 * Criteria: same resource type, still-unallocated quantity, ZIP / county / distance, and an availability window that
 * overlaps the project dates. Offers that are closed (declined, canceled, expired, completed) are never suggested.
 */
export async function suggestMatches(driver: Driver, userId: string, needId: unknown): Promise<MatchSuggestion[]> {
  const nid = parseOrThrow(uuid, needId);
  return runIn(driver, { kind: "system" }, async (tx) => {
    const need = await tx.query<{ project_id: string; county_id: string; contribution_type: OfferType; start_date: string | null; target_date: string | null }>(
      `SELECT n.project_id, p.county_id, n.contribution_type, p.start_date::text, p.target_date::text
         FROM project_needs n JOIN community_projects p ON p.id = n.project_id WHERE n.id = $1`, [nid]);
    if (!need.length) throw new AppError("NOT_FOUND", "Need not found.");
    await requireManager(tx, userId, need[0].project_id);
    const rows = await tx.query<Record<string, unknown>>(
      `SELECT o.id, o.reference, o.contributor_name, o.organization_name, o.contribution_type, o.unit, o.quantity, o.zip, o.county_id, c.name AS county_name,
              o.available_from::text AS available_from, o.available_until::text AS available_until,
              coalesce((SELECT sum(CASE WHEN k.status = 'VERIFIED' THEN k.qty_verified ELSE k.qty_offered END) FROM project_commitments k WHERE k.offer_id = o.id AND k.status NOT IN ('DECLINED','CANCELED')), 0) AS allocated,
              EXISTS (SELECT 1 FROM project_zips z WHERE z.project_id = $2 AND z.zip = o.zip) AS same_zip,
              (SELECT min(ST_Distance(a.location, b.location)) / 1000.0 FROM project_zips z
                 JOIN zip_codes a ON a.zip = z.zip JOIN zip_codes b ON b.zip = o.zip WHERE z.project_id = $2) AS distance_km
         FROM contribution_offers o LEFT JOIN counties c ON c.id = o.county_id
        WHERE o.contribution_type = $1 AND o.quantity IS NOT NULL AND o.status IN ('SUBMITTED','REVIEWED','MATCHED','ACCEPTED')
          AND (o.county_id IS NULL OR o.county_id = $3 OR EXISTS (SELECT 1 FROM project_zips z WHERE z.project_id = $2 AND z.zip = o.zip)
               OR (SELECT min(ST_Distance(a.location, b.location)) FROM project_zips z JOIN zip_codes a ON a.zip = z.zip JOIN zip_codes b ON b.zip = o.zip WHERE z.project_id = $2) < 80000)`,
      [need[0].contribution_type, need[0].project_id, need[0].county_id]);
    const out: MatchSuggestion[] = [];
    for (const r of rows) {
      const quantity = Number(r.quantity);
      const allocated = Number(r.allocated);
      const available = quantity - allocated;
      if (available <= 0) continue;
      const sameZip = Boolean(r.same_zip);
      const sameCounty = r.county_id === need[0].county_id;
      const distanceKm = r.distance_km === null || r.distance_km === undefined ? null : Math.round(Number(r.distance_km));
      const from = (r.available_from as string | null) ?? null;
      const until = (r.available_until as string | null) ?? null;
      const windowOk = (!until || !need[0].start_date || until >= need[0].start_date) && (!from || !need[0].target_date || from <= need[0].target_date);
      if (!windowOk) continue;
      const reasons = [sameZip ? "Same ZIP code as the project" : sameCounty ? "Same county" : distanceKm !== null ? `About ${distanceKm} km away` : "County not yet confirmed"];
      reasons.push(`${available} of ${quantity}${r.unit ? ` ${r.unit}` : ""} still unallocated`);
      if (from || until) reasons.push(`Available ${from ?? "now"} to ${until ?? "open-ended"}`);
      const score = (sameZip ? 100 : sameCounty ? 60 : 20) - (distanceKm ?? 60) / 4 + Math.min(available, 1000) / 100 + (r.county_id === null ? -10 : 0);
      out.push({
        offerId: r.id as string, reference: r.reference as string,
        contributorLabel: ((r.organization_name as string | null) ?? (r.contributor_name as string)), type: r.contribution_type as OfferType,
        unit: (r.unit as string | null) ?? null, quantity, allocated, available, zip: r.zip as string, countyName: (r.county_name as string | null) ?? null,
        sameZip, sameCounty, distanceKm, windowOk, score: Math.round(score * 10) / 10, reasons,
      });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, 25);
  });
}

// --------------------------- commitments ---------------------------
export const proposeSchema = z.object({
  needId: uuid,
  offerId: uuid.optional().or(z.literal("").transform(() => undefined)),
  orgId: uuid.optional().or(z.literal("").transform(() => undefined)),
  quantity: qty,
  scheduledFor: dateText,
});

/** A manager proposes a commitment from an offer and/or a participating organization. Nothing is accepted yet. */
export async function proposeCommitment(driver: Driver, userId: string, raw: unknown): Promise<string> {
  const input = parseOrThrow(proposeSchema, raw);
  if (!input.offerId && !input.orgId) throw new AppError("VALIDATION", "Choose an offer or a participating organization.", { offerId: ["Choose one"] });
  try {
    return await runIn(driver, { kind: "system" }, async (tx) => {
      const need = await tx.query<{ project_id: string }>(`SELECT project_id FROM project_needs WHERE id = $1`, [input.needId]);
      if (!need.length) throw new AppError("NOT_FOUND", "Need not found.");
      const { project } = await requireManager(tx, userId, need[0].project_id);
      if (project.status !== "ACTIVE" && project.status !== "DRAFT") throw new AppError("CONFLICT", "This project is not open for new commitments.");
      let label = "";
      if (input.offerId) {
        const o = await tx.query<{ contributor_name: string; organization_name: string | null; status: string }>(
          `SELECT contributor_name, organization_name, status FROM contribution_offers WHERE id = $1`, [input.offerId]);
        if (!o.length) throw new AppError("NOT_FOUND", "Offer not found.");
        if (["DECLINED", "CANCELED", "EXPIRED", "COMPLETED"].includes(o[0].status)) throw new AppError("CONFLICT", "That offer is closed.");
        label = o[0].organization_name ?? o[0].contributor_name;
      }
      if (input.orgId) {
        const o = await tx.query<{ display_name: string }>(`SELECT display_name FROM organizations WHERE id = $1`, [input.orgId]);
        label = o[0]?.display_name ?? label;
      }
      const r = await tx.query<{ id: string }>(
        `INSERT INTO project_commitments (project_id, need_id, offer_id, org_id, source_label, qty_offered, scheduled_for, proposed_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [need[0].project_id, input.needId, input.offerId ?? null, input.orgId ?? null, label, input.quantity, input.scheduledFor, userId]);
      await writeAudit(tx, { actorUserId: userId, action: "COMMITMENT_PROPOSED", subjectType: "project_commitment", subjectId: r[0].id,
        details: { projectId: need[0].project_id, quantity: input.quantity } });
      return r[0].id;
    });
  } catch (err) {
    throw fromDbError(err);
  }
}

type CommitmentCtx = {
  id: string; project_id: string; org_id: string | null; offer_id: string | null; status: CommitmentStatus;
  qty_offered: string; qty_accepted: string; qty_dispatched: string; qty_received: string; county_id: string;
};
async function loadCommitment(tx: Tx, id: string): Promise<CommitmentCtx> {
  const r = await tx.query<CommitmentCtx>(
    `SELECT k.id, k.project_id, k.org_id, k.offer_id, k.status, k.qty_offered, k.qty_accepted, k.qty_dispatched, k.qty_received, p.county_id
       FROM project_commitments k JOIN community_projects p ON p.id = k.project_id WHERE k.id = $1 FOR UPDATE OF k`, [id]);
  if (!r.length) throw new AppError("NOT_FOUND", "Commitment not found.");
  return r[0];
}

/** Manager of the project's county, or (for dispatch only) a member of the committed organization. */
async function actorOn(tx: Tx, userId: string, k: CommitmentCtx): Promise<"manager" | "org"> {
  const who = await whoIs(tx, userId);
  if (manages(who, k.county_id)) {
    await requireMfaIfStaff(tx, userId, who);
    return "manager";
  }
  if (k.org_id && who.orgIds.includes(k.org_id)) return "org";
  throw new AppError("NOT_FOUND", "Commitment not found.");
}

export const respondSchema = z.object({
  commitmentId: uuid,
  accept: z.enum(["accept", "decline"]),
  quantity: z.coerce.number().positive().max(1e9).optional().or(z.literal("").transform(() => undefined)),
  note: z.string().trim().max(1000).optional().transform((v) => (v ? v : null)),
});

/**
 * Acceptance is always an explicit act. A participating organization accepts or declines its own commitment. A commitment
 * that comes from a public offer is accepted by a manager, who must record how the contributor confirmed it.
 */
export async function respondToCommitment(driver: Driver, userId: string, raw: unknown): Promise<void> {
  const input = parseOrThrow(respondSchema, raw);
  try {
    await runIn(driver, { kind: "system" }, async (tx) => {
      const k = await loadCommitment(tx, input.commitmentId);
      const as = await actorOn(tx, userId, k);
      if (k.status !== "PROPOSED") throw new AppError("CONFLICT", "This commitment has already been answered.");
      if (input.accept === "decline") {
        await tx.query(`UPDATE project_commitments SET status = 'DECLINED', note = coalesce($2, note) WHERE id = $1`, [k.id, input.note]);
        await writeAudit(tx, { actorUserId: userId, action: "COMMITMENT_DECLINED", subjectType: "project_commitment", subjectId: k.id, details: { as } });
        return;
      }
      if (as === "manager" && !k.org_id && (!input.note || input.note.length < 5)) {
        throw new AppError("VALIDATION", "Record how the contributor confirmed (for example: confirmed by phone on Tuesday).", { note: ["Required"] });
      }
      if (as === "manager" && k.org_id && !k.offer_id && (!input.note || input.note.length < 5)) {
        throw new AppError("VALIDATION", "Record how the organization confirmed.", { note: ["Required"] });
      }
      const q = input.quantity ?? Number(k.qty_offered);
      if (q > Number(k.qty_offered)) throw new AppError("VALIDATION", "You cannot accept more than was offered.", { quantity: ["Too high"] });
      await tx.query(`UPDATE project_commitments SET status = 'ACCEPTED', qty_accepted = $2, accepted_by = $3, accepted_at = now(), note = coalesce($4, note) WHERE id = $1`,
        [k.id, q, userId, input.note]);
      await writeAudit(tx, { actorUserId: userId, action: "COMMITMENT_ACCEPTED", subjectType: "project_commitment", subjectId: k.id, details: { as, quantity: q } });
    });
  } catch (err) {
    throw fromDbError(err);
  }
}

export const progressSchema = z.object({
  commitmentId: uuid,
  stage: z.enum(["DISPATCHED", "RECEIVED", "VERIFIED"]),
  quantity: qty,
  receiverName: z.string().trim().max(120).optional().transform((v) => (v ? v : null)),
});

/**
 * Reports delivery progress with cumulative quantities. The committed organization (or a manager) reports DISPATCHED;
 * only a manager records RECEIVED and VERIFIED, naming the person who confirmed receipt. Verified quantities drive
 * project totals and automatic completion.
 */
export async function reportProgress(driver: Driver, userId: string, raw: unknown): Promise<void> {
  const input = parseOrThrow(progressSchema, raw);
  try {
    await runIn(driver, { kind: "system" }, async (tx) => {
      const k = await loadCommitment(tx, input.commitmentId);
      const as = await actorOn(tx, userId, k);
      if (input.stage !== "DISPATCHED" && as !== "manager") throw new AppError("FORBIDDEN", "Only a coordinator can record receipt and verification.");
      const prior: Record<string, CommitmentStatus> = { DISPATCHED: "ACCEPTED", RECEIVED: "DISPATCHED", VERIFIED: "RECEIVED" };
      if (k.status !== prior[input.stage]) throw new AppError("CONFLICT", `This commitment must be ${COMMITMENT_LABELS[prior[input.stage]].toLowerCase()} before it can be ${COMMITMENT_LABELS[input.stage].toLowerCase()}.`);
      const cap = input.stage === "DISPATCHED" ? Number(k.qty_accepted) : input.stage === "RECEIVED" ? Number(k.qty_dispatched) : Number(k.qty_received);
      if (input.quantity > cap) throw new AppError("VALIDATION", `That is more than the ${cap} reported at the previous step.`, { quantity: ["Too high"] });
      if (input.stage !== "DISPATCHED" && (!input.receiverName || input.receiverName.length < 2)) {
        throw new AppError("VALIDATION", "Name the person who confirmed receipt.", { receiverName: ["Required"] });
      }
      const col = input.stage === "DISPATCHED" ? "qty_dispatched" : input.stage === "RECEIVED" ? "qty_received" : "qty_verified";
      await tx.query(`UPDATE project_commitments SET status = $2, ${col} = $3, receiver_name = coalesce($4, receiver_name) WHERE id = $1`,
        [k.id, input.stage, input.quantity, input.receiverName]);
      await writeAudit(tx, { actorUserId: userId, action: `COMMITMENT_${input.stage}`, subjectType: "project_commitment", subjectId: k.id, details: { as, quantity: input.quantity } });
      if (input.stage === "VERIFIED") await recomputeCompletion(tx, k.project_id);
    });
  } catch (err) {
    throw fromDbError(err);
  }
}

/** Completion is derived: every need has verified >= requested. Runs inside the same transaction as the verification. */
async function recomputeCompletion(tx: Tx, projectId: string): Promise<boolean> {
  const r = await tx.query<{ open_needs: number; status: ProjectStatus }>(
    `SELECT (SELECT count(*)::int FROM project_needs n
              WHERE n.project_id = p.id
                AND coalesce((SELECT sum(k.qty_verified) FROM project_commitments k WHERE k.need_id = n.id AND k.status NOT IN ('DECLINED','CANCELED')), 0) < n.quantity_requested) AS open_needs,
            p.status
       FROM community_projects p WHERE p.id = $1`, [projectId]);
  if (r[0].status === "ACTIVE" && r[0].open_needs === 0) {
    await tx.query(`UPDATE community_projects SET status = 'COMPLETED', completed_at = now() WHERE id = $1`, [projectId]);
    await writeAudit(tx, { actorUserId: null, action: "PROJECT_COMPLETED", subjectType: "community_project", subjectId: projectId, details: { automatic: true } });
    return true;
  }
  return false;
}

// --------------------------- reads ---------------------------
export type NeedTotals = {
  id: string; label: string; contributionType: OfferType; unit: string; requested: number;
  offered: number; accepted: number; dispatched: number; received: number; verified: number; percentVerified: number;
};
export type CommitmentRow = {
  id: string; needId: string; needLabel: string; sourceLabel: string; offerReference: string | null; orgName: string | null; status: CommitmentStatus;
  offered: number; accepted: number; dispatched: number; received: number; verified: number; scheduledFor: string | null; receiverName: string | null; note: string | null;
};
export type ProjectSummary = {
  id: string; reference: string; title: string; countyName: string; state: string; category: OfferType; priority: Priority; status: ProjectStatus;
  visibility: string; zips: string[]; percentVerified: number; targetDate: string | null;
};
export type ProjectDetail = ProjectSummary & {
  description: string; publicSummary: string | null; startDate: string | null; countyId: string; needs: NeedTotals[]; commitments: CommitmentRow[];
  participants: { orgId: string; name: string }[]; updates: { id: string; body: string; isPublic: boolean; at: Date }[];
  canManage: boolean; allowedNext: ProjectStatus[];
};

const NEEDS_SQL = `
  SELECT n.id, n.project_id, n.label, n.contribution_type, n.unit, n.quantity_requested,
         coalesce(sum(k.qty_offered)    FILTER (WHERE k.status NOT IN ('DECLINED','CANCELED')), 0) AS offered,
         coalesce(sum(k.qty_accepted)   FILTER (WHERE k.status NOT IN ('DECLINED','CANCELED')), 0) AS accepted,
         coalesce(sum(k.qty_dispatched) FILTER (WHERE k.status NOT IN ('DECLINED','CANCELED')), 0) AS dispatched,
         coalesce(sum(k.qty_received)   FILTER (WHERE k.status NOT IN ('DECLINED','CANCELED')), 0) AS received,
         coalesce(sum(k.qty_verified)   FILTER (WHERE k.status NOT IN ('DECLINED','CANCELED')), 0) AS verified
    FROM project_needs n LEFT JOIN project_commitments k ON k.need_id = n.id`;

const toNeed = (r: Record<string, unknown>): NeedTotals => {
  const requested = Number(r.quantity_requested);
  const verified = Number(r.verified);
  return {
    id: r.id as string, label: r.label as string, contributionType: r.contribution_type as OfferType, unit: r.unit as string, requested,
    offered: Number(r.offered), accepted: Number(r.accepted), dispatched: Number(r.dispatched), received: Number(r.received), verified,
    percentVerified: Math.min(100, Math.round((verified / requested) * 100)),
  };
};

function percentOf(needs: NeedTotals[]): number {
  if (needs.length === 0) return 0;
  return Math.round(needs.reduce((s, n) => s + Math.min(1, n.verified / n.requested), 0) / needs.length * 100);
}

export const projectFilterSchema = z.object({
  status: z.enum(PROJECT_STATUSES).optional().or(z.literal("").transform(() => undefined)),
  countyId: uuid.optional().or(z.literal("").transform(() => undefined)),
  zip: z.string().regex(/^\d{5}$/).optional().or(z.literal("").transform(() => undefined)),
});

/** Projects the caller may see (managers: their counties; participating organizations: their projects). */
export async function listProjects(driver: Driver, userId: string, raw: unknown = {}): Promise<ProjectSummary[]> {
  const f = parseOrThrow(projectFilterSchema, raw);
  await runIn(driver, { kind: "system" }, async (tx) => {
    const w = await whoIs(tx, userId);
    if (!w.executive && w.countyIds.length === 0 && w.orgIds.length === 0) throw new AppError("FORBIDDEN", "You do not have access to projects.");
    await requireMfaIfStaff(tx, userId, w);
  });
  const ps = await runIn(driver, { kind: "viewer", userId }, async (tx) => {
    return tx.query<Record<string, unknown>>(
      `SELECT p.id, p.reference, p.title, c.name AS county_name, c.state, p.category, p.priority, p.status, p.visibility, p.target_date::text AS target_date,
              coalesce((SELECT array_agg(z.zip ORDER BY z.zip) FROM project_zips z WHERE z.project_id = p.id), '{}') AS zips
         FROM community_projects p JOIN counties c ON c.id = p.county_id
        WHERE ($1::text IS NULL OR p.status = $1) AND ($2::uuid IS NULL OR p.county_id = $2)
          AND ($3::text IS NULL OR EXISTS (SELECT 1 FROM project_zips z WHERE z.project_id = p.id AND z.zip = $3))
        ORDER BY (p.status = 'ACTIVE') DESC, array_position(ARRAY['CRITICAL','HIGH','NORMAL','LOW'], p.priority), p.created_at DESC LIMIT 200`,
      [f.status ?? null, f.countyId ?? null, f.zip ?? null]);
  });
  // Visible projects were chosen by row-level security above; totals then count every commitment so a participant sees true progress.
  const ids = ps.map((p) => p.id as string);
  const needs = ids.length ? await runIn(driver, { kind: "system" }, (st) => st.query<Record<string, unknown>>(`${NEEDS_SQL} WHERE n.project_id = ANY($1::uuid[]) GROUP BY n.id`, [ids])) : [];
  {
    const byProject = new Map<string, NeedTotals[]>();
    for (const n of needs) byProject.set(n.project_id as string, [...(byProject.get(n.project_id as string) ?? []), toNeed(n)]);
    return ps.map((p) => ({
      id: p.id as string, reference: p.reference as string, title: p.title as string, countyName: p.county_name as string, state: p.state as string,
      category: p.category as OfferType, priority: p.priority as Priority, status: p.status as ProjectStatus, visibility: p.visibility as string,
      zips: p.zips as string[], percentVerified: percentOf(byProject.get(p.id as string) ?? []), targetDate: (p.target_date as string | null) ?? null,
    }));
  }
}

export async function getProject(driver: Driver, userId: string, id: string): Promise<ProjectDetail> {
  if (!uuid.safeParse(id).success) throw new AppError("NOT_FOUND", "Project not found.");
  const who = await runIn(driver, { kind: "system" }, async (tx) => {
    const w = await whoIs(tx, userId);
    await requireMfaIfStaff(tx, userId, w);
    return w;
  });
  const d = await runIn(driver, { kind: "viewer", userId }, async (tx) => {
    const p = await tx.query<Record<string, unknown>>(
      `SELECT p.id, p.reference, p.title, p.description, p.public_summary, p.county_id, c.name AS county_name, c.state, p.category, p.priority, p.status, p.visibility,
              p.start_date::text AS start_date, p.target_date::text AS target_date,
              coalesce((SELECT array_agg(z.zip ORDER BY z.zip) FROM project_zips z WHERE z.project_id = p.id), '{}') AS zips
         FROM community_projects p JOIN counties c ON c.id = p.county_id WHERE p.id = $1`, [id]);
    if (!p.length) return null;
    const commitments = await tx.query<Record<string, unknown>>(
      `SELECT k.*, k.scheduled_for::text AS sched_text, n.label AS need_label, o.reference AS offer_reference, g.display_name AS org_name
         FROM project_commitments k JOIN project_needs n ON n.id = k.need_id
         LEFT JOIN contribution_offers o ON o.id = k.offer_id LEFT JOIN organizations g ON g.id = k.org_id
        WHERE k.project_id = $1 ORDER BY k.created_at`, [id]);
    const participants = await tx.query<{ org_id: string; name: string }>(
      `SELECT po.org_id, o.display_name AS name FROM project_organizations po JOIN organizations o ON o.id = po.org_id WHERE po.project_id = $1 ORDER BY o.display_name`, [id]);
    const updates = await tx.query<Record<string, unknown>>(`SELECT id, body, is_public, created_at FROM project_updates WHERE project_id = $1 ORDER BY created_at DESC LIMIT 100`, [id]);
    return { p: p[0], commitments, participants, updates };
  });
  if (!d) throw new AppError("NOT_FOUND", "Project not found.");
  const needs = (await runIn(driver, { kind: "system" }, (st) => st.query<Record<string, unknown>>(`${NEEDS_SQL} WHERE n.project_id = $1 GROUP BY n.id ORDER BY n.created_at`, [id]))).map(toNeed);
  const status = d.p.status as ProjectStatus;
  const canManage = manages(who, d.p.county_id as string);
  return {
    id: d.p.id as string, reference: d.p.reference as string, title: d.p.title as string, countyName: d.p.county_name as string, state: d.p.state as string,
    category: d.p.category as OfferType, priority: d.p.priority as Priority, status, visibility: d.p.visibility as string, zips: d.p.zips as string[],
    percentVerified: percentOf(needs), targetDate: (d.p.target_date as string | null) ?? null, description: d.p.description as string,
    publicSummary: (d.p.public_summary as string | null) ?? null, startDate: (d.p.start_date as string | null) ?? null, countyId: d.p.county_id as string,
    needs,
    commitments: d.commitments.map((k) => ({
      id: k.id as string, needId: k.need_id as string, needLabel: k.need_label as string, sourceLabel: k.source_label as string,
      offerReference: (k.offer_reference as string | null) ?? null, orgName: (k.org_name as string | null) ?? null, status: k.status as CommitmentStatus,
      offered: Number(k.qty_offered), accepted: Number(k.qty_accepted), dispatched: Number(k.qty_dispatched), received: Number(k.qty_received), verified: Number(k.qty_verified),
      scheduledFor: (k.sched_text as string | null) ?? null, receiverName: (k.receiver_name as string | null) ?? null, note: (k.note as string | null) ?? null,
    })),
    participants: d.participants.map((x) => ({ orgId: x.org_id, name: x.name })),
    updates: d.updates.map((u) => ({ id: u.id as string, body: u.body as string, isPublic: u.is_public as boolean, at: u.created_at as Date })),
    canManage, allowedNext: canManage ? nextProjectStatuses(status) : [],
  };
}

// --------------------------- public ---------------------------
export type PublicProject = {
  id: string; reference: string; title: string; summary: string; countyName: string; state: string; category: OfferType; priority: Priority;
  status: ProjectStatus; startDate: string | null; targetDate: string | null; zips: string[];
  needs: { label: string; unit: string; requested: number; verified: number }[]; percentVerified: number;
};
const toPublic = (r: Record<string, unknown>): PublicProject => {
  const needs = (r.needs as { label: string; unit: string; requested: number | string; verified: number | string }[]).map((n) => ({
    label: n.label, unit: n.unit, requested: Number(n.requested), verified: Number(n.verified),
  }));
  return {
    id: r.id as string, reference: r.reference as string, title: r.title as string, summary: r.summary as string, countyName: r.county_name as string,
    state: r.state as string, category: r.category as OfferType, priority: r.priority as Priority, status: r.status as ProjectStatus,
    startDate: r.start_date ? String(r.start_date).slice(0, 10) : null, targetDate: r.target_date ? String(r.target_date).slice(0, 10) : null,
    zips: r.zips as string[], needs,
    percentVerified: needs.length ? Math.round(needs.reduce((s, n) => s + Math.min(1, n.verified / n.requested), 0) / needs.length * 100) : 0,
  };
};

export async function listPublicProjects(driver: Driver, filter: { zip?: string; countyName?: string } = {}): Promise<PublicProject[]> {
  const zip = filter.zip && /^\d{5}$/.test(filter.zip) ? filter.zip : null;
  return runIn(driver, { kind: "anon" }, async (tx) => {
    const r = await tx.query<Record<string, unknown>>(
      `SELECT id, reference, title, summary, county_name, state, category, priority, status, start_date::text AS start_date, target_date::text AS target_date, zips, needs FROM public_projects WHERE ($1::text IS NULL OR $1 = ANY (zips)) AND ($2::text IS NULL OR county_name = $2)
        ORDER BY (status = 'ACTIVE') DESC, array_position(ARRAY['CRITICAL','HIGH','NORMAL','LOW'], priority), reference DESC LIMIT 100`,
      [zip, filter.countyName ?? null]);
    return r.map(toPublic);
  });
}

export async function getPublicProject(driver: Driver, reference: string): Promise<{ project: PublicProject; updates: { id: string; body: string; at: Date }[] } | null> {
  if (!/^PRJ-\d{4}-\d{6}$/.test(reference)) return null;
  return runIn(driver, { kind: "anon" }, async (tx) => {
    const r = await tx.query<Record<string, unknown>>(`SELECT id, reference, title, summary, county_name, state, category, priority, status, start_date::text AS start_date, target_date::text AS target_date, zips, needs FROM public_projects WHERE reference = $1`, [reference]);
    if (!r.length) return null;
    const u = await tx.query<{ id: string; body: string; created_at: Date }>(`SELECT id, body, created_at FROM public_project_updates WHERE project_id = $1 ORDER BY created_at DESC LIMIT 50`, [r[0].id]);
    return { project: toPublic(r[0]), updates: u.map((x) => ({ id: x.id, body: x.body, at: x.created_at })) };
  });
}

/** Commitments assigned to organizations the caller belongs to (for the nonprofit dashboard). */
export async function listMyCommitments(driver: Driver, userId: string): Promise<(CommitmentRow & { projectId: string; projectTitle: string; projectReference: string })[]> {
  return runIn(driver, { kind: "viewer", userId }, async (tx) => {
    const r = await tx.query<Record<string, unknown>>(
      `SELECT k.*, k.scheduled_for::text AS sched_text, n.label AS need_label, p.id AS pid, p.title AS ptitle, p.reference AS pref, g.display_name AS org_name
         FROM project_commitments k JOIN project_needs n ON n.id = k.need_id JOIN community_projects p ON p.id = k.project_id
         JOIN organizations g ON g.id = k.org_id
        WHERE k.org_id = ANY (ics.viewer_approved_org_ids()) AND k.status NOT IN ('DECLINED','CANCELED') ORDER BY k.created_at DESC LIMIT 200`);
    return r.map((k) => ({
      id: k.id as string, needId: k.need_id as string, needLabel: k.need_label as string, sourceLabel: k.source_label as string, offerReference: null,
      orgName: (k.org_name as string | null) ?? null, status: k.status as CommitmentStatus, offered: Number(k.qty_offered), accepted: Number(k.qty_accepted),
      dispatched: Number(k.qty_dispatched), received: Number(k.qty_received), verified: Number(k.qty_verified),
      scheduledFor: (k.sched_text as string | null) ?? null, receiverName: (k.receiver_name as string | null) ?? null, note: (k.note as string | null) ?? null,
      projectId: k.pid as string, projectTitle: k.ptitle as string, projectReference: k.pref as string,
    }));
  });
}

/** Approved, active organizations a manager may add to a project. */
export async function listApprovableOrgs(driver: Driver, userId: string): Promise<{ id: string; name: string }[]> {
  return runIn(driver, { kind: "system" }, async (tx) => {
    const w = await whoIs(tx, userId);
    if (!w.executive && w.countyIds.length === 0) throw new AppError("FORBIDDEN", "Only coordinators can add organizations.");
    return tx.query<{ id: string; name: string }>(
      `SELECT id, display_name AS name FROM organizations WHERE status = 'APPROVED' AND NOT publication_suspended ORDER BY display_name LIMIT 500`);
  });
}
