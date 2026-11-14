import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver, Tx } from "@/server/db";
import { runIn } from "@/server/db/context";
import { assignCountyAdmin, createCounty } from "@/server/modules/counties";
import { submitOffer, transitionOffer } from "@/server/modules/offers";
import {
  addNeed, addParticipant, addProjectUpdate, createProject, getProject, getPublicProject, listMyCommitments, listProjects, listPublicProjects,
  proposeCommitment, reportProgress, respondToCommitment, setProjectStatus, setProjectVisibility, suggestMatches,
} from "@/server/modules/projects";
import { syncZipCounty } from "@/server/modules/zipcounty";
import { freshDb } from "./helpers/db";
import { grantRole, makeOrg, makeUser } from "./helpers/fixtures";

let db: Driver;
let exec: string, adminA: string, adminB: string, orgMember: string, otherOrgMember: string;
let countyA: string, countyB: string, orgP: string, orgQ: string;
const sys = <T>(fn: (tx: Tx) => Promise<T>) => runIn(db, { kind: "system" }, fn);
const code = (p: Promise<unknown>) => p.then(() => "OK", (e) => (e as { code?: string }).code ?? "ERR");
let seq = 0;

const offerForm = (over: Record<string, unknown> = {}) => ({
  contributorName: "Pat Giver", email: `giver-${seq++}@example.test`, zip: "28801", contributionType: "DRINKING_WATER", quantity: "3000", unit: "cases",
  description: "Palletized bottled water.", consentContact: "on", ...over,
});
const projectForm = (over: Record<string, unknown> = {}) => ({
  title: "Emergency water distribution", description: "Residents have no safe drinking water after the storm.", countyId: countyA, zips: "28801, 28803",
  category: "DRINKING_WATER", priority: "CRITICAL", ...over,
});
async function activeProject(over: Record<string, unknown> = {}, quantity = 5000): Promise<{ id: string; needId: string }> {
  const { id } = await createProject(db, adminA, projectForm(over));
  const needId = await addNeed(db, adminA, { projectId: id, label: "Bottled drinking water", contributionType: "DRINKING_WATER", unit: "cases", quantity });
  await setProjectStatus(db, adminA, id, "ACTIVE");
  return { id, needId };
}
const confirm = (commitmentId: string, quantity?: number) =>
  respondToCommitment(db, adminA, { commitmentId, accept: "accept", quantity, note: "Contributor confirmed by phone on Tuesday." });
async function deliver(commitmentId: string, quantity: number) {
  await reportProgress(db, adminA, { commitmentId, stage: "DISPATCHED", quantity });
  await reportProgress(db, adminA, { commitmentId, stage: "RECEIVED", quantity, receiverName: "Dana at the fire hall" });
  await reportProgress(db, adminA, { commitmentId, stage: "VERIFIED", quantity, receiverName: "Dana at the fire hall" });
}

beforeAll(async () => {
  db = await freshDb();
  [exec, adminA, adminB, orgMember, otherOrgMember] = await Promise.all(["exec", "admin-a", "admin-b", "org-member", "other-member"].map((n) => makeUser(db, `${n}@example.test`)));
  await grantRole(db, exec, "PLATFORM_ADMIN");
  countyA = await createCounty(db, exec, { name: "Buncombe", state: "NC" });
  countyB = await createCounty(db, exec, { name: "Aiken", state: "SC" });
  await assignCountyAdmin(db, exec, { email: "admin-a@example.test", countyId: countyA, reason: "County A coordinator" });
  await assignCountyAdmin(db, exec, { email: "admin-b@example.test", countyId: countyB, reason: "County B coordinator" });
  orgP = await makeOrg(db, { name: "Water Relief P", members: [{ userId: orgMember, role: "EDITOR" }] });
  orgQ = await makeOrg(db, { name: "Other Org Q", members: [{ userId: otherOrgMember, role: "EDITOR" }] });
  await sys((tx) => tx.query(`UPDATE platform_settings SET value = to_jsonb('stale'::text) WHERE key = 'zip_county_sha256'`));
  await syncZipCounty(db);
});
afterAll(async () => db?.close());

