import { z } from "zod";
import type { OfferType } from "@/lib/offers";
import type { Driver } from "../db";
import { runIn } from "../db/context";
import { AppError, fromDbError } from "../errors";
import { loadAccess } from "./access";
import { parseOrThrow } from "./identity";
import { writeAudit } from "./shared";

/**
 * Giving to a specific organization: administrator review of an organization's donation link, and the public
 * "give target" the donate form uses. The link is shown publicly only while APPROVED; the database resets it to
 * PENDING whenever the organization changes it (migration 0017).
 */

const uuid = z.string().uuid();

export const donationLinkReviewSchema = z
  .object({
    orgId: uuid,
    decision: z.enum(["APPROVED", "REJECTED"]),
    note: z.string().trim().max(2000).optional().transform((v) => v ?? ""),
    /** The exact link the administrator looked at; a decision on a link that has since changed is refused. */
    url: z.string().trim().min(1).max(2000),
  })
  .refine((v) => v.decision !== "REJECTED" || v.note.length >= 5, { message: "Say why the link was not approved", path: ["note"] });

/** Executives review any organization's link; a county administrator only those of organizations serving their counties. */
export async function reviewDonationLink(driver: Driver, actorId: string, raw: unknown): Promise<void> {
  const input = parseOrThrow(donationLinkReviewSchema, raw);
  try {
    await runIn(driver, { kind: "system" }, async (tx) => {
      const access = await loadAccess(tx, actorId);
      const org = await tx.query<{ status: string; url: string | null; serves: boolean }>(
        `SELECT o.donation_url_status AS status, o.donation_url AS url,
                EXISTS (SELECT 1 FROM organization_counties oc WHERE oc.org_id = o.id AND oc.county_id = ANY($2::uuid[])) AS serves
           FROM organizations o WHERE o.id = $1 FOR UPDATE`,
        [input.orgId, access.countyIds],
      );
      if (!org.length) throw new AppError("NOT_FOUND", "Organization not found.");
      if (!access.executive && !org[0].serves) throw new AppError("FORBIDDEN", "You do not administer a county this organization serves.");
      if (org[0].status !== "PENDING") throw new AppError("CONFLICT", "This link is not waiting for review.");
      if (org[0].url !== input.url) throw new AppError("CONFLICT", "The link changed since you opened this page. Review it again.");
      await tx.query(
        `UPDATE organizations SET donation_url_status = $2, donation_url_reviewed_by = $3, donation_url_reviewed_at = now(),
                donation_url_review_note = $4 WHERE id = $1`,
        [input.orgId, input.decision, actorId, input.note || null],
      );
      await writeAudit(tx, {
        actorUserId: actorId, actorOrgId: input.orgId, action: `ORG_DONATION_LINK_${input.decision}`,
        subjectType: "organization", subjectId: input.orgId,
      });
    });
  } catch (err) {
    throw fromDbError(err);
  }
}

export type DonationLinkReviewRow = { orgId: string; displayName: string; url: string; host: string; countiesServed: string[] };

export async function listDonationLinksForReview(driver: Driver, actorId: string): Promise<DonationLinkReviewRow[]> {
  return runIn(driver, { kind: "system" }, async (tx) => {
    const access = await loadAccess(tx, actorId);
    if (!access.executive && access.countyIds.length === 0) throw new AppError("FORBIDDEN", "Administrator role required.");
    const rows = await tx.query<{ id: string; display_name: string; donation_url: string; counties: string[] }>(
      `SELECT o.id, o.display_name, o.donation_url,
              coalesce((SELECT array_agg(c.name || ', ' || c.state ORDER BY c.state, c.name)
                          FROM organization_counties oc JOIN counties c ON c.id = oc.county_id WHERE oc.org_id = o.id), '{}') AS counties
         FROM organizations o
        WHERE o.donation_url_status = 'PENDING'
          AND ($1::boolean OR EXISTS (SELECT 1 FROM organization_counties oc WHERE oc.org_id = o.id AND oc.county_id = ANY($2::uuid[])))
        ORDER BY o.display_name, o.id
        LIMIT 300`,
      [access.executive, access.countyIds],
    );
    return rows.map((r) => ({
      orgId: r.id, displayName: r.display_name, url: r.donation_url, host: new URL(r.donation_url).hostname, countiesServed: r.counties,
    }));
  });
}

export type GiveTarget = { orgId: string; displayName: string; acceptedOfferTypes: OfferType[]; donationUrl: string | null };

/** An organization a giver can send an offer to: eligible (public profile) and accepting at least one kind of giving. */
export async function getGiveTarget(driver: Driver, orgId: unknown): Promise<GiveTarget | null> {
  const id = uuid.safeParse(orgId);
  if (!id.success) return null;
  const rows = await runIn(driver, { kind: "anon" }, (tx) =>
    tx.query<{ id: string; display_name: string; accepted_offer_types: OfferType[]; donation_url: string | null }>(
      `SELECT id, display_name, accepted_offer_types, donation_url FROM public_contacts WHERE id = $1`, [id.data]),
  );
  const r = rows[0];
  if (!r || r.accepted_offer_types.length === 0) return null;
  return { orgId: r.id, displayName: r.display_name, acceptedOfferTypes: r.accepted_offer_types, donationUrl: r.donation_url };
}
