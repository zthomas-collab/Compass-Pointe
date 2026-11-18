import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver, Tx } from "@/server/db";
import { runIn } from "@/server/db/context";
import { createCounty } from "@/server/modules/counties";
import { dismissSuggestion, linkProjectToEvent } from "@/server/modules/eventlinks";
import { createEvent, setEventStatus } from "@/server/modules/events";
import { getPublicOrganizationActivity } from "@/server/modules/org-activity";
import { addNeed, createProject } from "@/server/modules/projects";
import { createSite } from "@/server/modules/sites";
import { freshDb } from "./helpers/db";
import { grantRole, makeOrg, makeUser, site } from "./helpers/fixtures";

/** The public profile's activity: public locations, open projects and the open events those projects are confirmed on. */

let db: Driver;
let exec: string, editor: string, org: string, hiddenOrg: string, hiddenEditor: string;
let hub: string;
const sys = <T>(fn: (tx: Tx) => Promise<T>) => runIn(db, { kind: "system" }, fn);
const open = async (title: string, siteId: string, urgent = false, o = org, by = editor) => {
  const id = await createProject(db, by, o, { title, description: "Volunteers needed after the storm.", siteId, audience: "COMMUNITY" });
  await addNeed(db, by, id, { title: "Helpers", slotsNeeded: 2, urgency: urgent ? "URGENT" : "NORMAL" });
  await sys((tx) => tx.query(`UPDATE projects SET status = 'OPEN', reviewed_at = now() WHERE id = $1`, [id]));
  return id;
};
const event = async (name: string, buncombe: string, status: "ACTIVE" | "CLOSED" = "ACTIVE") => {
  const id = await createEvent(db, exec, { name, hazardType: "FLOOD", startsOn: "2026-09-10", countyIds: [buncombe] });
  await setEventStatus(db, exec, id, "ACTIVE");
  return { id, close: () => (status === "CLOSED" ? setEventStatus(db, exec, id, "CLOSED") : Promise.resolve()) };
};

beforeAll(async () => {
  db = await freshDb();
  [exec, editor, hiddenEditor] = await Promise.all(["op-exec", "op-editor", "op-hidden"].map((n) => makeUser(db, `${n}@example.test`)));
  await grantRole(db, exec, "PLATFORM_ADMIN");
  const buncombe = await createCounty(db, exec, { name: "Buncombe", state: "NC", fips: "37021" });
  org = await makeOrg(db, { name: "Profile Org", consent: true, members: [{ userId: editor, role: "EDITOR" }] });
  hiddenOrg = await makeOrg(db, { name: "No Consent Org", consent: false, members: [{ userId: hiddenEditor, role: "EDITOR" }] });
  await sys((tx) => tx.query(`INSERT INTO organization_counties (org_id, county_id) VALUES ($1, $3), ($2, $3)`, [org, hiddenOrg, buncombe]));

  hub = await createSite(db, editor, org, site({ name: "[TEST] Profile Hub", postalCode: "28801", city: "Asheville" }));
  const privateHub = await createSite(db, editor, org, site({ name: "[TEST] Profile Private Hub", postalCode: "28801", visibility: "PRIVATE_ORGANIZATION" }));
  const confirmed = await open("Clear storm debris", hub);
  const urgent = await open("Tarp damaged roofs", hub, true);
  await open("Project at the private hub", privateHub);
  const draft = await createProject(db, editor, org, { title: "Draft profile project", description: "Not open yet, should not show.", siteId: hub, audience: "COMMUNITY" });
  expect(draft).toBeTruthy();

  const active = await event("Profile Active Flood", buncombe);
  await linkProjectToEvent(db, editor, confirmed, active.id);
  const closed = await event("Profile Closed Flood", buncombe, "CLOSED");
  await linkProjectToEvent(db, editor, urgent, closed.id);
  await closed.close();
  const suggested = await event("Profile Suggested Flood", buncombe);
  // Activating suggested the open projects; one is dismissed, none confirmed.
  await dismissSuggestion(db, editor, urgent, suggested.id);

  const hiddenHub = await createSite(db, hiddenEditor, hiddenOrg, site({ name: "[TEST] Hidden Org Hub", postalCode: "28801" }));
  await open("Hidden org project", hiddenHub, false, hiddenOrg, hiddenEditor);
});
afterAll(async () => db?.close());

describe("public organization activity", () => {
  it("lists only public sites, open projects urgent first, and open events with confirmed links", async () => {
    const a = await getPublicOrganizationActivity(db, org);
    expect(a.sites).toEqual([{ id: hub, name: "[TEST] Profile Hub", city: "Asheville", state: "NC" }]);
    expect(a.projects.map((p) => p.title)).toEqual(["Tarp damaged roofs", "Clear storm debris", "Project at the private hub"]);
    expect(a.events).toEqual([{ name: "Profile Active Flood", slug: expect.any(String), status: "ACTIVE" }]);
  });

  it("excludes a closed event, suggested or dismissed links, private sites and draft projects", async () => {
    const a = await getPublicOrganizationActivity(db, org);
    expect(a.events.map((e) => e.name)).not.toContain("Profile Closed Flood");
    expect(a.events.map((e) => e.name)).not.toContain("Profile Suggested Flood");
    expect(a.sites.map((s) => s.name)).not.toContain("[TEST] Profile Private Hub");
    expect(a.projects.map((p) => p.title)).not.toContain("Draft profile project");
  });

  it("returns empty lists for an organization without a public profile or an unknown id", async () => {
    const empty = { sites: [], projects: [], events: [] };
    expect(await getPublicOrganizationActivity(db, hiddenOrg)).toEqual(empty);
    expect(await getPublicOrganizationActivity(db, "00000000-0000-0000-0000-000000000000")).toEqual(empty);
    expect(await getPublicOrganizationActivity(db, "nope")).toEqual(empty);
  });
});
