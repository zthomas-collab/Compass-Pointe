import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Driver, Tx } from "@/server/db";
import { runIn } from "@/server/db/context";
import {
  createRoutingRule, getApplicationForStaff, listApplicationsForStaff, listRoutingRules, setRoutingRuleActive, submitApplication, transitionApplication,
} from "@/server/modules/assistance";
import { assignCountyAdmin, createCounty } from "@/server/modules/counties";
import { freshDb } from "./helpers/db";
import { grantRole, makeOrg, makeUser } from "./helpers/fixtures";

let db: Driver;
let exec: string, adminA: string, adminB: string, provider: string, otherProvider: string, resident: string;
let countyA: string, countyB: string, orgP: string, orgQ: string;
const sys = <T>(fn: (tx: Tx) => Promise<T>) => runIn(db, { kind: "system" }, fn);
const code = (p: Promise<unknown>) => p.then(() => "OK", (e) => (e as { code?: string }).code ?? "ERR");
const form = (over: Record<string, unknown> = {}) => ({
  countyId: countyA, zip: "28801", categoryCode: "HOUSING", summary: "Roof damage after the storm", situation: "The roof collapsed and we are staying with relatives.",
  householdSize: "4", contactPhone: "", preferredContact: "EMAIL", consentShareProviders: "on", ...over,
});

beforeAll(async () => {
  process.env.ASSISTANCE_ENABLED = "true";
  db = await freshDb();
  [exec, adminA, adminB, provider, otherProvider, resident] = await Promise.all(["exec", "admin-a", "admin-b", "provider", "other-provider", "resident"].map((n) => makeUser(db, `${n}@example.test`)));
  await grantRole(db, exec, "PLATFORM_ADMIN");
  countyA = await createCounty(db, exec, { name: "Alpha", state: "NC" });
  countyB = await createCounty(db, exec, { name: "Bravo", state: "NC" });
  await assignCountyAdmin(db, exec, { email: "admin-a@example.test", countyId: countyA, reason: "County A coordinator" });
  await assignCountyAdmin(db, exec, { email: "admin-b@example.test", countyId: countyB, reason: "County B coordinator" });
  orgP = await makeOrg(db, { name: "Provider P", members: [{ userId: provider, role: "EDITOR" }] });
  orgQ = await makeOrg(db, { name: "Provider Q", members: [{ userId: otherProvider, role: "EDITOR" }] });
});
afterAll(async () => {
  delete process.env.ASSISTANCE_ENABLED;
  await db?.close();
});
afterEach(() => undefined);

