import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver, Tx } from "@/server/db";
import { runIn } from "@/server/db/context";
import { assignCountyAdmin, createCounty } from "@/server/modules/counties";
import { createEvent, setEventStatus } from "@/server/modules/events";
import { linkProjectToEvent, unlinkProjectFromEvent } from "@/server/modules/eventlinks";
import { addNeed, createProject, reviewProject, setProjectStatus, submitProject } from "@/server/modules/projects";
import { freshDb } from "./helpers/db";
import { grantRole, makeOrg, makeUser } from "./helpers/fixtures";

let db: Driver;
let exec: string;
let buncombe: string;
let buncombeSC: string;
let henderson: string;
let orgA: string;
let orgH: string;
let hendersonZip: string;
const u = {} as Record<"admin" | "editor" | "viewer" | "other" | "hAdmin" | "caB" | "caH" | "plain" | "dual", string>;
const ev = {} as Record<"buncombe" | "recovery" | "draft" | "closed" | "zip28801" | "buncombeSC" | "henderson" | "second", string>;
const sys = <T>(fn: (tx: Tx) => Promise<T>) => runIn(db, { kind: "system" }, fn);

type Status = "DRAFT" | "PENDING_REVIEW" | "OPEN" | "PAUSED" | "COMPLETED" | "CANCELLED";
let seq = 0;

/** A project owned by orgA (Buncombe) unless told otherwise, walked to the requested status. */
async function project(status: Status = "DRAFT", o: { zip?: string; org?: string; by?: string; county?: string; title?: string } = {}): Promise<string> {
  const by = o.by ?? u.admin;
  const id = await createProject(db, by, o.org ?? orgA, {
    title: o.title ?? `Link test project ${++seq}`,
    description: "Volunteers help clear flood damage from homes in the neighborhood.",
    countyId: o.county ?? buncombe,
    zip: o.zip ?? "28801",
    audience: "COMMUNITY",
    privateLocationNotes: "Meet at the gravel lot behind the church",
  });
  if (status === "DRAFT") return id;
  await addNeed(db, by, id, { title: "Volunteer crew", slotsNeeded: 4 });
  if (status === "CANCELLED") {
    await setProjectStatus(db, by, id, "CANCELLED");
    return id;
  }
  await submitProject(db, by, id);
  if (status === "PENDING_REVIEW") return id;
  await reviewProject(db, exec, id, { decision: "APPROVE", note: "Approved for volunteers" });
  if (status === "PAUSED") await setProjectStatus(db, by, id, "PAUSED");
  if (status === "COMPLETED") await setProjectStatus(db, by, id, "COMPLETED");
  return id;
}

async function event(name: string, counties: string[], opts: { zips?: string[]; to?: ("ACTIVE" | "RECOVERY" | "CLOSED")[] } = {}): Promise<string> {
  const id = await createEvent(db, exec, { name, hazardType: "FLOOD", startsOn: "2026-09-10", countyIds: counties, zips: opts.zips ?? [] });
  for (const s of opts.to ?? ["ACTIVE"]) await setEventStatus(db, exec, id, s);
  return id;
}

const linkRow = async (projectId: string, eventId: string) =>
  (await sys((tx) =>
    tx.query<{ state: string; decided_by: string | null; decided_by_role: string | null }>(
      `SELECT state, decided_by, decided_by_role FROM project_event_links WHERE project_id = $1 AND event_id = $2`, [projectId, eventId]),
  ))[0];
