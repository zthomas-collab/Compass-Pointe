import { z } from "zod";
import { parseYouTubeId } from "@/lib/youtube";
import type { Driver, Tx } from "../db";
import { runIn } from "../db/context";
import { AppError, fromDbError } from "../errors";
import { loadAccess } from "./access";
import { parseOrThrow } from "./identity";
import { assertPlatformAdmin, privilegedMfaRequired } from "./organizations";
import { writeAudit } from "./shared";

/**
 * Educational library. YouTube videos and plain-text articles only. Executives publish directly; everything else waits
 * for an executive's review. Anonymous visitors read published items through a view; nothing else is public.
 */
export const LEARNING_CATEGORIES = ["PREPAREDNESS", "VOLUNTEER_ONBOARDING", "RESOURCE_REQUESTS", "APPLICATION_WALKTHROUGH", "RECOVERY", "SAFETY", "OTHER"] as const;
export type LearningCategory = (typeof LEARNING_CATEGORIES)[number];
export const LEARNING_CATEGORY_LABELS: Record<LearningCategory, string> = {
  PREPAREDNESS: "Disaster preparedness",
  VOLUNTEER_ONBOARDING: "Volunteer onboarding",
  RESOURCE_REQUESTS: "How to request resources",
  APPLICATION_WALKTHROUGH: "Application walkthroughs",
  RECOVERY: "Recovery guidance",
  SAFETY: "Safety",
  OTHER: "Other",
};
export const LEARNING_STATUSES = ["DRAFT", "PENDING_REVIEW", "PUBLISHED", "REJECTED", "ARCHIVED"] as const;
export type LearningStatus = (typeof LEARNING_STATUSES)[number];
export const LEARNING_STATUS_LABELS: Record<LearningStatus, string> = {
  DRAFT: "Draft", PENDING_REVIEW: "Waiting for review", PUBLISHED: "Published", REJECTED: "Not approved", ARCHIVED: "Archived",
};

const PENDING_LIMIT = 10;
const uuid = z.string().uuid();

export const resourceSchema = z
  .object({
    title: z.string().trim().min(5, "Give it a title").max(140),
    description: z.string().trim().min(10, "Add a short description").max(600),
    category: z.enum(LEARNING_CATEGORIES, { message: "Choose a category" }),
    kind: z.enum(["VIDEO", "ARTICLE"]),
    url: z.string().trim().max(300).optional(),
    body: z.string().trim().max(20000).optional(),
    orgId: uuid.optional().or(z.literal("").transform(() => undefined)),
  })
  .superRefine((v, ctx) => {
    if (v.kind === "VIDEO") {
      if (!v.url || !parseYouTubeId(v.url)) ctx.addIssue({ code: "custom", path: ["url"], message: "Paste a YouTube link (youtube.com or youtu.be). Other video sites are not accepted." });
    } else if (!v.body || v.body.length < 50) {
      ctx.addIssue({ code: "custom", path: ["body"], message: "Write at least a few sentences (50 characters)." });
    }
  });

type Who = { executive: boolean; countyIds: string[]; orgIds: string[] };
async function whoIs(tx: Tx, userId: string): Promise<Who> {
  const a = await loadAccess(tx, userId);
  return { executive: a.executive, countyIds: a.countyIds, orgIds: a.orgIds };
}

