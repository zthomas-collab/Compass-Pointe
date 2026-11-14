import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver, Tx } from "@/server/db";
import { runIn } from "@/server/db/context";
import { submitApplication } from "@/server/modules/assistance";
import { assignCountyAdmin, createCounty } from "@/server/modules/counties";
import {
  addEventOrganization, addEventUpdate, addRequirement, addTask, createEvent, getEvent, getPublicEvent, linkProject, listEvents, listLogistics, listPublicEvents,
  setEventStatus, setEventVisibility, setTaskStatus, updateEvent,
} from "@/server/modules/events";
import { submitOffer } from "@/server/modules/offers";
import { addNeed, addParticipant, createProject, proposeCommitment, reportProgress, respondToCommitment, setProjectStatus } from "@/server/modules/projects";
import { getDashboard, getOrgDashboard } from "@/server/modules/reports";
import { syncZipCounty } from "@/server/modules/zipcounty";
import { freshDb } from "./helpers/db";
import { grantRole, makeOrg, makeUser } from "./helpers/fixtures";

let db: Driver;
let exec: string, adminA: string, adminB: string, orgMember: string, otherMember: string, resident: string;
let countyA: string, countyB: string, orgP: string, orgQ: string;
const sys = <T>(fn: (tx: Tx) => Promise<T>) => runIn(db, { kind: "system" }, fn);
const code = (p: Promise<unknown>) => p.then(() => "OK", (e) => (e as { code?: string }).code ?? "ERR");
let seq = 0;
const eventForm = (over: Record<string, unknown> = {}) => ({
  name: "Hurricane response", description: "Flooding and wind damage across the county.", category: "HURRICANE", countyId: countyA, zips: "28801, 28803", startDate: "2026-11-20", endDate: "2026-12-05", ...over,
});
const offerForm = (over: Record<string, unknown> = {}) => ({
  contributorName: "Pat Giver", email: `g-${seq++}@example.test`, zip: "28801", contributionType: "DRINKING_WATER", quantity: "100", unit: "cases", description: "Water pallets.", consentContact: "on", ...over,
});

beforeAll(async () => {
  db = await freshDb();
  [exec, adminA, adminB, orgMember, otherMember, resident] = await Promise.all(["exec", "admin-a", "admin-b", "org-member", "other-member", "resident"].map((n) => makeUser(db, `${n}@example.test`)));
  await grantRole(db, exec, "PLATFORM_ADMIN");
  countyA = await createCounty(db, exec, { name: "Buncombe", state: "NC" });
  countyB = await createCounty(db, exec, { name: "Aiken", state: "SC" });
  await assignCountyAdmin(db, exec, { email: "admin-a@example.test", countyId: countyA, reason: "County A coordinator" });
  await assignCountyAdmin(db, exec, { email: "admin-b@example.test", countyId: countyB, reason: "County B coordinator" });
  orgP = await makeOrg(db, { name: "Relief P", members: [{ userId: orgMember, role: "EDITOR" }] });
  orgQ = await makeOrg(db, { name: "Other Q", members: [{ userId: otherMember, role: "EDITOR" }] });
  await sys((tx) => tx.query(`UPDATE platform_settings SET value = to_jsonb('stale'::text) WHERE key = 'zip_county_sha256'`));
  await syncZipCounty(db);
});
afterAll(async () => db?.close());

