import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver, Tx } from "@/server/db";
import { runIn } from "@/server/db/context";
import { assignCountyAdmin, createCounty } from "@/server/modules/counties";
import { listOffers, setNotificationEmail, submitOffer, transitionOffer } from "@/server/modules/offers";
import { freshDb } from "./helpers/db";
import { grantRole, makeOrg, makeUser } from "./helpers/fixtures";

/** Offers a giver sends to a specific organization: intake and the staff side. */

let db: Driver;
let exec: string, adminA: string, adminB: string, adminC: string, gEd: string;
let countyA: string, countyB: string, countyC: string, orgG: string;
const sys = <T>(fn: (tx: Tx) => Promise<T>) => runIn(db, { kind: "system" }, fn);
const code = (p: Promise<unknown>) => p.then(() => "OK", (e) => (e as { code?: string }).code ?? "ERR");
let seq = 0;
const offer = (over: Record<string, unknown> = {}) => ({
  contributorName: "Pat Giver", email: `giver-${seq++}@example.test`, phone: "(803) 555-0188", zip: "29801", contributionType: "DRINKING_WATER",
  quantity: "200", unit: "cases", description: "Palletized bottled water ready for pickup.", consentContact: "on", ...over,
});
const directed = (over: Record<string, unknown> = {}) => offer({ organizationId: orgG, consentShare: "on", ...over });
const jobs = (kind: string, like: string) =>
  sys((tx) => tx.query<{ recipient_email: string; body_text: string; subject: string }>(
    `SELECT recipient_email, body_text, subject FROM notification_jobs WHERE kind = $1 AND (body_text LIKE $2 OR subject LIKE $2)`, [kind, `%${like}%`]));

beforeAll(async () => {
  db = await freshDb();
  [exec, adminA, adminB, adminC, gEd] = await Promise.all(["exec", "admin-a", "admin-b", "admin-c", "g-ed"].map((n) => makeUser(db, `${n}@example.test`)));
  await grantRole(db, exec, "PLATFORM_ADMIN");
  countyA = await createCounty(db, exec, { name: "Buncombe", state: "NC" });
  countyB = await createCounty(db, exec, { name: "Aiken", state: "SC" });
  countyC = await createCounty(db, exec, { name: "Henderson", state: "NC" });
  await assignCountyAdmin(db, exec, { email: "admin-a@example.test", countyId: countyA, reason: "County A coordinator" });
  await assignCountyAdmin(db, exec, { email: "admin-b@example.test", countyId: countyB, reason: "County B coordinator" });
  await assignCountyAdmin(db, exec, { email: "admin-c@example.test", countyId: countyC, reason: "County C coordinator" });
  await sys((tx) => tx.query(`UPDATE platform_settings SET value = to_jsonb('stale'::text) WHERE key = 'zip_county_sha256'`));
  const { syncZipCounty } = await import("@/server/modules/zipcounty");
  await syncZipCounty(db);
  orgG = await makeOrg(db, { name: "Giving Org", consent: true, members: [{ userId: gEd, role: "EDITOR" }] });
  await sys((tx) => tx.query(`INSERT INTO organization_counties (org_id, county_id) VALUES ($1, $2)`, [orgG, countyA]));
  await sys((tx) => tx.query(`INSERT INTO organization_accepted_offer_types (org_id, offer_type) VALUES ($1, 'DRINKING_WATER')`, [orgG]));
  await setNotificationEmail(db, exec, { email: "intake@crisis.example" });
});
afterAll(async () => db?.close());