describe("creating projects", () => {
  it("needs a manager of the county and ZIP codes that belong to it", async () => {
    const { id, reference } = await createProject(db, adminA, projectForm());
    expect(reference).toMatch(/^PRJ-\d{4}-\d{6}$/);
    expect((await getProject(db, adminA, id)).zips).toEqual(["28801", "28803"]);
    expect(await code(createProject(db, adminB, projectForm()))).toBe("FORBIDDEN"); // not their county
    expect(await code(createProject(db, adminB, projectForm({ countyId: countyB })))).toBe("VALIDATION"); // 28801 is not in Aiken
    expect(await code(createProject(db, adminA, projectForm({ zips: "2880" })))).toBe("VALIDATION");
    expect(await code(createProject(db, exec, projectForm()))).toBe("OK");
  });

  it("cannot be activated without a need, and only the county's managers can see or change it", async () => {
    const { id } = await createProject(db, adminA, projectForm());
    expect(await code(setProjectStatus(db, adminA, id, "ACTIVE"))).toBe("VALIDATION");
    await addNeed(db, adminA, { projectId: id, label: "Water", contributionType: "DRINKING_WATER", unit: "cases", quantity: 10 });
    expect(await code(setProjectStatus(db, adminB, id, "ACTIVE"))).toBe("NOT_FOUND");
    expect(await code(getProject(db, adminB, id))).toBe("NOT_FOUND");
    expect(await code(addNeed(db, adminB, { projectId: id, label: "Water", contributionType: "FOOD", unit: "x", quantity: 1 }))).toBe("NOT_FOUND");
    await setProjectStatus(db, adminA, id, "ACTIVE");
    expect((await listProjects(db, adminB)).some((p) => p.id === id)).toBe(false);
    expect((await listProjects(db, adminA)).some((p) => p.id === id)).toBe(true);
  });
});

describe("matching suggests, it never commits", () => {
  it("ranks same-ZIP offers first, ignores wrong types and closed offers, and creates no commitments", async () => {
    const { id, needId } = await activeProject();
    const near = await submitOffer(db, offerForm());
    const far = await submitOffer(db, offerForm({ zip: "28806" })); // same county, different ZIP
    const food = await submitOffer(db, offerForm({ contributionType: "FOOD" }));
    const closed = await submitOffer(db, offerForm());
    await transitionOffer(db, adminA, { offerId: closed.id, to: "DECLINED", note: "Not needed." });
    const before = (await sys((tx) => tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM project_commitments`)))[0].n;
    const s = await suggestMatches(db, adminA, needId);
    const ids = s.map((x) => x.offerId);
    expect(ids).toContain(near.id);
    expect(ids).toContain(far.id);
    expect(ids).not.toContain(food.id);
    expect(ids).not.toContain(closed.id);
    expect(s.find((x) => x.offerId === near.id)!.score).toBeGreaterThan(s.find((x) => x.offerId === far.id)!.score);
    expect(s[0].sameZip).toBe(true);
    expect((await sys((tx) => tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM project_commitments`)))[0].n).toBe(before);
    expect(await code(suggestMatches(db, adminB, needId))).toBe("NOT_FOUND");
    expect((await getProject(db, adminA, id)).commitments).toHaveLength(0);
  });
});