describe("events", () => {
  it("are created by the county's coordinators with ZIPs that belong to it, private by default", async () => {
    const { id, reference } = await createEvent(db, adminA, eventForm());
    expect(reference).toMatch(/^EVT-\d{4}-\d{6}$/);
    const e = await getEvent(db, adminA, id);
    expect(e).toMatchObject({ status: "SCHEDULED", visibility: "PRIVATE", zips: ["28801", "28803"], canManage: true });
    expect(await code(createEvent(db, adminB, eventForm()))).toBe("FORBIDDEN");
    expect(await code(createEvent(db, adminB, eventForm({ countyId: countyB })))).toBe("VALIDATION"); // 28801 is not in Aiken
    expect(await code(createEvent(db, adminA, eventForm({ endDate: "2026-11-01" })))).toBe("VALIDATION");
    expect(await code(getEvent(db, adminB, id))).toBe("NOT_FOUND");
    expect((await listEvents(db, adminB)).some((x) => x.id === id)).toBe(false);
    expect((await listEvents(db, exec)).some((x) => x.id === id)).toBe(true);
    expect(await getPublicEvent(db, reference)).toBeNull();
  });

  it("move Scheduled -> Active -> Completed, refuse shortcuts, and freeze when closed", async () => {
    const { id } = await createEvent(db, adminA, eventForm());
    expect(await code(setEventStatus(db, adminA, id, "COMPLETED"))).toBe("CONFLICT");
    await setEventStatus(db, adminA, id, "ACTIVE");
    await updateEvent(db, adminA, { eventId: id, name: "Hurricane response (updated)", description: "Updated description.", startDate: "2026-11-20", internalNotes: "Staging at the fairgrounds." });
    expect((await getEvent(db, adminA, id)).internalNotes).toBe("Staging at the fairgrounds.");
    await setEventStatus(db, adminA, id, "COMPLETED");
    expect(await code(setEventStatus(db, adminA, id, "ACTIVE"))).toBe("CONFLICT");
    expect(await code(addTask(db, adminA, { eventId: id, title: "Too late" }))).toBe("CONFLICT");
    await expect(sys((tx) => tx.query(`UPDATE events SET status = 'ACTIVE' WHERE id = $1`, [id]))).rejects.toThrow(); // the database refuses too
  });

  it("run a task board: assignments, status moves by coordinators and by the assigned organization only", async () => {
    const { id } = await createEvent(db, adminA, eventForm());
    expect(await code(addTask(db, adminA, { eventId: id, title: "Open the water site", assigneeOrgId: orgP }))).toBe("VALIDATION"); // not a participant yet
    await addEventOrganization(db, adminA, id, orgP);
    const t = await addTask(db, adminA, { eventId: id, title: "Open the water site", assigneeOrgId: orgP, priority: "HIGH", dueDate: "2020-01-01" });
    const other = await addTask(db, adminA, { eventId: id, title: "Coordinate transport", priority: "LOW" });
    expect(await code(addTask(db, adminA, { eventId: id, title: "Bad assignee", assigneeEmail: "resident@example.test" }))).toBe("VALIDATION");
    await addTask(db, adminA, { eventId: id, title: "Own task", assigneeEmail: "admin-a@example.test" });

    await setTaskStatus(db, orgMember, t, "IN_PROGRESS"); // the assigned organization moves its own task
    expect(await code(setTaskStatus(db, orgMember, other, "DONE"))).toBe("NOT_FOUND"); // not assigned to it
    expect(await code(setTaskStatus(db, otherMember, t, "DONE"))).toBe("NOT_FOUND"); // another organization
    expect(await code(setTaskStatus(db, adminB, t, "DONE"))).toBe("NOT_FOUND"); // another county

    const asOrg = await getEvent(db, orgMember, id);
    expect(asOrg.tasks.map((x) => x.id)).toEqual([t]); // a participant sees only tasks assigned to it
    expect(asOrg.canManage).toBe(false);
    expect(asOrg.internalNotes).toBeNull();
    expect(await code(getEvent(db, otherMember, id))).toBe("NOT_FOUND");

    await setTaskStatus(db, adminA, other, "DONE");
    const e = await getEvent(db, adminA, id);
    expect(e.metrics).toMatchObject({ tasksTotal: 3, tasksDone: 1, tasksOverdue: 1, percentTasksDone: 33 });
    const done = await sys((tx) => tx.query<{ completed_at: Date | null }>(`SELECT completed_at FROM event_tasks WHERE id = $1`, [other]));
    expect(done[0].completed_at).not.toBeNull();
    await setTaskStatus(db, adminA, other, "TODO");
    expect((await sys((tx) => tx.query<{ completed_at: Date | null }>(`SELECT completed_at FROM event_tasks WHERE id = $1`, [other])))[0].completed_at).toBeNull();
  });

  it("show every task in one sortable logistics table, scoped to what the caller may see", async () => {
    const { id } = await createEvent(db, adminA, eventForm({ name: "Logistics event" }));
    await addTask(db, adminA, { eventId: id, title: "Zeta", priority: "LOW", dueDate: "2026-12-01" });
    await addTask(db, adminA, { eventId: id, title: "Alpha", priority: "CRITICAL", dueDate: "2026-11-25" });
    const byPriority = (await listLogistics(db, adminA, { eventId: id, sort: "priority" })).map((t) => t.title);
    expect(byPriority).toEqual(["Alpha", "Zeta"]);
    const byDue = (await listLogistics(db, adminA, { eventId: id, sort: "due", dir: "desc" })).map((t) => t.title);
    expect(byDue).toEqual(["Zeta", "Alpha"]);
    expect((await listLogistics(db, adminB, { eventId: id })).length).toBe(0);
    expect(await code(listLogistics(db, resident))).toBe("FORBIDDEN");
    expect(await code(listLogistics(db, adminA, { sort: "DROP TABLE" }))).toBe("VALIDATION");
  });

  it("publish only a summary, ZIP codes, dates and status; never tasks, organizations or notes", async () => {
    const { id, reference } = await createEvent(db, adminA, eventForm({ name: "Public storm event" }));
    await addEventOrganization(db, adminA, id, orgP);
    await addTask(db, adminA, { eventId: id, title: "SECRET-TASK-TITLE", assigneeOrgId: orgP });
    await updateEvent(db, adminA, { eventId: id, name: "Public storm event", description: "SECRET-DESCRIPTION-TEXT here.", startDate: "2026-11-20", internalNotes: "SECRET-NOTES staging at the old mill" });
    await addEventUpdate(db, adminA, id, "SECRET internal update", false);
    await addEventUpdate(db, adminA, id, "Distribution site opens Monday.", true);
    expect(await code(setEventVisibility(db, adminA, { eventId: id, visibility: "PUBLIC" }))).toBe("VALIDATION");
    await setEventVisibility(db, adminA, { eventId: id, visibility: "PUBLIC", publicSummary: "Storm recovery coordination for these ZIP codes." });
    const pub = await getPublicEvent(db, reference);
    expect(pub!.event).toMatchObject({ name: "Public storm event", zips: ["28801", "28803"], countyName: "Buncombe" });
    const blob = JSON.stringify(pub) + JSON.stringify(await listPublicEvents(db));
    for (const secret of ["SECRET-TASK-TITLE", "SECRET-DESCRIPTION", "SECRET-NOTES", "SECRET internal", "Relief P"]) expect(blob).not.toContain(secret);
    expect(pub!.updates.map((u) => u.body)).toEqual(["Distribution site opens Monday."]);
    for (const table of ["events", "event_tasks", "event_updates", "event_organizations"]) {
      await expect(runIn(db, { kind: "anon" }, (tx) => tx.query(`SELECT * FROM ${table}`))).rejects.toThrow();
    }
    // Column-level protection: even a signed-in request role cannot read internal notes.
    await expect(runIn(db, { kind: "viewer", userId: adminA }, (tx) => tx.query(`SELECT internal_notes FROM events`))).rejects.toThrow();
  });

  it("track requirements and roll linked projects' verified progress into the event report", async () => {
    const { id } = await createEvent(db, adminA, eventForm({ name: "Report event" }));
    await addRequirement(db, adminA, { eventId: id, kind: "SUPPLY", label: "Drinking water", quantity: 500, unit: "cases" });
    await addRequirement(db, adminA, { eventId: id, kind: "VOLUNTEER", label: "Drivers", quantity: 12, unit: "people" });
    expect(await code(addRequirement(db, adminB, { eventId: id, kind: "SUPPLY", label: "Extra supply", quantity: 1, unit: "box" }))).toBe("NOT_FOUND");
    const proj = await createProject(db, adminA, { title: "Water for the event", description: "Water distribution.", countyId: countyA, zips: "28801", category: "DRINKING_WATER" });
    const need = await addNeed(db, adminA, { projectId: proj.id, label: "Water", contributionType: "DRINKING_WATER", unit: "cases", quantity: 100 });
    await setProjectStatus(db, adminA, proj.id, "ACTIVE");
    const otherCounty = await createProject(db, adminB, { title: "Other county project", description: "Elsewhere entirely.", countyId: countyB, zips: "29801", category: "FOOD" });
    expect(await code(linkProject(db, adminA, id, otherCounty.id))).toBe("VALIDATION");
    await linkProject(db, adminA, id, proj.id);
    const offer = await submitOffer(db, offerForm());
    const k = await proposeCommitment(db, adminA, { needId: need, offerId: offer.id, quantity: 100 });
    await respondToCommitment(db, adminA, { commitmentId: k, accept: "accept", note: "Confirmed by phone on Monday." });
    await reportProgress(db, adminA, { commitmentId: k, stage: "DISPATCHED", quantity: 100 });
    await reportProgress(db, adminA, { commitmentId: k, stage: "RECEIVED", quantity: 100, receiverName: "Dana" });
    await reportProgress(db, adminA, { commitmentId: k, stage: "VERIFIED", quantity: 50, receiverName: "Dana" });
    const e = await getEvent(db, adminA, id);
    expect(e.requirements.map((r) => r.label).sort()).toEqual(["Drinking water", "Drivers"]);
    expect(e.projects).toEqual([expect.objectContaining({ reference: proj.reference, percentVerified: 50 })]);
  });
});