describe("directed intake", () => {
  it("directed offer is MATCHED and notifies the org, not central", async () => {
    const before = await sys((tx) => tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM notification_jobs WHERE kind = 'OFFER_NEW'`));
    const o = await submitOffer(db, directed({ contributorName: "SECRET-NAME-MARKER" }));
    expect(o.organizationName).toContain("Giving Org");
    const row = await sys((tx) => tx.query<{ status: string; organization_id: string; consent_share: boolean; county_id: string }>(
      `SELECT status, organization_id, consent_share, county_id FROM contribution_offers WHERE id = $1`, [o.id]));
    expect(row[0]).toMatchObject({ status: "MATCHED", organization_id: orgG, consent_share: true, county_id: countyB });

    const orgJobs = await jobs("OFFER_NEW_ORG", o.reference);
    expect(orgJobs).toHaveLength(1);
    expect(orgJobs[0].recipient_email).toBe("private-contact@example.test");
    expect(orgJobs[0].body_text).toContain(`/dashboard/orgs/${orgG}/offers/${o.id}`);
    expect(orgJobs[0].body_text).not.toContain("SECRET-NAME-MARKER");
    expect(orgJobs[0].body_text).not.toContain("555-0188");

    const after = await sys((tx) => tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM notification_jobs WHERE kind = 'OFFER_NEW'`));
    expect(after[0].n).toBe(before[0].n);
    const receipt = await jobs("OFFER_RECEIPT", o.reference);
    expect(receipt[0].body_text).toContain("Giving Org");
  });

  it("central offers are unchanged", async () => {
    const o = await submitOffer(db, offer());
    expect(o.organizationName).toBeNull();
    const row = await sys((tx) => tx.query<{ status: string }>(`SELECT status FROM contribution_offers WHERE id = $1`, [o.id]));
    expect(row[0].status).toBe("SUBMITTED");
    expect(await jobs("OFFER_NEW", o.reference)).toHaveLength(1);
  });

  it("directed offer refuses unaccepted type, ineligible org, missing consent", async () => {
    expect(await code(submitOffer(db, directed({ contributionType: "FOOD" })))).toBe("VALIDATION");
    expect(await code(submitOffer(db, directed({ consentShare: "" })))).toBe("VALIDATION");
    await sys((tx) => tx.query(`UPDATE organizations SET publication_suspended = true WHERE id = $1`, [orgG]));
    expect(await code(submitOffer(db, directed()))).toBe("VALIDATION");
    await sys((tx) => tx.query(`UPDATE organizations SET publication_suspended = false WHERE id = $1`, [orgG]));
    expect(await code(submitOffer(db, directed({ organizationId: "00000000-0000-0000-0000-000000000000" })))).toBe("VALIDATION");
  });

  it("rate limit spans destinations", async () => {
    const email = "spans@example.test";
    await submitOffer(db, offer({ email }));
    await submitOffer(db, offer({ email }));
    await submitOffer(db, directed({ email }));
    expect(await code(submitOffer(db, directed({ email })))).toBe("RATE_LIMITED");
  });
});

describe("staff side of directed offers", () => {
  it("staff cannot accept for the org", async () => {
    const o = await submitOffer(db, directed());
    expect(await code(transitionOffer(db, adminA, { offerId: o.id, to: "ACCEPTED" }))).toBe("CONFLICT");
    expect(await code(transitionOffer(db, exec, { offerId: o.id, to: "DECLINED", note: "No" }))).toBe("CONFLICT");
  });

  it("rescue clears the org", async () => {
    const o = await submitOffer(db, directed());
    await transitionOffer(db, adminA, { offerId: o.id, to: "REVIEWED", note: "They are full" });
    const row = await sys((tx) => tx.query<{ organization_id: string | null; status: string; consent_share: boolean }>(
      `SELECT organization_id, status, consent_share FROM contribution_offers WHERE id = $1`, [o.id]));
    // Consent was to share with that one organization, so it does not carry over to central triage.
    expect(row[0]).toEqual({ organization_id: null, status: "REVIEWED", consent_share: false });
    const ev = await sys((tx) => tx.query<{ note: string }>(
      `SELECT note FROM contribution_offer_events WHERE offer_id = $1 AND event_type = 'STATUS_CHANGED'`, [o.id]));
    expect(ev[0].note).toContain("Giving Org");
    expect(ev[0].note).toContain(orgG);
    expect(ev[0].note).toContain("They are full");
    expect(ev[0].note).toContain("consent to share was for that organization only");
    const seen = await runIn(db, { kind: "viewer", userId: gEd }, (tx) => tx.query(`SELECT 1 FROM contribution_offers WHERE id = $1`, [o.id]));
    expect(seen).toHaveLength(0);
  });

  it("staff may cancel a directed offer with a reason", async () => {
    const o = await submitOffer(db, directed());
    await transitionOffer(db, exec, { offerId: o.id, to: "CANCELED", note: "Spam" });
    const row = await sys((tx) => tx.query<{ status: string }>(`SELECT status FROM contribution_offers WHERE id = $1`, [o.id]));
    expect(row[0].status).toBe("CANCELED");
  });

  it("rescue scope", async () => {
    const o = await submitOffer(db, directed());
    expect(await code(transitionOffer(db, adminC, { offerId: o.id, to: "REVIEWED" }))).toBe("NOT_FOUND");
    expect(await code(transitionOffer(db, adminB, { offerId: o.id, to: "REVIEWED" }))).toBe("OK"); // the giver's county
  });

  it("listOffers destination filter", async () => {
    const o = await submitOffer(db, directed());
    const org = await listOffers(db, adminA, { destination: "org" });
    expect(org.rows.length).toBeGreaterThan(0);
    expect(org.rows.every((r) => r.recipientOrgId === orgG)).toBe(true);
    expect(org.rows.find((r) => r.id === o.id)?.recipientOrgName).toContain("Giving Org");
    const central = await listOffers(db, exec, { destination: "central" });
    expect(central.rows.every((r) => r.recipientOrgId === null)).toBe(true);
    expect(central.rows.length).toBeGreaterThan(0);
  });
});
