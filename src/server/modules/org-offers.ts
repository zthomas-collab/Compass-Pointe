import { z } from "zod";
import type { Driver, Tx } from "../db";
import { runIn } from "../db/context";
import { AppError, fromDbError } from "../errors";
import { parseOrThrow } from "./identity";
import {
  OFFER_PAGE_SIZE, OFFER_STATUSES, offerTransitionSchema, readOfferDetail, readOrgOfferSummaries, setActor,
  type OfferDetail, type OfferStatus, type OfferSummary,
} from "./offers";
import { appBaseUrl, brandName, enqueueEmail, writeAudit } from "./shared";

/**
 * The organization's side of offers a giver sent to it. Only active ORG_ADMIN and EDITOR members of an eligible
 * organization (approved, publishing, approved public profile, directory consent) may see or act on them; anyone else
 * gets NOT_FOUND. Reads go through RLS (migration 0017); writes re-check access and act as actor_role 'ORG'.
 */

export const ORG_OFFER_MOVES: [OfferStatus, OfferStatus][] = [
  ["MATCHED", "ACCEPTED"], ["MATCHED", "DECLINED"], ["ACCEPTED", "SCHEDULED"], ["ACCEPTED", "CANCELED"],
  ["SCHEDULED", "COMPLETED"], ["SCHEDULED", "CANCELED"],
];
const orgNext = (from: OfferStatus): OfferStatus[] => ORG_OFFER_MOVES.filter(([f]) => f === from).map(([, t]) => t);

const uuid = z.string().uuid();
const notFound = () => new AppError("NOT_FOUND", "Offer not found.");

export async function assertOrgOfferAccess(tx: Tx, userId: string, orgId: string): Promise<void> {
  if (!uuid.safeParse(orgId).success) throw notFound();
  const r = await tx.query(
    `SELECT 1 FROM organization_memberships m JOIN users u ON u.id = m.user_id
      WHERE m.org_id = $1 AND m.user_id = $2 AND m.status = 'ACTIVE' AND u.status = 'ACTIVE' AND m.role IN ('ORG_ADMIN','EDITOR')
        AND ics.org_is_eligible($1)`,
    [orgId, userId],
  );
  if (!r.length) throw notFound();
}

const listSchema = z.object({
  status: z.enum(OFFER_STATUSES).optional().or(z.literal("").transform(() => undefined)),
  page: z.coerce.number().int().min(1).max(500).default(1),
});

export async function listOrgOffers(
  driver: Driver, userId: string, orgId: string, raw: unknown = {},
): Promise<{ rows: OfferSummary[]; page: number; hasMore: boolean; counts: Record<string, number> }> {
  const f = parseOrThrow(listSchema, raw);
  await runIn(driver, { kind: "system" }, (tx) => assertOrgOfferAccess(tx, userId, orgId));
  return runIn(driver, { kind: "viewer", userId }, async (tx) => {
    const rows = await readOrgOfferSummaries(tx, orgId, f.status ?? null, f.page);
    const c = await tx.query<{ status: string; n: number }>(
      `SELECT status, count(*)::int AS n FROM contribution_offers WHERE organization_id = $1 GROUP BY status`, [orgId]);
    return {
      rows: rows.slice(0, OFFER_PAGE_SIZE), page: f.page, hasMore: rows.length > OFFER_PAGE_SIZE,
      counts: Object.fromEntries(c.map((x) => [x.status, x.n])),
    };
  });
}

/** Full detail including the giver's contact details. Opening it is audited. */
export async function getOrgOffer(driver: Driver, userId: string, orgId: string, offerId: string): Promise<OfferDetail> {
  if (!uuid.safeParse(offerId).success) throw notFound();
  await runIn(driver, { kind: "system" }, (tx) => assertOrgOfferAccess(tx, userId, orgId));
  const d = await runIn(driver, { kind: "viewer", userId }, (tx) => readOfferDetail(tx, offerId));
  if (!d || d.recipientOrgId !== orgId) throw notFound();
  await runIn(driver, { kind: "system" }, (tx) =>
    writeAudit(tx, { actorUserId: userId, actorOrgId: orgId, action: "OFFER_VIEWED", subjectType: "contribution_offer", subjectId: offerId }));
  return { ...d, allowedNext: orgNext(d.status), canAssignCounty: false };
}

