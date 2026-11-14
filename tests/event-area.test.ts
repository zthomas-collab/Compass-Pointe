import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver, Tx } from "@/server/db";
import { runIn } from "@/server/db/context";
import { assignCountyAdmin, createCounty } from "@/server/modules/counties";
import { createEvent, getPublicEventArea, linkProject, setEventStatus, setEventVisibility } from "@/server/modules/events";
import { submitOffer } from "@/server/modules/offers";
import { addNeed, createProject, proposeCommitment, reportProgress, respondToCommitment, setProjectStatus, setProjectVisibility } from "@/server/modules/projects";
import { createResource, createSite } from "@/server/modules/sites";
import { syncZipCounty } from "@/server/modules/zipcounty";
import { freshDb } from "./helpers/db";
import { grantRole, makeOrg, makeUser, site } from "./helpers/fixtures";

let db: Driver;
let exec: string, adminA: string, editor: string;
let countyA: string, org: string;
let eventRef = "", privateEventRef = "";
const sys = <T>(fn: (tx: Tx) => Promise<T>) => runIn(db, { kind: "system" }, fn);
let seq = 0;
const offerForm = (over: Record<string, unknown> = {}) => ({
  contributorName: "Pat Giver", email: `g-${seq++}@example.test`, zip: "28801", contributionType: "DRINKING_WATER", quantity: "1000", unit: "cases", description: "Water pallets.", consentContact: "on", ...over,
});

/** Delivers `verified` units of a need so the public numbers move. */
async function verify(needId: string, type: string, quantity: number, verified: number) {
  const offer = await submitOffer(db, offerForm({ contributionType: type, quantity: String(quantity) }));
  const k = await proposeCommitment(db, adminA, { needId, offerId: offer.id, quantity });
  await respondToCommitment(db, adminA, { commitmentId: k, accept: "accept", note: "Confirmed by phone on Monday." });
  await reportProgress(db, adminA, { commitmentId: k, stage: "DISPATCHED", quantity });
  await reportProgress(db, adminA, { commitmentId: k, stage: "RECEIVED", quantity, receiverName: "Dana" });
  await reportProgress(db, adminA, { commitmentId: k, stage: "VERIFIED", quantity: verified, receiverName: "Dana" });
}
async function project(title: string, zips: string, category: string, needs: { label: string; type: string; unit: string; qty: number }[], opts: { publish: boolean; eventId?: string; priority?: string }) {
  const p = await createProject(db, adminA, { title, description: "Residents need this resource urgently.", countyId: countyA, zips, category, priority: opts.priority ?? "NORMAL" });
  const ids: string[] = [];
  for (const n of needs) ids.push(await addNeed(db, adminA, { projectId: p.id, label: n.label, contributionType: n.type, unit: n.unit, quantity: n.qty }));
  await setProjectStatus(db, adminA, p.id, "ACTIVE");
  if (opts.publish) await setProjectVisibility(db, adminA, { projectId: p.id, visibility: "PUBLIC", publicSummary: `Public summary for ${title}.` });
  if (opts.eventId) await linkProject(db, adminA, opts.eventId, p.id);
  return { ...p, needIds: ids };
}

