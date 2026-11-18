import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver, Tx } from "@/server/db";
import { runIn } from "@/server/db/context";
import { assignCountyAdmin, createCounty } from "@/server/modules/counties";
import { freshDb } from "./helpers/db";
import { grantRole, makeOrg, makeUser } from "./helpers/fixtures";

/** Migration 0017: org-directed offers, donation link approval, accepted offer types. Database rules only. */

let db: Driver;
let exec: string, adminA: string, adminB: string, gEd: string, gView: string, oEd: string;
let countyA: string, countyB: string, orgG: string, orgO: string;
const sys = <T>(fn: (tx: Tx) => Promise<T>) => runIn(db, { kind: "system" }, fn);
const asViewer = <T>(userId: string, fn: (tx: Tx) => Promise<T>) => runIn(db, { kind: "viewer", userId }, fn);
const asAnon = <T>(fn: (tx: Tx) => Promise<T>) => runIn(db, { kind: "anon" }, fn);
const pgCode = (p: Promise<unknown>) => p.then(() => "OK", (e) => (e as { code?: string }).code ?? "ERR");
let seq = 0;

async function insertOffer(over: { organizationId?: string | null; countyId?: string | null; consentShare?: boolean; status?: string } = {}): Promise<string> {
  const r = await sys((tx) =>
    tx.query<{ id: string }>(
      `INSERT INTO contribution_offers (contributor_name, email, zip, county_id, contribution_type, description, consent_contact, consent_share,
                                        organization_id, status)
       VALUES ('[TEST] Giver', $1, '29801', $2, 'DRINKING_WATER', 'Bottled water for the shelter.', true, $3, $4, $5) RETURNING id`,
      [`giver-${seq++}@example.test`, over.countyId === undefined ? countyB : over.countyId, over.consentShare ?? true,
       over.organizationId === undefined ? orgG : over.organizationId, over.status ?? "MATCHED"],
    ),
  );
  return r[0].id;
}
const visible = (userId: string, offerId: string) =>
  asViewer(userId, (tx) => tx.query(`SELECT 1 FROM contribution_offers WHERE id = $1`, [offerId])).then((r) => r.length === 1);

/** Runs an offer UPDATE as a given actor (what the services do before every status change). */
const asActor = (actorId: string | null, role: string, sql: string, params: unknown[]) =>
  sys(async (tx) => {
    await tx.query(`SELECT set_config('ics.actor_id', $1, true), set_config('ics.actor_role', $2, true)`, [actorId ?? "", role]);
    return tx.query(sql, params);
  });

beforeAll(async () => {
  db = await freshDb();
  [exec, adminA, adminB, gEd, gView, oEd] = await Promise.all(
    ["exec", "admin-a", "admin-b", "g-ed", "g-view", "o-ed"].map((n) => makeUser(db, `${n}@example.test`)));
  await grantRole(db, exec, "PLATFORM_ADMIN");
  countyA = await createCounty(db, exec, { name: "Buncombe", state: "NC" });
  countyB = await createCounty(db, exec, { name: "Aiken", state: "SC" });
  await assignCountyAdmin(db, exec, { email: "admin-a@example.test", countyId: countyA, reason: "County A coordinator" });
  await assignCountyAdmin(db, exec, { email: "admin-b@example.test", countyId: countyB, reason: "County B coordinator" });
  orgG = await makeOrg(db, { name: "Giving Org", consent: true, members: [{ userId: gEd, role: "EDITOR" }, { userId: gView, role: "VIEWER" }] });
  orgO = await makeOrg(db, { name: "Other Org", consent: true, members: [{ userId: oEd, role: "ORG_ADMIN" }] });
  await sys((tx) => tx.query(`INSERT INTO organization_counties (org_id, county_id) VALUES ($1, $2)`, [orgG, countyA]));
});
afterAll(async () => db?.close());

