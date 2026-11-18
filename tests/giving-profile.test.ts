import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver, Tx } from "@/server/db";
import { runIn } from "@/server/db/context";
import { assignCountyAdmin, createCounty } from "@/server/modules/counties";
import { getOrganizationProfile, getPublicOrganization, updateOrganizationProfile } from "@/server/modules/directory";
import { getGiveTarget, listDonationLinksForReview, reviewDonationLink } from "@/server/modules/giving";
import { freshDb } from "./helpers/db";
import { grantRole, makeOrg, makeUser } from "./helpers/fixtures";

let db: Driver;
let exec: string, adminA: string, adminB: string, gAdmin: string, sAdmin: string;
let countyA: string, countyB: string, orgG: string, orgS: string, orgBare: string;
const sys = <T>(fn: (tx: Tx) => Promise<T>) => runIn(db, { kind: "system" }, fn);
const code = (p: Promise<unknown>) => p.then(() => "OK", (e) => (e as { code?: string }).code ?? "ERR");
const fields = (p: Promise<unknown>): Promise<Record<string, string[]>> => p.then(() => ({}),(e) => (e as { fieldErrors?: Record<string, string[]> }).fieldErrors ?? {});
const LINK = "https://give.example.org/relief";
const save = (userId: string, orgId: string, over: Record<string, unknown> = {}) =>
  updateOrganizationProfile(db, userId, orgId, { directoryConsent: "on", donationUrl: LINK, acceptedOfferTypes: ["FOOD", "DRINKING_WATER"], ...over });

beforeAll(async () => {
  db = await freshDb();
  [exec, adminA, adminB, gAdmin, sAdmin] = await Promise.all(["exec", "admin-a", "admin-b", "g-admin", "s-admin"].map((n) => makeUser(db, `${n}@example.test`)));
  await grantRole(db, exec, "PLATFORM_ADMIN");
  countyA = await createCounty(db, exec, { name: "Buncombe", state: "NC" });
  countyB = await createCounty(db, exec, { name: "Aiken", state: "SC" });
  await assignCountyAdmin(db, exec, { email: "admin-a@example.test", countyId: countyA, reason: "County A coordinator" });
  await assignCountyAdmin(db, exec, { email: "admin-b@example.test", countyId: countyB, reason: "County B coordinator" });
  orgG = await makeOrg(db, { name: "Giving Org", consent: true, members: [{ userId: gAdmin, role: "ORG_ADMIN" }] });
  orgS = await makeOrg(db, { name: "Suspended Org", consent: true, members: [{ userId: sAdmin, role: "ORG_ADMIN" }] });
  orgBare = await makeOrg(db, { name: "No Types Org", consent: true });
  await sys((tx) => tx.query(`INSERT INTO organization_counties (org_id, county_id) VALUES ($1, $2), ($3, $2)`, [orgG, countyA, orgS]));
});
afterAll(async () => db?.close());

describe("profile giving fields", () => {
  it("profile saves donation link as pending and accepted types", async () => {
    await save(gAdmin, orgG, { countyIds: [countyA] });
    const p = await getOrganizationProfile(db, gAdmin, orgG);
    expect(p.donationUrl).toBe(LINK);
    expect(p.donationUrlStatus).toBe("PENDING");
    expect(p.donationUrlReviewNote).toBeNull();
    expect([...p.acceptedOfferTypes].sort()).toEqual(["DRINKING_WATER", "FOOD"]);
    const pub = await getPublicOrganization(db, orgG);
    expect(pub?.donationUrl).toBeNull();
    expect(pub?.acceptedOfferTypes).toEqual(["DRINKING_WATER", "FOOD"]);
  });

  it("donation url validation", async () => {
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "give.example.org"]) {
      const f = await fields(save(gAdmin, orgG, { donationUrl: bad, countyIds: [countyA] }));
      expect(f.donationUrl, bad).toBeTruthy();
    }
    expect(await code(save(gAdmin, orgG, { acceptedOfferTypes: ["GOLD"], countyIds: [countyA] }))).toBe("VALIDATION");
  });

  it("audit never stores the URL", async () => {
    const r = await sys((tx) => tx.query<{ d: string }>(`SELECT coalesce(string_agg(details::text, ' '), '') AS d FROM audit_logs WHERE subject_id = $1`, [orgG]));
    expect(r[0].d).not.toContain("give.example.org");
  });
});