/** Executives publish directly. County administrators and members of approved organizations submit for review. */
export async function submitResource(driver: Driver, userId: string, raw: unknown): Promise<{ id: string; status: LearningStatus }> {
  const input = parseOrThrow(resourceSchema, raw);
  try {
    return await runIn(driver, { kind: "system" }, async (tx) => {
      const who = await whoIs(tx, userId);
      if (!who.executive && who.countyIds.length === 0 && who.orgIds.length === 0) throw new AppError("FORBIDDEN", "Only administrators and approved organizations can add learning materials.");
      if (input.orgId && !who.executive && !who.orgIds.includes(input.orgId)) throw new AppError("FORBIDDEN", "You are not a member of that organization.");
      if (!input.orgId && !who.executive && who.countyIds.length === 0) throw new AppError("VALIDATION", "Choose your organization.", { orgId: ["Required"] });
      const pending = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM learning_resources WHERE submitted_by = $1 AND status = 'PENDING_REVIEW'`, [userId]);
      if (!who.executive && pending[0].n >= PENDING_LIMIT) throw new AppError("RATE_LIMITED", "You have several items waiting for review. Please wait for a decision before adding more.");
      const direct = who.executive;
      const r = await tx.query<{ id: string }>(
        `INSERT INTO learning_resources (title, description, category, kind, youtube_id, body, org_id, submitted_by, status, published_at, reviewed_by, reviewed_at, last_reviewed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, CASE WHEN $10 THEN now() END, CASE WHEN $10 THEN $8::uuid END, CASE WHEN $10 THEN now() END, CASE WHEN $10 THEN now() END) RETURNING id`,
        [input.title, input.description, input.category, input.kind, input.kind === "VIDEO" ? parseYouTubeId(input.url!) : null, input.kind === "ARTICLE" ? input.body : null,
         input.orgId ?? null, userId, direct ? "PUBLISHED" : "PENDING_REVIEW", direct]);
      await writeAudit(tx, { actorUserId: userId, action: direct ? "LEARNING_PUBLISHED" : "LEARNING_SUBMITTED", subjectType: "learning_resource", subjectId: r[0].id, details: { kind: input.kind } });
      return { id: r[0].id, status: (direct ? "PUBLISHED" : "PENDING_REVIEW") as LearningStatus };
    });
  } catch (err) {
    throw fromDbError(err);
  }
}

export const moderationSchema = z.object({
  resourceId: uuid,
  decision: z.enum(["publish", "reject", "archive", "review"]),
  note: z.string().trim().max(1000).optional().transform((v) => (v ? v : null)),
});

/** Executive-only. Publishing or marking reviewed stamps the review date; rejecting requires a reason the submitter can read. */
export async function moderateResource(driver: Driver, userId: string, raw: unknown): Promise<void> {
  const i = parseOrThrow(moderationSchema, raw);
  if (i.decision === "reject" && (!i.note || i.note.length < 5)) throw new AppError("VALIDATION", "Tell the submitter why this was not approved.", { note: ["Required"] });
  try {
    await runIn(driver, { kind: "system" }, async (tx) => {
      await assertPlatformAdmin(tx, userId);
      const cur = await tx.query<{ status: LearningStatus }>(`SELECT status FROM learning_resources WHERE id = $1 FOR UPDATE`, [i.resourceId]);
      if (!cur.length) throw new AppError("NOT_FOUND", "Item not found.");
      const status = cur[0].status;
      const stamp = `reviewed_by = $2, reviewed_at = now(), last_reviewed_at = now(), review_note = $3`;
      if (i.decision === "publish") {
        if (!["PENDING_REVIEW", "ARCHIVED", "DRAFT"].includes(status)) throw new AppError("CONFLICT", "This item cannot be published from its current state.");
        await tx.query(`UPDATE learning_resources SET status = 'PUBLISHED', published_at = now(), ${stamp} WHERE id = $1`, [i.resourceId, userId, i.note]);
      } else if (i.decision === "reject") {
        if (status !== "PENDING_REVIEW") throw new AppError("CONFLICT", "Only items waiting for review can be rejected.");
        await tx.query(`UPDATE learning_resources SET status = 'REJECTED', ${stamp} WHERE id = $1`, [i.resourceId, userId, i.note]);
      } else if (i.decision === "archive") {
        if (status !== "PUBLISHED") throw new AppError("CONFLICT", "Only published items can be archived.");
        await tx.query(`UPDATE learning_resources SET status = 'ARCHIVED', published_at = NULL, ${stamp} WHERE id = $1`, [i.resourceId, userId, i.note]);
      } else {
        if (status !== "PUBLISHED") throw new AppError("CONFLICT", "Only published items need a periodic review.");
        await tx.query(`UPDATE learning_resources SET last_reviewed_at = now(), reviewed_by = $2 WHERE id = $1`, [i.resourceId, userId]);
      }
      await writeAudit(tx, { actorUserId: userId, action: `LEARNING_${i.decision.toUpperCase()}`, subjectType: "learning_resource", subjectId: i.resourceId });
    });
  } catch (err) {
    throw fromDbError(err);
  }
}

export const editSchema = z.object({
  resourceId: uuid,
  title: z.string().trim().min(5).max(140),
  description: z.string().trim().min(10).max(600),
  category: z.enum(LEARNING_CATEGORIES),
  url: z.string().trim().max(300).optional(),
  body: z.string().trim().max(20000).optional(),
});

/** The submitter (or a member of the submitting organization) can fix a rejected or waiting item. Editing published content sends it back for review. */
export async function editResource(driver: Driver, userId: string, raw: unknown): Promise<void> {
  const i = parseOrThrow(editSchema, raw);
  try {
    await runIn(driver, { kind: "system" }, async (tx) => {
      const who = await whoIs(tx, userId);
      const cur = await tx.query<{ kind: "VIDEO" | "ARTICLE"; status: LearningStatus; submitted_by: string; org_id: string | null }>(
        `SELECT kind, status, submitted_by, org_id FROM learning_resources WHERE id = $1 FOR UPDATE`, [i.resourceId]);
      if (!cur.length) throw new AppError("NOT_FOUND", "Item not found.");
      const c = cur[0];
      const mine = c.submitted_by === userId || (c.org_id !== null && who.orgIds.includes(c.org_id));
      if (!who.executive && !mine) throw new AppError("NOT_FOUND", "Item not found.");
      if (c.status === "ARCHIVED") throw new AppError("CONFLICT", "Archived items cannot be edited.");
      let youtubeId: string | null = null;
      if (c.kind === "VIDEO") {
        youtubeId = i.url ? parseYouTubeId(i.url) : null;
        if (!youtubeId) throw new AppError("VALIDATION", "Paste a YouTube link (youtube.com or youtu.be).", { url: ["Not a YouTube link"] });
      } else if (!i.body || i.body.length < 50) {
        throw new AppError("VALIDATION", "Write at least a few sentences (50 characters).", { body: ["Too short"] });
      }
      // Content changes by anyone other than an executive go back to review.
      const nextStatus: LearningStatus = who.executive ? c.status : "PENDING_REVIEW";
      await tx.query(
        `UPDATE learning_resources SET title = $2, description = $3, category = $4, youtube_id = $5, body = $6, status = $7,
                published_at = CASE WHEN $7 = 'PUBLISHED' THEN published_at ELSE NULL END WHERE id = $1`,
        [i.resourceId, i.title, i.description, i.category, youtubeId, c.kind === "ARTICLE" ? i.body : null, nextStatus]);
      await writeAudit(tx, { actorUserId: userId, action: "LEARNING_EDITED", subjectType: "learning_resource", subjectId: i.resourceId });
    });
  } catch (err) {
    throw fromDbError(err);
  }
}

// --------------------------- reads ---------------------------
export type LearningRow = {
  id: string; title: string; description: string; category: LearningCategory; kind: "VIDEO" | "ARTICLE"; youtubeId: string | null; body: string | null;
  status: LearningStatus; reviewNote: string | null; orgName: string | null; submitterEmail?: string; publishedAt: Date | null; lastReviewedAt: Date | null; createdAt: Date;
};
const toRow = (r: Record<string, unknown>): LearningRow => ({
  id: r.id as string, title: r.title as string, description: r.description as string, category: r.category as LearningCategory, kind: r.kind as "VIDEO" | "ARTICLE",
  youtubeId: (r.youtube_id as string | null) ?? null, body: (r.body as string | null) ?? null, status: r.status as LearningStatus, reviewNote: (r.review_note as string | null) ?? null,
  orgName: (r.org_name as string | null) ?? null, submitterEmail: (r.submitter_email as string | undefined) ?? undefined,
  publishedAt: (r.published_at as Date | null) ?? null, lastReviewedAt: (r.last_reviewed_at as Date | null) ?? null, createdAt: r.created_at as Date,
});

/** Executive moderation queue (default: items waiting for review). */
export async function listForModeration(driver: Driver, userId: string, status: unknown = "PENDING_REVIEW"): Promise<LearningRow[]> {
  const st = parseOrThrow(z.enum(LEARNING_STATUSES).or(z.literal("").transform(() => undefined)).optional(), status);
  return runIn(driver, { kind: "system" }, async (tx) => {
    await assertPlatformAdmin(tx, userId);
    const r = await tx.query<Record<string, unknown>>(
      `SELECT l.*, o.display_name AS org_name, u.email AS submitter_email FROM learning_resources l
         LEFT JOIN organizations o ON o.id = l.org_id JOIN users u ON u.id = l.submitted_by
        WHERE ($1::text IS NULL OR l.status = $1) ORDER BY l.created_at DESC LIMIT 200`, [st ?? null]);
    return r.map(toRow);
  });
}

/** What the signed-in person submitted, or their organizations did (row-level security does the scoping). Executives use the moderation queue. */
export async function listMine(driver: Driver, userId: string): Promise<LearningRow[]> {
  const who = await runIn(driver, { kind: "system" }, async (tx) => {
    const w = await whoIs(tx, userId);
    if (!w.executive && w.countyIds.length === 0 && w.orgIds.length === 0) throw new AppError("FORBIDDEN", "You do not have access to learning materials.");
    if ((w.executive || w.countyIds.length) && privilegedMfaRequired()) {
      const r = await tx.query<{ mfa: boolean }>(`SELECT mfa_enrolled_at IS NOT NULL AS mfa FROM users WHERE id = $1`, [userId]);
      if (!r[0]?.mfa) throw new AppError("FORBIDDEN", "Multi-factor authentication is required.");
    }
    return w;
  });
  return runIn(driver, { kind: "viewer", userId }, async (tx) => {
    const r = await tx.query<Record<string, unknown>>(
      `SELECT l.*, o.display_name AS org_name FROM learning_resources l LEFT JOIN organizations o ON o.id = l.org_id
        WHERE l.submitted_by = ics.viewer_id() OR (l.org_id IS NOT NULL AND l.org_id = ANY (ics.viewer_approved_org_ids()))
        ORDER BY l.created_at DESC LIMIT 200`);
    void who;
    return r.map(toRow);
  });
}

/** One item for editing: the submitter, a member of the submitting organization, or an executive. Anyone else gets NOT_FOUND. */
export async function getMine(driver: Driver, userId: string, id: string): Promise<LearningRow> {
  if (!uuid.safeParse(id).success) throw new AppError("NOT_FOUND", "Item not found.");
  return runIn(driver, { kind: "system" }, async (tx) => {
    const who = await whoIs(tx, userId);
    const r = await tx.query<Record<string, unknown>>(
      `SELECT l.*, o.display_name AS org_name FROM learning_resources l LEFT JOIN organizations o ON o.id = l.org_id WHERE l.id = $1`, [id]);
    const row = r[0];
    const mine = row && (row.submitted_by === userId || (row.org_id !== null && who.orgIds.includes(row.org_id as string)));
    if (!row || !(who.executive || mine)) throw new AppError("NOT_FOUND", "Item not found.");
    return toRow(row);
  });
}

// --------------------------- public ---------------------------
export type PublicLearning = { id: string; title: string; description: string; category: LearningCategory; kind: "VIDEO" | "ARTICLE"; youtubeId: string | null; body: string | null; orgName: string | null; publishedAt: Date; lastReviewedAt: Date | null };
const toPublic = (r: Record<string, unknown>): PublicLearning => ({
  id: r.id as string, title: r.title as string, description: r.description as string, category: r.category as LearningCategory, kind: r.kind as "VIDEO" | "ARTICLE",
  youtubeId: (r.youtube_id as string | null) ?? null, body: (r.body as string | null) ?? null, orgName: (r.org_name as string | null) ?? null,
  publishedAt: r.published_at as Date, lastReviewedAt: (r.last_reviewed_at as Date | null) ?? null,
});

export async function listPublicResources(driver: Driver, filter: { category?: string; q?: string } = {}): Promise<PublicLearning[]> {
  const category = (LEARNING_CATEGORIES as readonly string[]).includes(filter.category ?? "") ? filter.category! : null;
  const q = filter.q?.trim().slice(0, 80) || null;
  return runIn(driver, { kind: "anon" }, async (tx) => {
    const r = await tx.query<Record<string, unknown>>(
      `SELECT id, title, description, category, kind, youtube_id, NULL::text AS body, org_name, published_at, last_reviewed_at FROM public_learning_resources
        WHERE ($1::text IS NULL OR category = $1) AND ($2::text IS NULL OR title ILIKE '%' || $2 || '%' OR description ILIKE '%' || $2 || '%')
        ORDER BY published_at DESC LIMIT 200`, [category, q]);
    return r.map(toPublic);
  });
}

export async function getPublicResource(driver: Driver, id: string): Promise<PublicLearning | null> {
  if (!uuid.safeParse(id).success) return null;
  return runIn(driver, { kind: "anon" }, async (tx) => {
    const r = await tx.query<Record<string, unknown>>(`SELECT * FROM public_learning_resources WHERE id = $1`, [id]);
    return r.length ? toPublic(r[0]) : null;
  });
}