describe("donation link approval", () => {
  it("link change resets approval even by direct SQL", async () => {
    await sys((tx) => tx.query(
      `UPDATE organizations SET donation_url = 'https://give.example.org/relief' WHERE id = $1`, [orgG]));
    await sys((tx) => tx.query(
      `UPDATE organizations SET donation_url_status = 'APPROVED', donation_url_reviewed_by = $2, donation_url_reviewed_at = now(),
              donation_url_review_note = 'Checked' WHERE id = $1`, [orgG, exec]));
    expect((await asAnon((tx) => tx.query<{ donation_url: string | null }>(`SELECT donation_url FROM public_contacts WHERE id = $1`, [orgG])))[0].donation_url)
      .toBe("https://give.example.org/relief");

    await sys((tx) => tx.query(`UPDATE organizations SET donation_url = 'https://other.example' WHERE id = $1`, [orgG]));
    const r = await sys((tx) => tx.query<Record<string, unknown>>(
      `SELECT donation_url_status, donation_url_reviewed_by, donation_url_reviewed_at, donation_url_review_note FROM organizations WHERE id = $1`, [orgG]));
    expect(r[0]).toEqual({ donation_url_status: "PENDING", donation_url_reviewed_by: null, donation_url_reviewed_at: null, donation_url_review_note: null });
    expect((await asAnon((tx) => tx.query<{ donation_url: string | null }>(`SELECT donation_url FROM public_contacts WHERE id = $1`, [orgG])))[0].donation_url)
      .toBeNull();

    await sys((tx) => tx.query(`UPDATE organizations SET donation_url = NULL WHERE id = $1`, [orgG]));
    const n = await sys((tx) => tx.query<{ s: string }>(`SELECT donation_url_status AS s FROM organizations WHERE id = $1`, [orgG]));
    expect(n[0].s).toBe("NONE");
  });

  it("only approved links reach public_contacts", async () => {
    await sys((tx) => tx.query(`UPDATE organizations SET donation_url = 'https://give.example.org/o' WHERE id = $1`, [orgO]));
    await sys((tx) => tx.query(`UPDATE organizations SET donation_url_status = 'REJECTED' WHERE id = $1`, [orgO]));
    const url = () => asAnon((tx) => tx.query<{ donation_url: string | null }>(`SELECT donation_url FROM public_contacts WHERE id = $1`, [orgO]));
    expect((await url())[0].donation_url).toBeNull();
    await sys((tx) => tx.query(`UPDATE organizations SET donation_url_status = 'APPROVED' WHERE id = $1`, [orgO]));
    expect((await url())[0].donation_url).toBe("https://give.example.org/o");
  });
});

describe("accepted offer types", () => {
  it("accepted types appear in public_contacts and are checked", async () => {
    await sys((tx) => tx.query(`INSERT INTO organization_accepted_offer_types (org_id, offer_type) VALUES ($1, 'FOOD'), ($1, 'DRINKING_WATER')`, [orgG]));
    const r = await asAnon((tx) => tx.query<{ accepted_offer_types: string[] }>(`SELECT accepted_offer_types FROM public_contacts WHERE id = $1`, [orgG]));
    expect(r[0].accepted_offer_types).toEqual(["DRINKING_WATER", "FOOD"]);
    expect(await pgCode(sys((tx) => tx.query(`INSERT INTO organization_accepted_offer_types (org_id, offer_type) VALUES ($1, 'GOLD')`, [orgG]))))
      .toBe("23514");
  });
});