describe("the emergency water project, end to end", () => {
  it("tracks requested, offered, accepted, dispatched, received and verified separately and completes automatically", async () => {
    const { id, needId } = await activeProject();
    const o1 = await submitOffer(db, offerForm({ quantity: "3000" }));
    const o2 = await submitOffer(db, offerForm({ quantity: "4000" }));
    const k1 = await proposeCommitment(db, adminA, { needId, offerId: o1.id, quantity: 3000 });
    let p = await getProject(db, adminA, id);
    expect(p.commitments[0].status).toBe("PROPOSED"); // never auto-committed
    expect(p.needs[0]).toMatchObject({ requested: 5000, offered: 3000, accepted: 0, verified: 0 });
    expect(await code(reportProgress(db, adminA, { commitmentId: k1, stage: "DISPATCHED", quantity: 10 }))).toBe("CONFLICT"); // must be accepted first
    expect(await code(respondToCommitment(db, adminA, { commitmentId: k1, accept: "accept" }))).toBe("VALIDATION"); // contributor confirmation must be recorded
    await confirm(k1);
    p = await getProject(db, adminA, id);
    expect(p.needs[0]).toMatchObject({ offered: 3000, accepted: 3000, dispatched: 0 });

    expect(await code(reportProgress(db, adminA, { commitmentId: k1, stage: "DISPATCHED", quantity: 3500 }))).toBe("VALIDATION"); // more than accepted
    await reportProgress(db, adminA, { commitmentId: k1, stage: "DISPATCHED", quantity: 3000 });
    expect(await code(reportProgress(db, adminA, { commitmentId: k1, stage: "RECEIVED", quantity: 2500 }))).toBe("VALIDATION"); // receiver required
    await reportProgress(db, adminA, { commitmentId: k1, stage: "RECEIVED", quantity: 2900, receiverName: "Dana at the fire hall" });
    await reportProgress(db, adminA, { commitmentId: k1, stage: "VERIFIED", quantity: 2800, receiverName: "Dana at the fire hall" });
    p = await getProject(db, adminA, id);
    expect(p.needs[0]).toMatchObject({ accepted: 3000, dispatched: 3000, received: 2900, verified: 2800, percentVerified: 56 });
    expect(p.status).toBe("ACTIVE"); // 2,800 of 5,000 verified: not complete

    // The 200-case shortfall on the first commitment is released (it reserves only what was verified), so a second source can cover it.
    const k2 = await proposeCommitment(db, adminA, { needId, offerId: o2.id, quantity: 2200 });
    await confirm(k2);
    await deliver(k2, 2200);
    p = await getProject(db, adminA, id);
    expect(p.needs[0].verified).toBe(5000);
    expect(p.status).toBe("COMPLETED"); // computed from verified quantities
    expect(p.percentVerified).toBe(100);
    expect(await code(proposeCommitment(db, adminA, { needId, offerId: o2.id, quantity: 100 }))).toBe("CONFLICT"); // project is closed
    const audit = await sys((tx) => tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_logs WHERE subject_id = $1 AND action = 'PROJECT_COMPLETED'`, [id]));
    expect(audit[0].n).toBe(1);
  });
});

describe("no double counting", () => {
  it("one offer cannot be allocated beyond its quantity across projects, and a released allocation frees the quantity", async () => {
    const a = await activeProject();
    const b = await activeProject();
    const offer = await submitOffer(db, offerForm({ quantity: "1000" }));
    const k = await proposeCommitment(db, adminA, { needId: a.needId, offerId: offer.id, quantity: 700 });
    expect(await code(proposeCommitment(db, adminA, { needId: b.needId, offerId: offer.id, quantity: 400 }))).toBe("VALIDATION"); // 700 + 400 > 1000
    await proposeCommitment(db, adminA, { needId: b.needId, offerId: offer.id, quantity: 300 }); // exactly the rest
    await respondToCommitment(db, adminA, { commitmentId: k, accept: "decline", note: "Donor withdrew that part." });
    await proposeCommitment(db, adminA, { needId: a.needId, offerId: offer.id, quantity: 700 }); // freed by the decline
    const s = await suggestMatches(db, adminA, b.needId);
    expect(s.find((x) => x.offerId === offer.id)).toBeUndefined(); // nothing unallocated remains
  });

  it("accepted quantities for a need can never exceed what was requested, even from several sources", async () => {
    const { needId } = await activeProject({}, 100);
    const o1 = await submitOffer(db, offerForm({ quantity: "80" }));
    const o2 = await submitOffer(db, offerForm({ quantity: "80" }));
    const k1 = await proposeCommitment(db, adminA, { needId, offerId: o1.id, quantity: 80 });
    const k2 = await proposeCommitment(db, adminA, { needId, offerId: o2.id, quantity: 80 });
    await confirm(k1);
    expect(await code(confirm(k2))).toBe("VALIDATION"); // 80 + 80 > 100
    await confirm(k2, 20); // a partial acceptance fits
    expect((await sys((tx) => tx.query<{ q: string }>(`SELECT qty_accepted AS q FROM project_commitments WHERE id = $1`, [k2])))[0].q).toBe("20.00");
  });

  it("the database itself rejects out-of-order quantities and a mismatched offer type", async () => {
    const { id, needId } = await activeProject();
    const offer = await submitOffer(db, offerForm({ quantity: "50" }));
    const k = await proposeCommitment(db, adminA, { needId, offerId: offer.id, quantity: 50 });
    await expect(sys((tx) => tx.query(`UPDATE project_commitments SET qty_verified = 5 WHERE id = $1`, [k]))).rejects.toThrow(); // verified > received
    const food = await submitOffer(db, offerForm({ contributionType: "FOOD", quantity: "50" }));
    expect(await code(proposeCommitment(db, adminA, { needId, offerId: food.id, quantity: 10 }))).toBe("VALIDATION");
    const noQty = await submitOffer(db, offerForm({ quantity: "" }));
    expect(await code(proposeCommitment(db, adminA, { needId, offerId: noQty.id, quantity: 10 }))).toBe("VALIDATION");
    expect(id).toBeTruthy();
  });
});

describe("participating organizations", () => {
  it("only approved participants can be committed; the organization accepts and dispatches its own commitment; others see nothing", async () => {
    const { id, needId } = await activeProject();
    expect(await code(proposeCommitment(db, adminA, { needId, orgId: orgP, quantity: 500 }))).toBe("VALIDATION"); // not a participant yet
    await addParticipant(db, adminA, id, orgP);
    const k = await proposeCommitment(db, adminA, { needId, orgId: orgP, quantity: 500 });
    expect((await listMyCommitments(db, orgMember)).map((c) => c.id)).toContain(k);
    expect(await listMyCommitments(db, otherOrgMember)).toEqual([]);
    expect(await code(respondToCommitment(db, otherOrgMember, { commitmentId: k, accept: "accept" }))).toBe("NOT_FOUND");
    expect(await code(respondToCommitment(db, adminB, { commitmentId: k, accept: "accept", note: "Trying to act in another county." }))).toBe("NOT_FOUND");
    await respondToCommitment(db, orgMember, { commitmentId: k, accept: "accept" }); // the organization's own acceptance needs no coordinator note
    await reportProgress(db, orgMember, { commitmentId: k, stage: "DISPATCHED", quantity: 500 });
    expect(await code(reportProgress(db, orgMember, { commitmentId: k, stage: "RECEIVED", quantity: 500, receiverName: "Self" }))).toBe("FORBIDDEN"); // only a coordinator records receipt
    await reportProgress(db, adminA, { commitmentId: k, stage: "RECEIVED", quantity: 500, receiverName: "Dana at the fire hall" });
    const mine = await listMyCommitments(db, orgMember);
    expect(mine.find((c) => c.id === k)).toMatchObject({ status: "RECEIVED", dispatched: 500, received: 500 });
    // A participant sees the project (and true overall progress) but not other parties' commitments.
    const seen = await getProject(db, orgMember, id);
    expect(seen.commitments.map((c) => c.id)).toEqual([k]);
    expect(seen.canManage).toBe(false);
    expect(await code(getProject(db, otherOrgMember, id))).toBe("NOT_FOUND");
    expect(await code(setProjectStatus(db, orgMember, id, "ON_HOLD"))).toBe("NOT_FOUND");
    void orgQ;
  });

  it("canceling a project cancels its open commitments and releases the offer quantity", async () => {
    const { id, needId } = await activeProject();
    const offer = await submitOffer(db, offerForm({ quantity: "100" }));
    const k = await proposeCommitment(db, adminA, { needId, offerId: offer.id, quantity: 100 });
    await setProjectStatus(db, adminA, id, "CANCELED");
    expect((await sys((tx) => tx.query<{ status: string }>(`SELECT status FROM project_commitments WHERE id = $1`, [k])))[0].status).toBe("CANCELED");
    const other = await activeProject();
    await expect(proposeCommitment(db, adminA, { needId: other.needId, offerId: offer.id, quantity: 100 })).resolves.toBeTruthy();
  });
});

describe("what the public can see", () => {
  it("private projects are invisible; a published project shows only the summary, ZIPs and aggregate verified progress", async () => {
    const { id, needId } = await activeProject();
    const offer = await submitOffer(db, offerForm({ contributorName: "SECRET-DONOR-NAME", quantity: "1000" }));
    const k = await proposeCommitment(db, adminA, { needId, offerId: offer.id, quantity: 1000 });
    await confirm(k);
    await deliver(k, 1000);
    await addProjectUpdate(db, adminA, id, "Internal: loading dock is blocked.", false);
    await addProjectUpdate(db, adminA, id, "First pallets delivered to the fire hall.", true);
    const ref = (await getProject(db, adminA, id)).reference;

    expect(await getPublicProject(db, ref)).toBeNull(); // private
    expect(await code(setProjectVisibility(db, adminA, { projectId: id, visibility: "PUBLIC" }))).toBe("VALIDATION"); // needs a summary
    await setProjectVisibility(db, adminA, { projectId: id, visibility: "PUBLIC", publicSummary: "Bottled water distribution for these ZIP codes." });
    const pub = await getPublicProject(db, ref);
    expect(pub!.project).toMatchObject({ title: "Emergency water distribution", countyName: "Buncombe", zips: ["28801", "28803"], percentVerified: 20 });
    expect(pub!.project.needs[0]).toMatchObject({ requested: 5000, verified: 1000 });
    expect(pub!.updates.map((u) => u.body)).toEqual(["First pallets delivered to the fire hall."]);
    const blob = JSON.stringify(pub) + JSON.stringify(await listPublicProjects(db));
    for (const secret of ["SECRET-DONOR-NAME", "Internal: loading dock", "Residents have no safe drinking water", "Water Relief P", "Dana at the fire hall"]) expect(blob).not.toContain(secret);
    expect((await listPublicProjects(db, { zip: "28803" })).some((p) => p.id === id)).toBe(true);
    expect((await listPublicProjects(db, { zip: "29801" })).some((p) => p.id === id)).toBe(false);
    for (const table of ["community_projects", "project_commitments", "project_needs", "project_updates", "contribution_offers"]) {
      await expect(runIn(db, { kind: "anon" }, (tx) => tx.query(`SELECT * FROM ${table}`))).rejects.toThrow();
    }
    await setProjectVisibility(db, adminA, { projectId: id, visibility: "PRIVATE" });
    expect(await getPublicProject(db, ref)).toBeNull();
  });
});
