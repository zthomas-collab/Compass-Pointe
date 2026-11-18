import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver } from "@/server/db";
import { runIn } from "@/server/db/context";
import { createCounty } from "@/server/modules/counties";
import { createEvent, getEventHelp, setEventStatus } from "@/server/modules/events";
import { createSite, updateSite } from "@/server/modules/sites";
import { freshDb } from "./helpers/db";
import { grantRole, makeOrg, makeUser, site } from "./helpers/fixtures";

/** Migration 0018: a site's county comes from its ZIP, so sites and projects match event areas the same way. */

let db: Driver;
let exec: string, editor: string, org: string, buncombe: string, henderson: string;

const countyOf = async (siteId: string) =>
  (await runIn(db, { kind: "system" }, (tx) =>
    tx.query<{ county_id: string | null }>(`SELECT county_id FROM staging_sites WHERE id = $1`, [siteId])))[0].county_id;

beforeAll(async () => {
  db = await freshDb();
  exec = await makeUser(db, "sc-exec@example.test");
  editor = await makeUser(db, "sc-editor@example.test");
  await grantRole(db, exec, "PLATFORM_ADMIN");
  buncombe = await createCounty(db, exec, { name: "Buncombe", state: "NC", fips: "37021" });
  henderson = await createCounty(db, exec, { name: "Henderson", state: "NC", fips: "37089" });
  org = await makeOrg(db, { name: "Site County Org", members: [{ userId: editor, role: "EDITOR" }] });
});
afterAll(async () => db?.close());

describe("site county from ZIP", () => {
  it("derives county_id from the ZIP on create", async () => {
    const id = await createSite(db, editor, org, site({ name: "[TEST] Swannanoa", postalCode: "28778" }));
    expect(await countyOf(id)).toBe(buncombe);
  });

  it("uses the first five digits of a ZIP+4", async () => {
    const id = await createSite(db, editor, org, site({ name: "[TEST] Zip Plus Four", postalCode: "28778-1234" }));
    expect(await countyOf(id)).toBe(buncombe);
  });

  it("leaves county_id null for a ZIP the platform has no county for", async () => {
    const id = await createSite(db, editor, org, site({ name: "[TEST] Aiken", postalCode: "29801", state: "SC", county: "Aiken" }));
    expect(await countyOf(id)).toBeNull();
  });

  it("does not fall back to a minor county when the ZIP's main county is not on the platform", async () => {
    // 28753 is 98% Madison (not created here) and 2% Buncombe.
    const id = await createSite(db, editor, org, site({ name: "[TEST] Marshall", postalCode: "28753", county: "Madison" }));
    expect(await countyOf(id)).toBeNull();
  });

  it("fills in a site's county once that county is added to the platform", async () => {
    // 28714 is Yancey County, which is not on the platform yet.
    const id = await createSite(db, editor, org, site({ name: "[TEST] Burnsville", postalCode: "28714", county: "Yancey" }));
    expect(await countyOf(id)).toBeNull();
    const yancey = await createCounty(db, exec, { name: "Yancey", state: "NC", fips: "37199" });
    expect(await countyOf(id)).toBe(yancey);
  });

  it("re-derives on update", async () => {
    const id = await createSite(db, editor, org, site({ name: "[TEST] Mover", postalCode: "28778" }));
    const hendersonZip = (await runIn(db, { kind: "system" }, (tx) => tx.query<{ zip: string }>(
      `SELECT zip FROM zip_county WHERE county_fips = '37089'
          AND zip NOT IN (SELECT zip FROM zip_county WHERE county_fips <> '37089') ORDER BY zip LIMIT 1`)))[0].zip;
    await updateSite(db, editor, id, site({ name: "[TEST] Mover", postalCode: hendersonZip, county: "Henderson" }));
    expect(await countyOf(id)).toBe(henderson);
  });
});

describe("event Help matching", () => {
  let event: string;
  beforeAll(async () => {
    event = await createEvent(db, exec, { name: "County Match Flood", hazardType: "FLOOD", startsOn: "2026-09-10", countyIds: [buncombe] });
    await setEventStatus(db, exec, event, "ACTIVE");
  });
  const names = async () => (await getEventHelp(db, event)).map((h) => h.siteName);

  it("matches by county_id even when the typed county name is wrong", async () => {
    await createSite(db, editor, org, site({ name: "[TEST] Misspelled County", county: "Bunkum", postalCode: "28778" }));
    expect(await names()).toContain("[TEST] Misspelled County");
  });

  it("falls back to the name match when county_id is null", async () => {
    await createSite(db, editor, org, site({ name: "[TEST] No Zip Named", county: "Buncombe", postalCode: "" }));
    await createSite(db, editor, org, site({ name: "[TEST] No Zip Other", county: "Henderson", postalCode: "" }));
    const n = await names();
    expect(n).toContain("[TEST] No Zip Named");
    expect(n).not.toContain("[TEST] No Zip Other");
  });

  it("does not match a site whose derived county is outside the event even if its typed name matches", async () => {
    await createSite(db, editor, org, site({ name: "[TEST] Wrong Typed", county: "Buncombe", postalCode: "29801", state: "SC" }));
    expect(await names()).not.toContain("[TEST] Wrong Typed");
  });
});
