import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver, Tx } from "@/server/db";
import { runIn } from "@/server/db/context";
import { assignCountyAdmin, createCounty } from "@/server/modules/counties";
import { getOffer, submitOffer } from "@/server/modules/offers";
import { addOrgOfferNote, getOrgOffer, listOrgOffers, transitionOrgOffer } from "@/server/modules/org-offers";
import { freshDb } from "./helpers/db";
import { grantRole, makeOrg, makeUser } from "./helpers/fixtures";

/** The organization's side of offers sent to it. */

let db: Driver;
let exec: string, adminA: string, gEd: string, gView: string, oEd: string, gGone: string;
let countyA: string, orgG: string, orgO: string;
const sys = <T>(fn: (tx: Tx) => Promise<T>) => runIn(db, { kind: "system" }, fn);
const code = (p: Promise<unknown>) => p.then(() => "OK", (e) => (e as { code?: string }).code ?? "ERR");
let seq = 0;
const send = () =>
  submitOffer(db, {
    contributorName: "Pat Giver", email: `giver-${seq++}@example.test`, zip: "28801", contributionType: "FOOD",
    description: "Canned food for the pantry.", consentContact: "on", consentShare: "on", organizationId: orgG,
  });

beforeAll(async () => {
  db = await freshDb();
  [exec, adminA, gEd, gView, oEd, gGone] = await Promise.all(["exec", "admin-a", "g-ed", "g-view", "o-ed", "g-gone"].map((n) => makeUser(db, `${n}@example.test`)));
  await grantRole(db, exec, "PLATFORM_ADMIN");
  countyA = await createCounty(db, exec, { name: "Buncombe", state: "NC" });
  await assignCountyAdmin(db, exec, { email: "admin-a@example.test", countyId: countyA, reason: "County A coordinator" });
  orgG = await makeOrg(db, {
    name: "Giving Org", consent: true,
    members: [{ userId: gEd, role: "EDITOR" }, { userId: gView, role: "VIEWER" }, { userId: gGone, role: "ORG_ADMIN" }],
  });
  orgO = await makeOrg(db, { name: "Other Org", consent: true, members: [{ userId: oEd, role: "ORG_ADMIN" }] });
  await sys((tx) => tx.query(`INSERT INTO organization_counties (org_id, county_id) VALUES ($1, $2)`, [orgG, countyA]));
  await sys((tx) => tx.query(`INSERT INTO organization_accepted_offer_types (org_id, offer_type) VALUES ($1, 'FOOD')`, [orgG]));
});
afterAll(async () => db?.close());