beforeAll(async () => {
  db = await freshDb();
  [exec, adminA, editor] = await Promise.all(["exec", "admin-a", "editor"].map((n) => makeUser(db, `${n}@example.test`)));
  await grantRole(db, exec, "PLATFORM_ADMIN");
  countyA = await createCounty(db, exec, { name: "Buncombe", state: "NC" });
  await assignCountyAdmin(db, exec, { email: "admin-a@example.test", countyId: countyA, reason: "County A coordinator" });
  await sys((tx) => tx.query(`UPDATE platform_settings SET value = to_jsonb('stale'::text) WHERE key = 'zip_county_sha256'`));
  await syncZipCounty(db);
  org = await makeOrg(db, { name: "Water Relief", consent: true, members: [{ userId: editor, role: "EDITOR" }] });

  // Public sites in two of the event's ZIPs, one restricted site in an event ZIP, one public site outside the event's ZIPs.
  const s1 = await createSite(db, editor, org, site({ name: "Riverside Water Distribution", postalCode: "28801", city: "Asheville" }));
  const s2 = await createSite(db, editor, org, site({ name: "Fire Hall Pantry", postalCode: "28803", city: "Asheville" }));
  const hidden = await createSite(db, editor, org, site({ name: "Restricted Staging Yard", postalCode: "28801", visibility: "AUTHORIZED_RESPONDERS" }));
  await createSite(db, editor, org, site({ name: "Faraway Site", postalCode: "28806", city: "Asheville" }));
  await createResource(db, editor, s1, { categoryCode: "WATER", name: "Bottled water pickup", visibility: "PUBLIC", availabilityStatus: "AVAILABLE", reportedQuantity: "300", quantityUnit: "cases" });
  await createResource(db, editor, s1, { categoryCode: "EQUIPMENT", name: "Restricted generator cache", visibility: "AUTHORIZED_RESPONDERS", availabilityStatus: "AVAILABLE" });
  await createResource(db, editor, s2, { categoryCode: "FOOD", name: "Food boxes", visibility: "PUBLIC", availabilityStatus: "LIMITED" });
  await createResource(db, editor, hidden, { categoryCode: "FOOD", name: "Hidden stock", visibility: "AUTHORIZED_RESPONDERS", availabilityStatus: "AVAILABLE" });

  const ev = await createEvent(db, adminA, { name: "Hurricane response", description: "Coordination after the storm.", category: "HURRICANE", countyId: countyA, zips: "28801, 28803", startDate: "2026-11-10", endDate: "2026-12-10" });
  const priv = await createEvent(db, adminA, { name: "Private planning event", description: "Not for the public yet.", category: "FLOOD", countyId: countyA, zips: "28801", startDate: "2026-11-10" });
  privateEventRef = priv.reference;
  await setEventStatus(db, adminA, ev.id, "ACTIVE");
  await setEventVisibility(db, adminA, { eventId: ev.id, visibility: "PUBLIC", publicSummary: "Storm recovery coordination for these ZIP codes." });
  eventRef = ev.reference;

  const water = await project("Emergency drinking water", "28801", "DRINKING_WATER", [{ label: "Bottled drinking water", type: "DRINKING_WATER", unit: "cases", qty: 1000 }, { label: "Water jugs", type: "DRINKING_WATER", unit: "jugs", qty: 50 }], { publish: true, eventId: ev.id, priority: "CRITICAL" });
  await verify(water.needIds[0], "DRINKING_WATER", 400, 400); // 400 of 1,000 delivered: 600 still needed
  await verify(water.needIds[1], "DRINKING_WATER", 50, 50); // fully met: counted, not listed
  await project("Food boxes for the fire hall area", "28803", "FOOD", [{ label: "Food boxes", type: "FOOD", unit: "boxes", qty: 200 }], { publish: true, eventId: ev.id, priority: "HIGH" });
  await project("Private linked project", "28801", "FOOD", [{ label: "SECRET-PRIVATE-NEED", type: "FOOD", unit: "boxes", qty: 5 }], { publish: false, eventId: ev.id });
  await project("Public but unlinked project", "28801", "FOOD", [{ label: "UNLINKED-NEED", type: "FOOD", unit: "boxes", qty: 5 }], { publish: true });
});
afterAll(async () => db?.close());

