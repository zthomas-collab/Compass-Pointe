import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver, Tx } from "@/server/db";
import { runIn } from "@/server/db/context";
import { assignCountyAdmin, createCounty } from "@/server/modules/counties";
import { dismissSuggestion, linkProjectToEvent, listEventProjects, listSuggestions } from "@/server/modules/eventlinks";
import { createEvent, setEventStatus, updateEvent } from "@/server/modules/events";
import { addNeed, createProject, reviewProject, submitProject } from "@/server/modules/projects";
import { createSite } from "@/server/modules/sites";
import { freshDb } from "./helpers/db";
import { grantRole, makeOrg, makeUser, site } from "./helpers/fixtures";

/** Stage 5: geography suggests (project, event) pairs; a person confirms or dismisses. Suggestions are never public. */

let db: Driver;
let exec: string, editor: string, otherEditor: string, adminB: string, adminH: string;
let org: string, otherOrg: string, buncombe: string, henderson: string;
let siteB: string, siteB2: string, siteH: string, hendersonZip: string;
const sys = <T>(fn: (tx: Tx) => Promise<T>) => runIn(db, { kind: "system" }, fn);
const linkRows = (projectId: string) =>
  sys((tx) => tx.query<{ event_id: string; state: string }>(`SELECT event_id, state FROM project_event_links WHERE project_id = $1 ORDER BY event_id`, [projectId]));
const event = async (name: string, over: Record<string, unknown> = {}, status: "ACTIVE" | "RECOVERY" | null = "ACTIVE") => {
  const id = await createEvent(db, exec, { name, hazardType: "FLOOD", startsOn: "2026-09-10", countyIds: [buncombe], ...over });
  if (status) await setEventStatus(db, exec, id, "ACTIVE");
  if (status === "RECOVERY") await setEventStatus(db, exec, id, "RECOVERY");
  return id;
};
/** A project at a site, submitted and approved by the county administrator (which is when suggestions are made). */
const openProject = async (title: string, siteId = siteB) => {
  const id = await createProject(db, editor, org, { title, description: "Volunteers clear storm debris from yards.", siteId, audience: "COMMUNITY" });
  await addNeed(db, editor, id, { title: "Clean-up crew", slotsNeeded: 4 });
  await submitProject(db, editor, id);
  const reviewer = siteId === siteH ? adminH : adminB;
  await reviewProject(db, reviewer, id, { decision: "APPROVE", note: "Looks good, approved." });
  return id;
};

beforeAll(async () => {
  db = await freshDb();
  [exec, editor, otherEditor] = await Promise.all(["es-exec", "es-editor", "es-other"].map((n) => makeUser(db, `${n}@example.test`)));
  adminB = await makeUser(db, "es-admin-b@example.test");
  adminH = await makeUser(db, "es-admin-h@example.test");
  await grantRole(db, exec, "PLATFORM_ADMIN");
  buncombe = await createCounty(db, exec, { name: "Buncombe", state: "NC", fips: "37021" });
  henderson = await createCounty(db, exec, { name: "Henderson", state: "NC", fips: "37089" });
  await assignCountyAdmin(db, exec, { email: "es-admin-b@example.test", countyId: buncombe, reason: "Buncombe coordinator" });
  await assignCountyAdmin(db, exec, { email: "es-admin-h@example.test", countyId: henderson, reason: "Henderson coordinator" });
  org = await makeOrg(db, { name: "Suggest Org", members: [{ userId: editor, role: "EDITOR" }] });
  otherOrg = await makeOrg(db, { name: "Other Suggest Org", members: [{ userId: otherEditor, role: "EDITOR" }] });
  await sys((tx) => tx.query(`INSERT INTO organization_counties (org_id, county_id) VALUES ($1, $2), ($1, $3), ($4, $2)`, [org, buncombe, henderson, otherOrg]));
  hendersonZip = (await sys((tx) => tx.query<{ zip: string }>(
    `SELECT zip FROM zip_county WHERE county_fips = '37089'
        AND zip NOT IN (SELECT zip FROM zip_county WHERE county_fips <> '37089') ORDER BY zip LIMIT 1`)))[0].zip;
  siteB = await createSite(db, editor, org, site({ name: "[TEST] Suggest Hub", postalCode: "28801" }));
  siteB2 = await createSite(db, editor, org, site({ name: "[TEST] Suggest Hub East", postalCode: "28778" }));
  siteH = await createSite(db, editor, org, site({ name: "[TEST] Suggest Hub South", postalCode: hendersonZip, county: "Henderson" }));
});
afterAll(async () => db?.close());