describe("directed offers", () => {
  it("directed offer needs consent_share", async () => {
    expect(await pgCode(insertOffer({ consentShare: false }))).toBe("23514");
    expect(await pgCode(insertOffer({ organizationId: null, consentShare: false, status: "SUBMITTED" }))).toBe("OK");
  });

  it("directed offer visibility: org editors, served-county and giver-county admins, executives only", async () => {
    const id = await insertOffer(); // giver ZIP county = B; org G serves A
    expect(await visible(gEd, id)).toBe(true);
    expect(await visible(adminA, id)).toBe(true);
    expect(await visible(adminB, id)).toBe(true);
    expect(await visible(exec, id)).toBe(true);
    expect(await visible(gView, id)).toBe(false);
    expect(await visible(oEd, id)).toBe(false);
    expect(await pgCode(asAnon((tx) => tx.query(`SELECT 1 FROM contribution_offers WHERE id = $1`, [id])))).toBe("42501");

    const central = await insertOffer({ organizationId: null, status: "SUBMITTED" });
    expect(await visible(gEd, central)).toBe(false);

    const ev = await asViewer(gEd, (tx) => tx.query(`SELECT 1 FROM contribution_offer_events WHERE offer_id = $1`, [id]));
    expect(ev).toHaveLength(0); // none written by direct insert, but the query is allowed
    await sys((tx) => tx.query(
      `INSERT INTO contribution_offer_events (offer_id, actor_role, event_type, to_status) VALUES ($1, 'CONTRIBUTOR', 'SUBMITTED', 'MATCHED')`, [id]));
    expect(await asViewer(gEd, (tx) => tx.query(`SELECT 1 FROM contribution_offer_events WHERE offer_id = $1`, [id]))).toHaveLength(1);
    expect(await asViewer(oEd, (tx) => tx.query(`SELECT 1 FROM contribution_offer_events WHERE offer_id = $1`, [id]))).toHaveLength(0);
  });

  it("ineligible org loses visibility; county admins keep it", async () => {
    const id = await insertOffer();
    const cases: [string, string][] = [
      ["publication_suspended = true", "publication_suspended = false"],
      ["profile_status = 'HIDDEN'", "profile_status = 'APPROVED'"],
      ["directory_consent_at = NULL", "directory_consent_at = now()"],
    ];
    for (const [off, on] of cases) {
      await sys((tx) => tx.query(`UPDATE organizations SET ${off} WHERE id = $1`, [orgG]));
      expect(await visible(gEd, id)).toBe(false);
      expect(await visible(adminA, id)).toBe(true);
      await sys((tx) => tx.query(`UPDATE organizations SET ${on} WHERE id = $1`, [orgG]));
      expect(await visible(gEd, id)).toBe(true);
    }
  });

  it("organization_id is set-once except an administrator's rescue to central triage", async () => {
    const id = await insertOffer();
    expect(await pgCode(asActor(gEd, "ORG", `UPDATE contribution_offers SET organization_id = $2 WHERE id = $1`, [id, orgO]))).toBe("42501");
    expect(await pgCode(asActor(gEd, "ORG", `UPDATE contribution_offers SET status = 'REVIEWED' WHERE id = $1`, [id]))).toBe("42501");
    expect(await pgCode(asActor(adminA, "COUNTY_ADMIN", `UPDATE contribution_offers SET status = 'REVIEWED', organization_id = $2 WHERE id = $1`, [id, orgO])))
      .toBe("42501");
    expect(await pgCode(asActor(adminA, "COUNTY_ADMIN", `UPDATE contribution_offers SET status = 'REVIEWED', organization_id = NULL WHERE id = $1`, [id])))
      .toBe("OK");
    const ev = await sys((tx) => tx.query<{ from_status: string; to_status: string }>(
      `SELECT from_status, to_status FROM contribution_offer_events WHERE offer_id = $1 AND event_type = 'STATUS_CHANGED'`, [id]));
    expect(ev).toEqual([{ from_status: "MATCHED", to_status: "REVIEWED" }]);
    // Once central, it can never be pointed at an organization again.
    expect(await pgCode(asActor(exec, "EXECUTIVE", `UPDATE contribution_offers SET organization_id = $2 WHERE id = $1`, [id, orgG]))).toBe("42501");
  });

  it("an organization can make its own status moves", async () => {
    const id = await insertOffer();
    expect(await pgCode(asActor(gEd, "ORG", `UPDATE contribution_offers SET status = 'ACCEPTED' WHERE id = $1`, [id]))).toBe("OK");
    const ev = await sys((tx) => tx.query<{ actor_role: string }>(
      `SELECT actor_role FROM contribution_offer_events WHERE offer_id = $1 AND event_type = 'STATUS_CHANGED'`, [id]));
    expect(ev).toEqual([{ actor_role: "ORG" }]);
  });
});