describe("public event area", () => {
  it("returns dates as plain YYYY-MM-DD text", async () => {
    const { getPublicEvent, listPublicEvents } = await import("@/server/modules/events");
    const e = (await getPublicEvent(db, eventRef))!.event;
    expect(e.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(e.endDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect((await listPublicEvents(db))[0].startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("is available only for public events", async () => {
    expect(await getPublicEventArea(db, privateEventRef)).toBeNull();
    expect(await getPublicEventArea(db, "EVT-2026-999999")).toBeNull();
    expect(await getPublicEventArea(db, "not-a-reference")).toBeNull();
    expect(await getPublicEventArea(db, eventRef)).not.toBeNull();
  });

  it("lists current unmet needs by ZIP from published, linked projects only, with fully met needs counted but not listed", async () => {
    const a = (await getPublicEventArea(db, eventRef))!;
    expect(a.zips).toEqual(["28801", "28803"]);
    const z1 = a.needsByZip.find((z) => z.zip === "28801")!;
    expect(z1.needs).toHaveLength(1);
    expect(z1.needs[0]).toMatchObject({ label: "Bottled drinking water", requested: 1000, verified: 400, remaining: 600, percent: 40, priority: "CRITICAL" });
    expect(z1.metCount).toBe(1); // the water jugs need is complete
    const z2 = a.needsByZip.find((z) => z.zip === "28803")!;
    expect(z2.needs.map((n) => n.label)).toEqual(["Food boxes"]);
    expect(z2.needs[0]).toMatchObject({ remaining: 200, verified: 0 });
    expect(a.totals.openNeeds).toBe(2);
    const blob = JSON.stringify(a);
    expect(blob).not.toContain("SECRET-PRIVATE-NEED"); // linked but not published
    expect(blob).not.toContain("UNLINKED-NEED"); // published but not part of this event
  });

  it("lists publicly listed resources by ZIP, never restricted sites or resources, and nothing outside the event's ZIP codes", async () => {
    const a = (await getPublicEventArea(db, eventRef))!;
    const z1 = a.resourcesByZip.find((z) => z.zip === "28801")!;
    expect(z1.sites.map((s) => s.name)).toEqual(["Riverside Water Distribution"]);
    expect(z1.sites[0].resources.map((r) => r.name)).toEqual(["Bottled water pickup"]);
    expect(z1.sites[0].resources[0]).toMatchObject({ status: "AVAILABLE", quantity: 300, unit: "cases" });
    expect(a.resourcesByZip.find((z) => z.zip === "28803")!.sites[0].resources[0]).toMatchObject({ name: "Food boxes", status: "LIMITED" });
    const blob = JSON.stringify(a);
    for (const secret of ["Restricted Staging Yard", "Restricted generator cache", "Hidden stock", "Faraway Site", "@example.test", "private-contact"]) expect(blob).not.toContain(secret);
    expect(a.totals).toMatchObject({ sites: 2, resources: 2 });
    expect(z1.sites[0]).toMatchObject({ lat: expect.any(Number), lng: expect.any(Number) }); // enough to open directions
  });

  it("narrows to one ZIP code and ignores a ZIP that is not part of the event", async () => {
    const one = (await getPublicEventArea(db, eventRef, { zip: "28803" }))!;
    expect(one.needsByZip.map((z) => z.zip)).toEqual(["28803"]);
    expect(one.resourcesByZip.map((z) => z.zip)).toEqual(["28803"]);
    expect(one.zips).toEqual(["28801", "28803"]); // the full list stays available for the filter chips
    expect((await getPublicEventArea(db, eventRef, { zip: "28806" }))!.needsByZip.map((z) => z.zip)).toEqual(["28801", "28803"]);
    expect((await getPublicEventArea(db, eventRef, { zip: "x'; DROP TABLE events;--" }))!.zips).toEqual(["28801", "28803"]);
  });

  it("follows the data: when a need is fully delivered it drops off the list", async () => {
    const a = (await getPublicEventArea(db, eventRef))!;
    const food = a.needsByZip.find((z) => z.zip === "28803")!.needs[0];
    const p = await sys((tx) => tx.query<{ id: string }>(`SELECT p.id FROM community_projects p JOIN project_needs n ON n.project_id = p.id WHERE n.label = 'Food boxes' LIMIT 1`));
    const need = (await sys((tx) => tx.query<{ id: string }>(`SELECT id FROM project_needs WHERE project_id = $1`, [p[0].id])))[0].id;
    await verify(need, "FOOD", 200, 200);
    const after = (await getPublicEventArea(db, eventRef))!;
    expect(after.needsByZip.find((z) => z.zip === "28803")!.needs).toEqual([]);
    expect(after.needsByZip.find((z) => z.zip === "28803")!.metCount).toBe(1);
    expect(food.remaining).toBe(200);
  });
});
