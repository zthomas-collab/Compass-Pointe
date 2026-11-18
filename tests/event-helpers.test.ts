import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver, Tx } from "@/server/db";
import { runIn } from "@/server/db/context";
import { createCounty } from "@/server/modules/counties";
import { linkProjectToEvent } from "@/server/modules/eventlinks";
import { createEvent, listEventHelpers, setEventStatus } from "@/server/modules/events";
import { addNeed, createProject, reviewProject, submitProject } from "@/server/modules/projects";
import { createSite } from "@/server/modules/sites";
import { freshDb } from "./helpers/db";
import { grantRole, makeOrg, makeUser, site } from "./helpers/fixtures";

/** "Who's helping": organizations working an event, for the giver path. */

let db: Driver;
let exec: string, pAdmin: string, sEd: string, nAdmin: string, hAdmin: string;
let buncombe: string, orgProject: string, orgSite: string, orgNone: string, orgHidden: string;
let active: string, closed: string, draft: string;
const sys = <T>(fn: (tx: Tx) => Promise<T>) => runIn(db, { kind: "system" }, fn);

async function openProject(by: string, org: string, urgent: boolean): Promise<string> {
  const id = await createProject(db, by, org, {
    title: `Cleanup crew ${org.slice(0, 6)}`, description: "Volunteers help clear flood damage from homes in the neighborhood.",
    countyId: buncombe, zip: "28801", audience: "COMMUNITY", privateLocationNotes: "Meet behind the church",
  });
  await addNeed(db, by, id, { title: "Drivers", slotsNeeded: 6, urgency: urgent ? "URGENT" : "NORMAL" });
  await submitProject(db, by, id);
  await reviewProject(db, exec, id, { decision: "APPROVE", note: "Approved for volunteers" });
  return id;
}

beforeAll(async () => {
  db = await freshDb();
  [exec, pAdmin, sEd, nAdmin, hAdmin] = await Promise.all(["exec", "p-admin", "s-ed", "n-admin", "h-admin"].map((n) => makeUser(db, `${n}@example.test`)));
  await grantRole(db, exec, "PLATFORM_ADMIN");
  buncombe = await createCounty(db, exec, { name: "Buncombe", state: "NC", fips: "37021" });
  orgProject = await makeOrg(db, { name: "Zeta Project Org", consent: true, members: [{ userId: pAdmin, role: "ORG_ADMIN" }] });
  orgSite = await makeOrg(db, { name: "Alpha Site Org", consent: true, members: [{ userId: sEd, role: "EDITOR" }] });
  orgNone = await makeOrg(db, { name: "Elsewhere Org", consent: true, members: [{ userId: nAdmin, role: "ORG_ADMIN" }] });
  orgHidden = await makeOrg(db, { name: "Hidden Org", consent: true, members: [{ userId: hAdmin, role: "ORG_ADMIN" }] });
  await sys((tx) => tx.query(`INSERT INTO organization_counties (org_id, county_id) VALUES ($1, $5), ($2, $5), ($3, $5), ($4, $5)`,
    [orgProject, orgSite, orgNone, orgHidden, buncombe]));
  await sys((tx) => tx.query(`INSERT INTO organization_accepted_offer_types (org_id, offer_type) VALUES ($1, 'FOOD')`, [orgSite]));

  active = await createEvent(db, exec, { name: "Flood Buncombe", hazardType: "FLOOD", startsOn: "2026-09-10", countyIds: [buncombe], zips: [] });
  await setEventStatus(db, exec, active, "ACTIVE");
  closed = await createEvent(db, exec, { name: "Closed Buncombe", hazardType: "FLOOD", startsOn: "2026-09-10", countyIds: [buncombe], zips: [] });
  await setEventStatus(db, exec, closed, "ACTIVE");
  draft = await createEvent(db, exec, { name: "Draft Buncombe", hazardType: "FLOOD", startsOn: "2026-09-10", countyIds: [buncombe], zips: [] });

  const p = await openProject(pAdmin, orgProject, true);
  await linkProjectToEvent(db, pAdmin, p, active);
  await linkProjectToEvent(db, pAdmin, p, closed);
  await createSite(db, sEd, orgSite, site({ name: "[TEST] Alpha shelter" }));
  await createSite(db, hAdmin, orgHidden, site({ name: "[TEST] Hidden shelter" }));
  await createSite(db, nAdmin, orgNone, site({ name: "[TEST] Far shelter", county: "Aiken", state: "SC", postalCode: "29801", lat: 33.56, lng: -81.72 }));
  await sys((tx) => tx.query(`UPDATE organizations SET profile_status = 'HIDDEN' WHERE id = $1`, [orgHidden]));
  await setEventStatus(db, exec, closed, "CLOSED");
});
afterAll(async () => db?.close());

describe("who's helping", () => {
  it("helpers include orgs with linked projects or sites in the area, urgent first", async () => {
    const h = await listEventHelpers(db, active);
    expect(h.map((x) => x.orgId)).toEqual([orgProject, orgSite]); // urgent first, despite "Zeta" sorting after "Alpha"
    expect(h[0]).toMatchObject({ hasUrgent: true, openSpots: 6, acceptedOfferTypes: [], donationUrl: null });
    expect(h[1]).toMatchObject({ hasUrgent: false, openSpots: 0, acceptedOfferTypes: ["FOOD"], countiesServed: ["Buncombe, NC"] });
  });

  it("hidden or ineligible orgs are excluded", async () => {
    const h = await listEventHelpers(db, active);
    expect(h.map((x) => x.orgId)).not.toContain(orgHidden);
    expect(h.map((x) => x.orgId)).not.toContain(orgNone);
  });

  it("closed, draft and invalid events return []", async () => {
    expect(await listEventHelpers(db, closed)).toEqual([]);
    expect(await listEventHelpers(db, draft)).toEqual([]);
    expect(await listEventHelpers(db, "nope")).toEqual([]);
  });
});