describe("dashboards are computed from live records and scoped by role", () => {
  it("executive and county dashboards count real data, and a county administrator sees only their county", async () => {
    // County A: 1 pending application, 1 outstanding donation, 1 volunteer, an active project with an open need, an active event.
    process.env.ASSISTANCE_ENABLED = "true";
    try {
      await submitApplication(db, resident, {
        countyId: countyA, zip: "28801", categoryCode: "HOUSING", summary: "Roof damage after storm", situation: "The roof collapsed in the storm.", householdSize: "3",
        contactPhone: "", preferredContact: "EMAIL", consentShareProviders: "on",
      });
    } finally {
      delete process.env.ASSISTANCE_ENABLED;
    }
    await submitOffer(db, offerForm({ contributionType: "FOOD", quantity: "40", unit: "boxes" }));
    await submitOffer(db, offerForm({ contributionType: "VOLUNTEER_LABOR", quantity: "6", unit: "people" }));
    const ev = await createEvent(db, adminA, eventForm({ name: "Dashboard event" }));
    await setEventStatus(db, adminA, ev.id, "ACTIVE");
    // County B: one active project with an open need and one application.
    const pb = await createProject(db, adminB, { title: "Food for Aiken", description: "Food distribution for Aiken.", countyId: countyB, zips: "29801", category: "FOOD" });
    await addNeed(db, adminB, { projectId: pb.id, label: "Food boxes", contributionType: "FOOD", unit: "boxes", quantity: 200 });
    await setProjectStatus(db, adminB, pb.id, "ACTIVE");

    const A = await getDashboard(db, adminA);
    const B = await getDashboard(db, adminB);
    const X = await getDashboard(db, exec);
    expect(A.scope).toBe("COUNTY");
    expect(X.scope).toBe("EXECUTIVE");
    expect(A.counties.map((c) => c.id)).toEqual([countyA]);
    expect(A.metrics.pendingApplications).toBe(1);
    expect(A.metrics.newRequests).toBe(1);
    expect(B.metrics.pendingApplications).toBe(0);
    expect(A.metrics.availableVolunteers).toBe(1);
    expect(B.metrics.availableVolunteers).toBe(0);
    expect(A.metrics.activeEvents).toBeGreaterThanOrEqual(1);
    expect(B.metrics.activeEvents).toBe(0);
    expect(B.metrics.openNeeds).toBe(1);
    expect(B.shortfalls[0]).toMatchObject({ need: "Food boxes", requested: 200, verified: 0 });
    expect(A.shortfalls.some((s) => s.need === "Food boxes")).toBe(false);
    // Executive totals are the sum of the parts (plus offers with no county yet).
    expect(X.metrics.pendingApplications).toBe(A.metrics.pendingApplications + B.metrics.pendingApplications);
    expect(X.metrics.openNeeds).toBe(A.metrics.openNeeds + B.metrics.openNeeds);
    expect(X.metrics.activeEvents).toBe(A.metrics.activeEvents + B.metrics.activeEvents);
    // A county administrator cannot widen the scope with a filter.
    expect(await code(getDashboard(db, adminA, { countyId: countyB }))).toBe("NOT_FOUND");
    expect((await getDashboard(db, exec, { countyId: countyB })).metrics.openNeeds).toBe(B.metrics.openNeeds);
    expect(await code(getDashboard(db, resident))).toBe("FORBIDDEN");
    expect(await code(getDashboard(db, exec, { from: "2026-12-01", to: "2026-11-01" }))).toBe("VALIDATION");
    // Date filter really filters.
    expect((await getDashboard(db, adminA, { from: "2001-01-01", to: "2001-01-31" })).metrics.newRequests).toBe(0);
  });

  it("the nonprofit dashboard counts only its own organization's records", async () => {
    const proj = await createProject(db, adminA, { title: "Org project", description: "Project for the org dashboard.", countyId: countyA, zips: "28801", category: "DRINKING_WATER" });
    const need = await addNeed(db, adminA, { projectId: proj.id, label: "Water", contributionType: "DRINKING_WATER", unit: "cases", quantity: 300 });
    await setProjectStatus(db, adminA, proj.id, "ACTIVE");
    await addParticipant(db, adminA, proj.id, orgP);
    const k1 = await proposeCommitment(db, adminA, { needId: need, orgId: orgP, quantity: 100, scheduledFor: "2099-01-01" });
    const k2 = await proposeCommitment(db, adminA, { needId: need, orgId: orgP, quantity: 50, scheduledFor: "2099-01-02" });
    let d = await getOrgDashboard(db, orgMember);
    expect(d.metrics).toMatchObject({ pendingCommitments: 2, activeProjects: 1, scheduledDeliveries: 0 });
    await respondToCommitment(db, orgMember, { commitmentId: k1, accept: "accept" });
    await respondToCommitment(db, orgMember, { commitmentId: k2, accept: "accept" });
    await reportProgress(db, orgMember, { commitmentId: k1, stage: "DISPATCHED", quantity: 100 });
    d = await getOrgDashboard(db, orgMember);
    expect(d.metrics).toMatchObject({ pendingCommitments: 0, scheduledDeliveries: 2 });
    expect(d.scheduled.map((s) => s.scheduledFor)).toEqual(["2099-01-01", "2099-01-02"]);
    await reportProgress(db, adminA, { commitmentId: k1, stage: "RECEIVED", quantity: 100, receiverName: "Dana" });
    await reportProgress(db, adminA, { commitmentId: k1, stage: "VERIFIED", quantity: 90, receiverName: "Dana" });
    d = await getOrgDashboard(db, orgMember);
    expect(d.metrics).toMatchObject({ completedCommitments: 1, verifiedQuantity: 90, scheduledDeliveries: 1 });
    // Another organization sees none of it, and people without an organization have no nonprofit dashboard.
    expect((await getOrgDashboard(db, otherMember)).metrics).toMatchObject({ pendingCommitments: 0, activeProjects: 0, completedCommitments: 0, verifiedQuantity: 0 });
    expect(await code(getOrgDashboard(db, otherMember, {}, orgP))).toBe("NOT_FOUND");
    expect(await code(getOrgDashboard(db, resident))).toBe("FORBIDDEN");
    void orgQ;
  });
});