describe("making suggestions", () => {
  it("approving a project suggests every active or recovery event covering its county, and nothing else", async () => {
    const active = await event("Active Buncombe Flood");
    const recovery = await event("Recovering Buncombe Flood", {}, "RECOVERY");
    const draft = await event("Draft Buncombe Flood", {}, null);
    const elsewhere = await event("Henderson Flood", { countyIds: [henderson] });
    const id = await openProject("Clear yards after the flood");
    const rows = await linkRows(id);
    expect(rows.filter((r) => r.state === "SUGGESTED").map((r) => r.event_id).sort()).toEqual([active, recovery].sort());
    expect(rows.map((r) => r.event_id)).not.toContain(draft);
    expect(rows.map((r) => r.event_id)).not.toContain(elsewhere);
  });

  it("a ZIP-narrowed event suggests only projects in its ZIPs", async () => {
    const zipEvent = await event("Swannanoa Flash Flood", { zips: ["28778"] });
    const inside = await openProject("Muck out Swannanoa basements", siteB2);
    const outside = await openProject("Muck out downtown basements", siteB);
    expect((await linkRows(inside)).map((r) => r.event_id)).toContain(zipEvent);
    expect((await linkRows(outside)).map((r) => r.event_id)).not.toContain(zipEvent);
  });

  it("activating a draft event suggests existing open projects in its area", async () => {
    const id = await openProject("Haul debris to the curb");
    const later = await event("Later Buncombe Storm", {}, null);
    expect((await linkRows(id)).map((r) => r.event_id)).not.toContain(later);
    await setEventStatus(db, exec, later, "ACTIVE");
    expect(await linkRows(id)).toContainEqual({ event_id: later, state: "SUGGESTED" });
  });

  it("widening an active event's area suggests the open projects now inside it", async () => {
    const id = await openProject("Tarp roofs in Henderson", siteH);
    const growing = await event("Growing Storm");
    expect((await linkRows(id)).map((r) => r.event_id)).not.toContain(growing);
    await updateEvent(db, exec, growing, { name: "Growing Storm", hazardType: "FLOOD", startsOn: "2026-09-10", countyIds: [buncombe, henderson] });
    expect(await linkRows(id)).toContainEqual({ event_id: growing, state: "SUGGESTED" });
  });

  it("re-running never duplicates a suggestion and never revives a dismissed link", async () => {
    const ev = await event("Repeat Storm");
    const id = await openProject("Sort supplies at the hub");
    await dismissSuggestion(db, editor, id, ev);
    await updateEvent(db, exec, ev, { name: "Repeat Storm", hazardType: "FLOOD", startsOn: "2026-09-10", countyIds: [buncombe] });
    await setEventStatus(db, exec, ev, "RECOVERY");
    const rows = (await linkRows(id)).filter((r) => r.event_id === ev);
    expect(rows).toEqual([{ event_id: ev, state: "DISMISSED" }]);
  });
});

describe("deciding on suggestions", () => {
  let ev: string, id: string;
  beforeAll(async () => {
    ev = await event("Decision Storm");
    id = await openProject("Rebuild a wheelchair ramp");
  });
  const pairs = async (who: string, scope: { projectId: string } | { eventId: string }) =>
    (await listSuggestions(db, who, scope)).filter((s) => s.eventId === ev && s.projectId === id);

  it("the org editor and the county administrator see the suggestion; others do not", async () => {
    expect(await pairs(editor, { projectId: id })).toEqual([
      expect.objectContaining({ projectTitle: "Rebuild a wheelchair ramp", eventName: "Decision Storm", orgName: "[TEST] Suggest Org" }),
    ]);
    expect(await pairs(adminB, { eventId: ev })).toHaveLength(1);
    expect(await pairs(otherEditor, { projectId: id })).toEqual([]);
    expect(await pairs(adminH, { eventId: ev })).toEqual([]);
  });

  it("suggestions are not public", async () => {
    expect((await listEventProjects(db, ev)).map((p) => p.id)).not.toContain(id);
  });

  it("another org's editor and another county's administrator cannot dismiss", async () => {
    await expect(dismissSuggestion(db, otherEditor, id, ev)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(dismissSuggestion(db, adminH, id, ev)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("confirming makes it public and removes it from the suggestions", async () => {
    await linkProjectToEvent(db, editor, id, ev);
    expect((await listEventProjects(db, ev)).map((p) => p.id)).toContain(id);
    expect(await pairs(editor, { projectId: id })).toEqual([]);
  });

  it("dismissing hides it from the suggestions and records who decided", async () => {
    const ev2 = await event("Dismissal Storm");
    const pid = await openProject("Deliver water to seniors");
    await dismissSuggestion(db, adminB, pid, ev2);
    expect((await listSuggestions(db, adminB, { eventId: ev2 })).map((s) => s.projectId)).not.toContain(pid);
    const row = (await sys((tx) => tx.query<{ state: string; decided_by_role: string }>(
      `SELECT state, decided_by_role FROM project_event_links WHERE project_id = $1 AND event_id = $2`, [pid, ev2])))[0];
    expect(row).toEqual({ state: "DISMISSED", decided_by_role: "ADMIN" });
  });

  it("dismissing something that is not a suggestion is NOT_FOUND", async () => {
    await expect(dismissSuggestion(db, editor, id, ev)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("a suggestion for a project that moved out of the area is not listed", async () => {
    const ev3 = await event("Moving Storm");
    const mover = await createSite(db, editor, org, site({ name: "[TEST] Suggest Mover", postalCode: "28801" }));
    const pid = await openProject("Project that moves away", mover);
    expect((await listSuggestions(db, editor, { projectId: pid })).map((s) => s.eventId)).toContain(ev3);
    await sys((tx) => tx.query(`UPDATE projects SET county_id = $2, zip = $3 WHERE id = $1`, [pid, henderson, hendersonZip]));
    expect((await listSuggestions(db, editor, { projectId: pid })).map((s) => s.eventId)).not.toContain(ev3);
  });
});