describe("organization offers", () => {
  it("editor lists and opens only own org offers", async () => {
    const o = await send();
    const list = await listOrgOffers(db, gEd, orgG);
    expect(list.rows.map((r) => r.id)).toContain(o.id);
    expect(list.counts.MATCHED).toBeGreaterThan(0);
    expect(await code(listOrgOffers(db, oEd, orgG))).toBe("NOT_FOUND");
    expect(await code(listOrgOffers(db, gView, orgG))).toBe("NOT_FOUND");
    expect(await code(getOrgOffer(db, oEd, orgO, o.id))).toBe("NOT_FOUND"); // another org's id in its own space

    const d = await getOrgOffer(db, gEd, orgG, o.id);
    expect(d).toMatchObject({ id: o.id, status: "MATCHED", email: expect.stringContaining("@example.test"), contributorName: "Pat Giver" });
    expect(d.allowedNext.sort()).toEqual(["ACCEPTED", "DECLINED"]);
    const audit = await sys((tx) => tx.query<{ actor_org_id: string }>(
      `SELECT actor_org_id FROM audit_logs WHERE action = 'OFFER_VIEWED' AND subject_id = $1`, [o.id]));
    expect(audit).toEqual([{ actor_org_id: orgG }]);
  });

  it("org moves through accept, schedule, complete", async () => {
    const o = await send();
    await transitionOrgOffer(db, gEd, orgG, { offerId: o.id, to: "ACCEPTED" });
    await transitionOrgOffer(db, gEd, orgG, { offerId: o.id, to: "SCHEDULED" });
    await transitionOrgOffer(db, gEd, orgG, { offerId: o.id, to: "COMPLETED" });
    const ev = await sys((tx) => tx.query<{ to_status: string; actor_role: string }>(
      `SELECT to_status, actor_role FROM contribution_offer_events WHERE offer_id = $1 AND event_type = 'STATUS_CHANGED' ORDER BY created_at, id`, [o.id]));
    expect(ev).toEqual([
      { to_status: "ACCEPTED", actor_role: "ORG" }, { to_status: "SCHEDULED", actor_role: "ORG" }, { to_status: "COMPLETED", actor_role: "ORG" },
    ]);
    const accepted = await sys((tx) => tx.query<{ body_text: string }>(
      `SELECT body_text FROM notification_jobs WHERE kind = 'OFFER_ACCEPTED' AND body_text LIKE $1`, [`%${o.reference}%`]));
    expect(accepted).toHaveLength(1);
    expect(accepted[0].body_text).toContain("Giving Org");
    // A note from the organization is recorded as ORG.
    await addOrgOfferNote(db, gEd, orgG, o.id, "Picked up Tuesday.");
    const note = await sys((tx) => tx.query<{ actor_role: string }>(`SELECT actor_role FROM contribution_offer_events WHERE offer_id = $1 AND event_type = 'NOTE'`, [o.id]));
    expect(note).toEqual([{ actor_role: "ORG" }]);
  });

  it("decline needs a reason and emails the giver without it", async () => {
    const o = await send();
    expect(await code(transitionOrgOffer(db, gEd, orgG, { offerId: o.id, to: "DECLINED" }))).toBe("VALIDATION");
    await transitionOrgOffer(db, gEd, orgG, { offerId: o.id, to: "DECLINED", note: "PRIVATE-REASON" });
    const j = await sys((tx) => tx.query<{ body_text: string }>(
      `SELECT body_text FROM notification_jobs WHERE kind = 'OFFER_DECLINED' AND body_text LIKE $1`, [`%${o.reference}%`]));
    expect(j).toHaveLength(1);
    expect(j[0].body_text).not.toContain("PRIVATE-REASON");
    expect(j[0].body_text).toContain("/volunteer");
  });

  it("org cannot send back to triage or skip steps", async () => {
    const o = await send();
    expect(await code(transitionOrgOffer(db, gEd, orgG, { offerId: o.id, to: "REVIEWED" }))).toBe("CONFLICT");
    expect(await code(transitionOrgOffer(db, gEd, orgG, { offerId: o.id, to: "COMPLETED" }))).toBe("CONFLICT");
    expect(await code(transitionOrgOffer(db, gView, orgG, { offerId: o.id, to: "ACCEPTED" }))).toBe("NOT_FOUND");
  });

  it("ineligible org loses access", async () => {
    const o = await send();
    await sys((tx) => tx.query(`UPDATE organizations SET profile_status = 'HIDDEN' WHERE id = $1`, [orgG]));
    expect(await code(listOrgOffers(db, gEd, orgG))).toBe("NOT_FOUND");
    expect(await code(getOrgOffer(db, gEd, orgG, o.id))).toBe("NOT_FOUND");
    expect(await code(transitionOrgOffer(db, gEd, orgG, { offerId: o.id, to: "ACCEPTED" }))).toBe("NOT_FOUND");
    expect((await getOffer(db, adminA, o.id)).id).toBe(o.id);
    await sys((tx) => tx.query(`UPDATE organizations SET profile_status = 'APPROVED' WHERE id = $1`, [orgG]));
    expect(await code(listOrgOffers(db, gEd, orgG))).toBe("OK");
  });

  it("removed member loses access", async () => {
    const o = await send();
    expect(await code(getOrgOffer(db, gGone, orgG, o.id))).toBe("OK");
    await sys((tx) => tx.query(`UPDATE organization_memberships SET status = 'REVOKED' WHERE user_id = $1`, [gGone]));
    expect(await code(getOrgOffer(db, gGone, orgG, o.id))).toBe("NOT_FOUND");
    expect(await code(listOrgOffers(db, gGone, orgG))).toBe("NOT_FOUND");
  });
});
