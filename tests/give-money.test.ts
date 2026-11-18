import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver, Tx } from "@/server/db";
import { runIn } from "@/server/db/context";
import { listGiveMoneyOrgs } from "@/server/modules/giving";
import { queryMap } from "@/server/modules/map";
import { createSite } from "@/server/modules/sites";
import { freshDb } from "./helpers/db";
import { ASHEVILLE_BBOX, makeOrg, makeUser, site } from "./helpers/fixtures";

/** Giving money: only administrator-approved donation links of public organizations ever reach the public. */

let db: Driver;
let approved: string, pending: string, none: string, hidden: string;
let editA: string, editP: string, editN: string;
const sys = <T>(fn: (tx: Tx) => Promise<T>) => runIn(db, { kind: "system" }, fn);

async function setLink(orgId: string, url: string, approve: boolean) {
  await sys((tx) => tx.query(`UPDATE organizations SET donation_url = $2 WHERE id = $1`, [orgId, url]));
  if (approve) {
    await sys((tx) => tx.query(
      `UPDATE organizations SET donation_url_status = 'APPROVED', donation_url_reviewed_at = now() WHERE id = $1`, [orgId]));
  }
}

beforeAll(async () => {
  db = await freshDb();
  [editA, editP, editN] = await Promise.all(["ga", "gp", "gn"].map((n) => makeUser(db, `${n}@example.test`)));
  approved = await makeOrg(db, { name: "Approved Relief", consent: true, members: [{ userId: editA, role: "EDITOR" }] });
  pending = await makeOrg(db, { name: "Pending Relief", consent: true, members: [{ userId: editP, role: "EDITOR" }] });
  none = await makeOrg(db, { name: "No Link Pantry", consent: true, members: [{ userId: editN, role: "EDITOR" }] });
  hidden = await makeOrg(db, { name: "Hidden Relief", consent: false });
  await setLink(approved, "https://give.example.org/approved", true);
  await setLink(pending, "https://give.example.org/pending", false);
  await setLink(hidden, "https://give.example.org/hidden", true);
  await createSite(db, editA, approved, site({ name: "[TEST] Approved Site" }));
  await createSite(db, editP, pending, site({ name: "[TEST] Pending Site", lat: 35.6 }));
  await createSite(db, editN, none, site({ name: "[TEST] No Link Site", lat: 35.61 }));
});
afterAll(async () => db?.close());

describe("organizations you can give money to", () => {
  it("lists only approved links of organizations with a public profile", async () => {
    const orgs = await listGiveMoneyOrgs(db);
    expect(orgs.map((o) => o.orgId)).toEqual([approved]);
    expect(orgs[0]).toMatchObject({ displayName: "[TEST] Approved Relief", donationUrl: "https://give.example.org/approved", host: "give.example.org" });
  });

  it("drops an organization the moment its link changes and needs review again", async () => {
    await setLink(approved, "https://give.example.org/changed", false);
    expect(await listGiveMoneyOrgs(db)).toEqual([]);
    await setLink(approved, "https://give.example.org/approved", true);
    expect((await listGiveMoneyOrgs(db)).map((o) => o.orgId)).toEqual([approved]);
  });
});

describe("map listings", () => {
  it("carry the operating organization's approved donation link and public profile, nothing else", async () => {
    const { sites } = await queryMap(db, null, ASHEVILLE_BBOX);
    const byName = Object.fromEntries(sites.map((s) => [s.name, s]));
    expect(byName["[TEST] Approved Site"]).toMatchObject({ orgDonationUrl: "https://give.example.org/approved", orgHasProfile: true });
    expect(byName["[TEST] Pending Site"]).toMatchObject({ orgDonationUrl: null, orgHasProfile: true });
    expect(byName["[TEST] No Link Site"]).toMatchObject({ orgDonationUrl: null, orgHasProfile: true });
  });

  it("show the same for a signed-in organization member", async () => {
    const { sites } = await queryMap(db, editA, ASHEVILLE_BBOX);
    expect(sites.find((s) => s.name === "[TEST] Approved Site")).toMatchObject({ orgDonationUrl: "https://give.example.org/approved" });
    expect(sites.find((s) => s.name === "[TEST] Pending Site")?.orgDonationUrl ?? null).toBeNull();
  });
});