const countLinks = async () => (await sys((tx) => tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM project_event_links`)))[0].n;

beforeAll(async () => {
  db = await freshDb();
  exec = await makeUser(db, "exec@example.test");
  await grantRole(db, exec, "PLATFORM_ADMIN");
  buncombe = await createCounty(db, exec, { name: "Buncombe", state: "NC", fips: "37021" });
  buncombeSC = await createCounty(db, exec, { name: "Buncombe", state: "SC" });
  henderson = await createCounty(db, exec, { name: "Henderson", state: "NC", fips: "37089" });
  for (const k of ["admin", "editor", "viewer", "other", "hAdmin", "plain", "dual"] as const) u[k] = await makeUser(db, `${k.toLowerCase()}-link@example.test`);
  orgA = await makeOrg(db, {
    name: "Org A",
    members: [{ userId: u.admin, role: "ORG_ADMIN" }, { userId: u.editor, role: "EDITOR" }, { userId: u.viewer, role: "VIEWER" }, { userId: u.dual, role: "EDITOR" }],
  });
  await makeOrg(db, { name: "Org B", members: [{ userId: u.other, role: "ORG_ADMIN" }] });
  orgH = await makeOrg(db, { name: "Org Henderson", members: [{ userId: u.hAdmin, role: "ORG_ADMIN" }] });
  await sys((tx) => tx.query(`INSERT INTO organization_counties (org_id, county_id) VALUES ($1, $2), ($3, $4)`, [orgA, buncombe, orgH, henderson]));
  await assignCountyAdmin(db, exec, { email: "ca-buncombe-link@example.test", countyId: buncombe, reason: "Buncombe coordinator" });
  await assignCountyAdmin(db, exec, { email: "ca-henderson-link@example.test", countyId: henderson, reason: "Henderson coordinator" });
  await assignCountyAdmin(db, exec, { email: "dual-link@example.test", countyId: buncombe, reason: "Dual role coordinator" });
  const id = (email: string) => sys((tx) => tx.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [email])).then((r) => r[0].id);
  u.caB = await id("ca-buncombe-link@example.test");
  u.caH = await id("ca-henderson-link@example.test");
  hendersonZip = (await sys((tx) =>
    tx.query<{ zip: string }>(
      `SELECT zip FROM zip_county WHERE county_fips = '37089' AND zip NOT IN (SELECT zip FROM zip_county WHERE county_fips = '37021') ORDER BY zip LIMIT 1`,
    ),
  ))[0].zip;
  ev.buncombe = await event("Flood Buncombe", [buncombe]);
  ev.second = await event("Storm Buncombe", [buncombe]);
  ev.recovery = await event("Recovery Buncombe", [buncombe], { to: ["ACTIVE", "RECOVERY"] });
  ev.draft = await createEvent(db, exec, { name: "Draft Buncombe", hazardType: "FLOOD", startsOn: "2026-09-10", countyIds: [buncombe] });
  ev.closed = await event("Closed Buncombe", [buncombe], { to: ["ACTIVE", "CLOSED"] });
  ev.zip28801 = await event("Zip Narrow Buncombe", [buncombe], { zips: ["28801"] });
  ev.buncombeSC = await event("Flood Buncombe SC", [buncombeSC]);
  ev.henderson = await event("Flood Henderson", [henderson]);
});
afterAll(async () => db?.close());

describe("linking and unlinking", () => {
  it("links an org's project to an active event covering its county, records who decided, and audits it", async () => {
    const p = await project();
    await linkProjectToEvent(db, u.editor, p, ev.buncombe);
    expect(await linkRow(p, ev.buncombe)).toMatchObject({ state: "CONFIRMED", decided_by: u.editor, decided_by_role: "ORG" });
    const audit = await sys((tx) => tx.query<{ details: unknown }>(`SELECT details FROM audit_logs WHERE action = 'EVENT_PROJECT_LINKED' AND subject_id = $1`, [p]));
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0].details)).not.toContain("example.test");
    await expect(linkProjectToEvent(db, u.editor, p, ev.buncombe)).resolves.toBeUndefined();
    expect((await sys((tx) => tx.query(`SELECT 1 FROM project_event_links WHERE project_id = $1`, [p]))).length).toBe(1);
  });

  it("allows a recovery event and several events per project, and rejects draft and closed events", async () => {
    const p = await project();
    const before = await countLinks();
    await linkProjectToEvent(db, u.admin, p, ev.buncombe);
    await linkProjectToEvent(db, u.admin, p, ev.second);
    await linkProjectToEvent(db, u.admin, p, ev.recovery);
    expect(await countLinks()).toBe(before + 3);
    await expect(linkProjectToEvent(db, u.admin, p, ev.draft)).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(linkProjectToEvent(db, u.admin, p, ev.closed)).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await countLinks()).toBe(before + 3);
  });

  it("only links a project that lies inside the event's area", async () => {
    const hp = await project("DRAFT", { org: orgH, by: u.hAdmin, county: henderson, zip: hendersonZip });
    await expect(linkProjectToEvent(db, u.hAdmin, hp, ev.buncombe)).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(linkProjectToEvent(db, u.hAdmin, hp, ev.henderson)).resolves.toBeUndefined();
    const far = await project("DRAFT", { zip: "28806" });
    await expect(linkProjectToEvent(db, u.admin, far, ev.zip28801)).rejects.toMatchObject({ code: "VALIDATION" });
    const near = await project("DRAFT", { zip: "28801" });
    await expect(linkProjectToEvent(db, u.admin, near, ev.zip28801)).resolves.toBeUndefined();
    // Same county name, different state: not inside.
    await expect(linkProjectToEvent(db, u.admin, near, ev.buncombeSC)).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("refuses completed and cancelled projects, and accepts every earlier stage", async () => {
    for (const s of ["COMPLETED", "CANCELLED"] as const) {
      await expect(linkProjectToEvent(db, u.admin, await project(s), ev.buncombe)).rejects.toMatchObject({ code: "VALIDATION" });
    }
    for (const s of ["DRAFT", "PENDING_REVIEW", "OPEN", "PAUSED"] as const) {
      await expect(linkProjectToEvent(db, u.admin, await project(s), ev.buncombe)).resolves.toBeUndefined();
    }
  });

  it("refuses other orgs, viewers, other counties' administrators, and the public", async () => {
    const p = await project();
    await linkProjectToEvent(db, u.admin, p, ev.second);
    const before = await countLinks();
    for (const who of [u.other, u.viewer, u.caH, u.plain]) {
      await expect(linkProjectToEvent(db, who, p, ev.buncombe)).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(unlinkProjectFromEvent(db, who, p, ev.second)).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    expect(await countLinks()).toBe(before);
    expect((await linkRow(p, ev.second)).state).toBe("CONFIRMED");
    const none = "00000000-0000-0000-0000-000000000000";
    await expect(linkProjectToEvent(db, u.admin, none, ev.buncombe)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(linkProjectToEvent(db, u.admin, p, none)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("lets the county's administrator and an executive link and unlink with an ADMIN decision", async () => {
    const p = await project();
    await linkProjectToEvent(db, u.caB, p, ev.buncombe);
    expect(await linkRow(p, ev.buncombe)).toMatchObject({ state: "CONFIRMED", decided_by: u.caB, decided_by_role: "ADMIN" });
    await unlinkProjectFromEvent(db, exec, p, ev.buncombe);
    expect(await linkRow(p, ev.buncombe)).toMatchObject({ state: "DISMISSED", decided_by: exec, decided_by_role: "ADMIN" });
    // Someone who is both an editor of the owning org and a county administrator acts as the organization.
    const q = await project();
    await linkProjectToEvent(db, u.dual, q, ev.buncombe);
    expect((await linkRow(q, ev.buncombe)).decided_by_role).toBe("ORG");
  });

  it("unlinks to DISMISSED, is idempotent, and lets the org re-attach its own dismissal", async () => {
    const p = await project();
    await linkProjectToEvent(db, u.editor, p, ev.buncombe);
    await unlinkProjectFromEvent(db, u.editor, p, ev.buncombe);
    expect(await linkRow(p, ev.buncombe)).toMatchObject({ state: "DISMISSED", decided_by_role: "ORG" });
    await expect(unlinkProjectFromEvent(db, u.editor, p, ev.buncombe)).resolves.toBeUndefined();
    await linkProjectToEvent(db, u.editor, p, ev.buncombe);
    expect((await linkRow(p, ev.buncombe)).state).toBe("CONFIRMED");
    const audit = await sys((tx) => tx.query(`SELECT 1 FROM audit_logs WHERE action = 'EVENT_PROJECT_UNLINKED' AND subject_id = $1`, [p]));
    expect(audit).toHaveLength(1);
  });

  it("does not let the org re-attach a link an administrator dismissed", async () => {
    const p = await project();
    await linkProjectToEvent(db, u.editor, p, ev.buncombe);
    await unlinkProjectFromEvent(db, u.caB, p, ev.buncombe);
    await expect(linkProjectToEvent(db, u.editor, p, ev.buncombe)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(linkProjectToEvent(db, u.admin, p, ev.buncombe)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await linkRow(p, ev.buncombe)).state).toBe("DISMISSED");
    await linkProjectToEvent(db, u.caB, p, ev.buncombe);
    expect(await linkRow(p, ev.buncombe)).toMatchObject({ state: "CONFIRMED", decided_by_role: "ADMIN" });
  });

  it("treats unlinking something that was never linked as NOT_FOUND", async () => {
    const p = await project();
    await expect(unlinkProjectFromEvent(db, u.admin, p, ev.recovery)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("hides links from request roles at the database", async () => {
    await expect(runIn(db, { kind: "anon" }, (tx) => tx.query(`SELECT * FROM project_event_links`))).rejects.toMatchObject({ code: "42501" });
  });
});
