import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver, Tx } from "@/server/db";
import { runIn } from "@/server/db/context";
import { createCounty } from "@/server/modules/counties";
import { getPublicSitePin, queryMap } from "@/server/modules/map";
import { addNeed, createProject, searchProjects } from "@/server/modules/projects";
import { archiveSite, createSite } from "@/server/modules/sites";
import { freshDb } from "./helpers/db";
import { ASHEVILLE_BBOX, grantRole, makeOrg, makeUser, site } from "./helpers/fixtures";

/** Projects reach the map through their site: a public site lists its open volunteer projects. */

let db: Driver;
let exec: string, editor: string, org: string, suspendedOrg: string, suspEditor: string;
let hub: string, privateHub: string, suspHub: string;
const sys = <T>(fn: (tx: Tx) => Promise<T>) => runIn(db, { kind: "system" }, fn);
const setStatus = (id: string, status: string) => sys((tx) => tx.query(`UPDATE projects SET status = $2, reviewed_at = now() WHERE id = $1`, [id, status]));
const project = async (siteId: string, title: string, o = org, by = editor) => {
  const id = await createProject(db, by, o, { title, description: "Volunteers needed for storm recovery work.", siteId, audience: "COMMUNITY" });
  return id;
};
const projectsAt = async (siteName: string, viewer: string | null = null) =>
  (await queryMap(db, viewer, ASHEVILLE_BBOX)).sites.find((s) => s.name === siteName)?.projects;

beforeAll(async () => {
  db = await freshDb();
  [exec, editor, suspEditor] = await Promise.all(["mp-exec", "mp-editor", "mp-susp"].map((n) => makeUser(db, `${n}@example.test`)));
  await grantRole(db, exec, "PLATFORM_ADMIN");
  const buncombe = await createCounty(db, exec, { name: "Buncombe", state: "NC", fips: "37021" });
  org = await makeOrg(db, { name: "Map Projects Org", members: [{ userId: editor, role: "EDITOR" }] });
  suspendedOrg = await makeOrg(db, { name: "Suspended Map Org", members: [{ userId: suspEditor, role: "EDITOR" }] });
  await sys((tx) => tx.query(`INSERT INTO organization_counties (org_id, county_id) VALUES ($1, $3), ($2, $3)`, [org, suspendedOrg, buncombe]));
  hub = await createSite(db, editor, org, site({ name: "[TEST] Volunteer Hub", postalCode: "28801" }));
  privateHub = await createSite(db, editor, org, site({ name: "[TEST] Private Hub", postalCode: "28801", visibility: "PRIVATE_ORGANIZATION" }));
  suspHub = await createSite(db, suspEditor, suspendedOrg, site({ name: "[TEST] Suspended Hub", postalCode: "28801" }));

  const calm = await project(hub, "Sort donated clothing");
  await addNeed(db, editor, calm, { title: "Sorters", slotsNeeded: 5 });
  await setStatus(calm, "OPEN");
  const urgent = await project(hub, "Tarp roofs before the rain");
  await addNeed(db, editor, urgent, { title: "Roofers", slotsNeeded: 3, urgency: "URGENT" });
  await setStatus(urgent, "OPEN");
  for (const [title, status] of [["Draft at hub", "DRAFT"], ["Pending at hub", "PENDING_REVIEW"], ["Paused at hub", "PAUSED"]]) {
    await setStatus(await project(hub, title), status);
  }
  const hidden = await project(privateHub, "Project at a private site");
  await setStatus(hidden, "OPEN");
  const susp = await project(suspHub, "Suspended org project", suspendedOrg, suspEditor);
  await setStatus(susp, "OPEN");
  await sys((tx) => tx.query(`UPDATE organizations SET publication_suspended = true WHERE id = $1`, [suspendedOrg]));
});
afterAll(async () => db?.close());

describe("projects on the map", () => {
  it("a public site lists its open projects, urgent first, with spots left", async () => {
    expect(await projectsAt("[TEST] Volunteer Hub")).toEqual([
      expect.objectContaining({ title: "Tarp roofs before the rain", hasUrgent: true, spotsLeft: 3 }),
      expect.objectContaining({ title: "Sort donated clothing", hasUrgent: false, spotsLeft: 5 }),
    ]);
  });

  it("does not list draft, pending or paused projects", async () => {
    const titles = (await projectsAt("[TEST] Volunteer Hub"))!.map((p) => p.title);
    expect(titles).not.toContain("Draft at hub");
    expect(titles).not.toContain("Pending at hub");
    expect(titles).not.toContain("Paused at hub");
  });

  it("a project at a private site is absent from the public map but present in the volunteer search", async () => {
    expect((await queryMap(db, null, ASHEVILLE_BBOX)).sites.map((s) => s.name)).not.toContain("[TEST] Private Hub");
    const { projects } = await searchProjects(db, {});
    expect(projects.find((p) => p.title === "Project at a private site")).toMatchObject({ siteId: privateHub, sitePublic: false });
  });

  it("signed-in members see the same open projects on their own private site", async () => {
    expect((await projectsAt("[TEST] Private Hub", editor))!.map((p) => p.title)).toEqual(["Project at a private site"]);
  });

  it("a site with no open projects has an empty list", async () => {
    const lonely = await createSite(db, editor, org, site({ name: "[TEST] Quiet Hub", postalCode: "28801" }));
    expect(await projectsAt("[TEST] Quiet Hub")).toEqual([]);
    expect(lonely).toBeTruthy();
  });
});

describe("getPublicSitePin", () => {
  it("returns the coordinates of a public site", async () => {
    expect(await getPublicSitePin(db, hub)).toEqual({ id: hub, lat: expect.closeTo(35.5951, 4), lng: expect.closeTo(-82.5515, 4) });
  });

  it("returns null for a private, archived, suspended-org or malformed site", async () => {
    const gone = await createSite(db, editor, org, site({ name: "[TEST] Gone Hub", postalCode: "28801" }));
    await archiveSite(db, editor, gone);
    expect(await getPublicSitePin(db, privateHub)).toBeNull();
    expect(await getPublicSitePin(db, gone)).toBeNull();
    expect(await getPublicSitePin(db, suspHub)).toBeNull();
    expect(await getPublicSitePin(db, "not-a-uuid")).toBeNull();
  });
});
