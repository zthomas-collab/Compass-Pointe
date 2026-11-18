import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver, Tx } from "@/server/db";
import { runIn } from "@/server/db/context";
import { createCounty } from "@/server/modules/counties";
import { addNeed, createProject, listProjectSites, submitProject } from "@/server/modules/projects";
import { archiveSite, createSite, updateSite } from "@/server/modules/sites";
import { freshDb } from "./helpers/db";
import { grantRole, makeOrg, makeUser, site } from "./helpers/fixtures";

/** Migration 0019: a project starts at one of its organization's sites; its county and ZIP come from that site. */

let db: Driver;
let exec: string, editor: string, otherEditor: string;
let orgA: string, orgB: string, buncombe: string, henderson: string;
let siteA: string, siteOther: string, siteNoCounty: string, siteUnserved: string, hendersonZip: string;
const sys = <T>(fn: (tx: Tx) => Promise<T>) => runIn(db, { kind: "system" }, fn);
const row = async (id: string) =>
  (await sys((tx) => tx.query<{ zip: string; county_id: string; status: string; site_id: string | null }>(
    `SELECT zip, county_id, status, site_id FROM projects WHERE id = $1`, [id])))[0];
const input = (siteId: string, over: Record<string, unknown> = {}) => ({
  title: "Mucking out flooded homes", description: "Volunteers help families clear mud and debris.", siteId, audience: "COMMUNITY", ...over,
});

beforeAll(async () => {
  db = await freshDb();
  [exec, editor, otherEditor] = await Promise.all(["ps-exec", "ps-editor", "ps-other"].map((n) => makeUser(db, `${n}@example.test`)));
  await grantRole(db, exec, "PLATFORM_ADMIN");
  buncombe = await createCounty(db, exec, { name: "Buncombe", state: "NC", fips: "37021" });
  henderson = await createCounty(db, exec, { name: "Henderson", state: "NC", fips: "37089" });
  orgA = await makeOrg(db, { name: "Pinned Org", members: [{ userId: editor, role: "EDITOR" }] });
  orgB = await makeOrg(db, { name: "Other Pinned Org", members: [{ userId: otherEditor, role: "EDITOR" }] });
  await sys((tx) => tx.query(`INSERT INTO organization_counties (org_id, county_id) VALUES ($1, $2), ($1, $3)`, [orgA, buncombe, henderson]));
  hendersonZip = (await sys((tx) => tx.query<{ zip: string }>(
    `SELECT zip FROM zip_county WHERE county_fips = '37089'
        AND zip NOT IN (SELECT zip FROM zip_county WHERE county_fips <> '37089') ORDER BY zip LIMIT 1`)))[0].zip;
  siteA = await createSite(db, editor, orgA, site({ name: "[TEST] Pinned Hub", postalCode: "28778" }));
  siteOther = await createSite(db, otherEditor, orgB, site({ name: "[TEST] Other Org Hub", postalCode: "28778" }));
  siteNoCounty = await createSite(db, editor, orgA, site({ name: "[TEST] No County Hub", postalCode: "29801", state: "SC" }));
  const orgC = await makeOrg(db, { name: "Unserved County Org", members: [{ userId: editor, role: "EDITOR" }] });
  await sys((tx) => tx.query(`INSERT INTO organization_counties (org_id, county_id) VALUES ($1, $2)`, [orgC, buncombe]));
  siteUnserved = await createSite(db, editor, orgC, site({ name: "[TEST] Unserved Hub", postalCode: hendersonZip }));
});
afterAll(async () => db?.close());