async function referred(): Promise<string> {
  await createRoutingRule(db, adminA, { countyId: countyA, categoryCode: "HOUSING", handlerOrgId: orgP }).catch(() => undefined);
  const id = await submitApplication(db, resident, form());
  await transitionApplication(db, adminA, { applicationId: id, to: "UNDER_REVIEW" });
  await transitionApplication(db, adminA, { applicationId: id, to: "APPROVED" });
  await transitionApplication(db, adminA, { applicationId: id, to: "REFERRED" });
  return id;
}
const mailTo = (email: string, kind: string) =>
  sys((tx) => tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM notification_jobs WHERE recipient_email = $1 AND kind = $2`, [email, kind])).then((r) => r[0].n);

describe("provider referrals", () => {
  it("a provider sees its referred applications in a queue, and no one else's", async () => {
    const id = await referred();
    const mine = await listApplicationsForStaff(db, provider);
    expect(mine.rows.map((r) => r.id)).toContain(id);
    expect((await listApplicationsForStaff(db, provider, { status: "REFERRED" })).rows.every((r) => r.status === "REFERRED")).toBe(true);
    await expect(listApplicationsForStaff(db, otherProvider)).resolves.toMatchObject({ rows: [] });
    expect(await code(getApplicationForStaff(db, otherProvider, id))).toBe("NOT_FOUND");
    const detail = await getApplicationForStaff(db, provider, id);
    expect(detail.capacity).toBe("provider");
    expect(detail.allowedNext.sort()).toEqual(["APPROVED", "IN_PROGRESS"]);
  });

  it("a provider that cannot help returns the application to the county with a reason, and the county is told but the applicant is not", async () => {
    const id = await referred();
    const countyBefore = await mailTo("admin-a@example.test", "APPLICATION_RETURNED");
    const applicantBefore = await mailTo("resident@example.test", "APPLICATION_UPDATE");
    expect(await code(transitionApplication(db, provider, { applicationId: id, to: "APPROVED" }))).toBe("VALIDATION"); // a reason is required
    await transitionApplication(db, provider, { applicationId: id, to: "APPROVED", note: "No crew available in this ZIP this month." });
    expect((await getApplicationForStaff(db, adminA, id)).status).toBe("APPROVED");
    expect(await mailTo("admin-a@example.test", "APPLICATION_RETURNED")).toBe(countyBefore + 1);
    expect(await mailTo("admin-b@example.test", "APPLICATION_RETURNED")).toBe(0); // another county is not told
    expect(await mailTo("resident@example.test", "APPLICATION_UPDATE")).toBe(applicantBefore); // the applicant is not told about the internal hand-back
    // The provider no longer sees it once it is back with the county; the county can refer it again.
    expect(await code(getApplicationForStaff(db, provider, id))).toBe("NOT_FOUND");
    await transitionApplication(db, adminA, { applicationId: id, to: "REFERRED" });
    expect((await getApplicationForStaff(db, provider, id)).status).toBe("REFERRED");
    const note = (await getApplicationForStaff(db, adminA, id)).events.find((e) => e.note?.startsWith("No crew"));
    expect(note).toBeDefined();
  });
});

describe("routing rules", () => {
  it("are listed and changed only by the county's administrators (or an executive)", async () => {
    const countyRule = await createRoutingRule(db, adminB, { countyId: countyB, zip: "28806", categoryCode: "HOUSING", handlerOrgId: orgQ, note: "Bravo housing", priority: 10 });
    const asB = await listRoutingRules(db, adminB);
    expect(asB.map((r) => r.id)).toContain(countyRule);
    expect(asB.every((r) => r.countyId === countyB)).toBe(true); // rules for other counties are invisible
    expect((await listRoutingRules(db, adminA)).map((r) => r.id)).not.toContain(countyRule);
    expect(await code(createRoutingRule(db, adminA, { countyId: countyB, handlerOrgId: orgP }))).toBe("FORBIDDEN");
    expect(await code(setRoutingRuleActive(db, adminA, countyRule, false))).toBe("FORBIDDEN");
    expect(await code(createRoutingRule(db, adminB, { countyId: countyB, handlerOrgId: "00000000-0000-0000-0000-000000000000" }))).toBe("VALIDATION");
    expect((await listRoutingRules(db, exec)).map((r) => r.id)).toContain(countyRule);
  });

  it("a disabled rule stops routing new applications to its organization", async () => {
    const rule = await createRoutingRule(db, adminA, { countyId: countyA, zip: "28803", categoryCode: "FOOD_WATER", handlerOrgId: orgQ, priority: 1 });
    const suggested = async () => {
      const id = await submitApplication(db, resident, form({ zip: "28803", categoryCode: "FOOD_WATER" }));
      const r = await sys((tx) => tx.query<{ suggested_org_id: string | null }>(`SELECT suggested_org_id FROM assistance_applications WHERE id = $1`, [id]));
      await transitionApplication(db, adminA, { applicationId: id, to: "CLOSED", closureReason: "DUPLICATE" }); // free the applicant's open-application slot
      return r[0].suggested_org_id;
    };
    expect(await suggested()).toBe(orgQ);
    await setRoutingRuleActive(db, adminA, rule, false);
    expect(await suggested()).not.toBe(orgQ);
    await setRoutingRuleActive(db, adminA, rule, true);
    expect(await suggested()).toBe(orgQ);
  });
});