export async function transitionOrgOffer(driver: Driver, userId: string, orgId: string, raw: unknown): Promise<void> {
  const input = parseOrThrow(offerTransitionSchema, raw);
  if (["DECLINED", "CANCELED"].includes(input.to) && !input.note) {
    throw new AppError("VALIDATION", "Add a short reason.", { note: ["Required"] });
  }
  try {
    await runIn(driver, { kind: "system" }, async (tx) => {
      await assertOrgOfferAccess(tx, userId, orgId);
      const o = await tx.query<{ status: OfferStatus; email: string; reference: string; org_name: string }>(
        `SELECT o.status, o.email, o.reference, g.display_name AS org_name
           FROM contribution_offers o JOIN organizations g ON g.id = o.organization_id
          WHERE o.id = $1 AND o.organization_id = $2 FOR UPDATE OF o`,
        [input.offerId, orgId],
      );
      if (!o.length) throw notFound();
      if (!orgNext(o[0].status).includes(input.to)) throw new AppError("CONFLICT", "That status change is not allowed from the current state.");
      await setActor(tx, userId, "ORG", input.note);
      await tx.query(`UPDATE contribution_offers SET status = $2 WHERE id = $1`, [input.offerId, input.to]);
      await writeAudit(tx, {
        actorUserId: userId, actorOrgId: orgId, action: `OFFER_${input.to}`, subjectType: "contribution_offer", subjectId: input.offerId,
        details: { from: o[0].status },
      });
      const { email, reference, org_name: orgName } = o[0];
      if (input.to === "ACCEPTED") {
        await enqueueEmail(tx, {
          kind: "OFFER_ACCEPTED", to: email, subject: `${brandName()}: ${orgName} accepted your offer ${reference}`,
          body: `${orgName} accepted your offer ${reference} and will contact you to arrange it.\n\nThank you for helping.`,
        });
      } else if (input.to === "DECLINED") {
        // The organization's reason stays internal; the giver gets a next step instead.
        await enqueueEmail(tx, {
          kind: "OFFER_DECLINED", to: email, subject: `${brandName()}: about your offer ${reference}`,
          body: `${orgName} can't use your offer ${reference} right now. Thank you for offering.\n\nOther organizations working this disaster: ${appBaseUrl()}/volunteer`,
        });
      }
    });
  } catch (err) {
    throw fromDbError(err);
  }
}

export async function addOrgOfferNote(driver: Driver, userId: string, orgId: string, offerId: unknown, note: unknown): Promise<void> {
  const oid = parseOrThrow(uuid, offerId);
  const text = parseOrThrow(z.string().trim().min(2, "Write a short note").max(2000), note);
  try {
    await runIn(driver, { kind: "system" }, async (tx) => {
      await assertOrgOfferAccess(tx, userId, orgId);
      const o = await tx.query(`SELECT 1 FROM contribution_offers WHERE id = $1 AND organization_id = $2`, [oid, orgId]);
      if (!o.length) throw notFound();
      await tx.query(
        `INSERT INTO contribution_offer_events (offer_id, actor_user_id, actor_role, event_type, note) VALUES ($1, $2, 'ORG', 'NOTE', $3)`, [oid, userId, text]);
      await writeAudit(tx, { actorUserId: userId, actorOrgId: orgId, action: "OFFER_NOTE_ADDED", subjectType: "contribution_offer", subjectId: oid });
    });
  } catch (err) {
    throw fromDbError(err);
  }
}