describe("donation link review", () => {
  it("review list is scoped", async () => {
    const a = await listDonationLinksForReview(db, adminA);
    expect(a.map((x) => x.orgId)).toContain(orgG);
    const row = a.find((x) => x.orgId === orgG)!;
    expect(row).toMatchObject({ url: LINK, host: "give.example.org" });
    expect(await listDonationLinksForReview(db, adminB)).toEqual([]);
    expect((await listDonationLinksForReview(db, exec)).map((x) => x.orgId)).toContain(orgG);
  });

  it("review approves and rejects with scope", async () => {
    expect(await code(reviewDonationLink(db, adminB, { orgId: orgG, decision: "APPROVED", note: "", url: LINK }))).toBe("FORBIDDEN");
    expect(await code(reviewDonationLink(db, exec, { orgId: orgG, decision: "REJECTED", note: "", url: LINK }))).toBe("VALIDATION");
    await reviewDonationLink(db, adminA, { orgId: orgG, decision: "APPROVED", note: "", url: LINK });
    expect((await getPublicOrganization(db, orgG))?.donationUrl).toBe(LINK);
    expect(await code(reviewDonationLink(db, exec, { orgId: orgG, decision: "APPROVED", note: "", url: LINK }))).toBe("CONFLICT");
    const audit = await sys((tx) => tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'ORG_DONATION_LINK_APPROVED' AND subject_id = $1`, [orgG]));
    expect(audit[0].n).toBe(1);

    // Saving the same link keeps the approval; changing it sends it back.
    await save(gAdmin, orgG, { countyIds: [countyA] });
    expect((await getOrganizationProfile(db, gAdmin, orgG)).donationUrlStatus).toBe("APPROVED");
    await save(gAdmin, orgG, { donationUrl: "https://give.example.org/new", countyIds: [countyA] });
    expect((await getPublicOrganization(db, orgG))?.donationUrl).toBeNull();
    await reviewDonationLink(db, exec, { orgId: orgG, decision: "REJECTED", note: "Page is not the organization's", url: "https://give.example.org/new" });
    const p = await getOrganizationProfile(db, gAdmin, orgG);
    expect(p).toMatchObject({ donationUrlStatus: "REJECTED", donationUrlReviewNote: "Page is not the organization's" });
  });
});

describe("approving the link that was reviewed", () => {
  it("refuses to approve a link that changed after the administrator opened it", async () => {
    await save(sAdmin, orgS, { donationUrl: "https://give.example.org/seen", countyIds: [countyA] });
    const seen = (await listDonationLinksForReview(db, exec)).find((x) => x.orgId === orgS)!.url;
    await save(sAdmin, orgS, { donationUrl: "https://evil.example.net/swap", countyIds: [countyA] });
    expect(await code(reviewDonationLink(db, exec, { orgId: orgS, decision: "APPROVED", note: "", url: seen }))).toBe("CONFLICT");
    expect((await getOrganizationProfile(db, sAdmin, orgS)).donationUrlStatus).toBe("PENDING");
    expect(await code(reviewDonationLink(db, exec, { orgId: orgS, decision: "APPROVED", note: "" }))).toBe("VALIDATION"); // the URL is required
    await reviewDonationLink(db, exec, { orgId: orgS, decision: "APPROVED", note: "", url: "https://evil.example.net/swap" });
    expect((await getOrganizationProfile(db, sAdmin, orgS)).donationUrlStatus).toBe("APPROVED");
  });
});

describe("give target", () => {
  it("giveTarget filters types and eligibility", async () => {
    const t = await getGiveTarget(db, orgG);
    expect(t).toMatchObject({ orgId: orgG, acceptedOfferTypes: ["DRINKING_WATER", "FOOD"], donationUrl: null });
    expect(t?.displayName).toContain("Giving Org");
    expect(await getGiveTarget(db, orgBare)).toBeNull();
    await save(sAdmin, orgS, { countyIds: [countyA] });
    expect(await getGiveTarget(db, orgS)).not.toBeNull();
    await sys((tx) => tx.query(`UPDATE organizations SET publication_suspended = true WHERE id = $1`, [orgS]));
    expect(await getGiveTarget(db, orgS)).toBeNull();
    expect(await getGiveTarget(db, "not-a-uuid")).toBeNull();
    expect(await getGiveTarget(db, undefined)).toBeNull();
  });
});