describe("projects start at a site", () => {
  it("takes county and ZIP from the chosen site", async () => {
    const id = await createProject(db, editor, orgA, input(siteA));
    expect(await row(id)).toMatchObject({ zip: "28778", county_id: buncombe, site_id: siteA });
  });

  it("refuses another organization's site", async () => {
    await expect(createProject(db, editor, orgA, input(siteOther))).rejects.toMatchObject({ code: "VALIDATION", fieldErrors: { siteId: expect.anything() } });
  });

  it("refuses a site whose ZIP is not in a county the platform covers", async () => {
    await expect(createProject(db, editor, orgA, input(siteNoCounty))).rejects.toMatchObject({
      code: "VALIDATION", fieldErrors: { siteId: ["This location's ZIP is not in a county we cover"] },
    });
  });

  it("refuses a site in a county the organization does not serve", async () => {
    const orgC = (await sys((tx) => tx.query<{ org_id: string }>(`SELECT org_id FROM staging_sites WHERE id = $1`, [siteUnserved])))[0].org_id;
    await expect(createProject(db, editor, orgC, input(siteUnserved))).rejects.toMatchObject({
      code: "VALIDATION", fieldErrors: { siteId: ["Your organization's profile does not list this location's county as served"] },
    });
  });

  it("refuses an archived site", async () => {
    const gone = await createSite(db, editor, orgA, site({ name: "[TEST] Archived Hub", postalCode: "28778" }));
    await archiveSite(db, editor, gone);
    await expect(createProject(db, editor, orgA, input(gone))).rejects.toMatchObject({ code: "VALIDATION", fieldErrors: { siteId: expect.anything() } });
  });

  it("keeps the first five digits of a ZIP+4 site", async () => {
    const plus4 = await createSite(db, editor, orgA, site({ name: "[TEST] Plus Four Hub", postalCode: "28778-1234" }));
    const id = await createProject(db, editor, orgA, input(plus4));
    expect((await row(id)).zip).toBe("28778");
  });

  it("cannot be pinned to another organization's site even by direct SQL", async () => {
    const id = await createProject(db, editor, orgA, input(siteA, { title: "Direct SQL pin attempt" }));
    const code = await sys((tx) => tx.query(`UPDATE projects SET site_id = $2 WHERE id = $1`, [id, siteOther]))
      .then(() => "OK", (e) => (e as { code?: string }).code);
    expect(code).toBe("23514");
  });
});

describe("projects follow their site", () => {
  it("moves county and ZIP with the site, and an open project goes back for review", async () => {
    const mover = await createSite(db, editor, orgA, site({ name: "[TEST] Moving Hub", postalCode: "28778" }));
    const id = await createProject(db, editor, orgA, input(mover, { title: "Project at a moving site" }));
    await sys((tx) => tx.query(`UPDATE projects SET status = 'OPEN', reviewed_at = now() WHERE id = $1`, [id]));
    await updateSite(db, editor, mover, site({ name: "[TEST] Moving Hub", postalCode: hendersonZip, county: "Henderson" }));
    expect(await row(id)).toMatchObject({ zip: hendersonZip, county_id: henderson, status: "PENDING_REVIEW" });
  });

  it("leaves projects alone when the site moves to a ZIP with no covered county", async () => {
    const mover = await createSite(db, editor, orgA, site({ name: "[TEST] Leaving Hub", postalCode: "28778" }));
    const id = await createProject(db, editor, orgA, input(mover, { title: "Project at a leaving site" }));
    await updateSite(db, editor, mover, site({ name: "[TEST] Leaving Hub", postalCode: "29801", state: "SC" }));
    expect(await row(id)).toMatchObject({ zip: "28778", county_id: buncombe });
  });
});

describe("legacy projects without a site", () => {
  it("must choose a location before they can be submitted", async () => {
    const id = await createProject(db, editor, orgA, input(siteA, { title: "Legacy project without a site" }));
    await sys((tx) => tx.query(`UPDATE projects SET site_id = NULL WHERE id = $1`, [id]));
    await addNeed(db, editor, id, { title: "Helpers", slotsNeeded: 3 });
    await expect(submitProject(db, editor, id)).rejects.toMatchObject({ code: "VALIDATION", message: "Choose a location for this project" });
  });
});

describe("listProjectSites", () => {
  it("lists the organization's active sites and marks unusable ones with a reason", async () => {
    const sites = await listProjectSites(db, editor, orgA);
    const byName = Object.fromEntries(sites.map((s) => [s.name, s]));
    expect(byName["[TEST] Pinned Hub"]).toMatchObject({ usable: true, reason: null, zip: "28778", countyName: "Buncombe" });
    expect(byName["[TEST] No County Hub"]).toMatchObject({ usable: false, reason: "This location's ZIP is not in a county we cover" });
    expect(byName["[TEST] Archived Hub"]).toBeUndefined();
    expect(byName["[TEST] Other Org Hub"]).toBeUndefined();
  });

  it("is refused to people outside the organization", async () => {
    await expect(listProjectSites(db, otherEditor, orgA)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
