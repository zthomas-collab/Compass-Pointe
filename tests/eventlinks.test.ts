import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver, Tx } from "@/server/db";
import { runIn } from "@/server/db/context";
import { assignCountyAdmin, createCounty } from "@/server/modules/counties";
import { createEvent, setEventStatus, updateEvent } from "@/server/modules/events";
import { confirmCommitment, signUpForNeed } from "@/server/modules/volunteers";
import { linkProjectToEvent, listEventProjects, listLinkableEvents, listProjectEventLinks, listPublicProjectEvents, unlinkProjectFromEvent } from "@/server/modules/eventlinks";
import { addNeed, createProject, reviewProject, setProjectStatus, submitProject, updateProject } from "@/server/modules/projects";
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

describe("editor reads", () => {
  it("lists a project's links with area, status, and what the reader may do", async () => {
    const p = await project();
    await linkProjectToEvent(db, u.editor, p, ev.buncombe);
    await linkProjectToEvent(db, u.editor, p, ev.second);
    await linkProjectToEvent(db, u.editor, p, ev.recovery);
    await unlinkProjectFromEvent(db, u.caB, p, ev.second);
    const as = async (who: string) => Object.fromEntries((await listProjectEventLinks(db, who, p)).map((l) => [l.eventId, l]));
    const editor = await as(u.editor);
    expect(Object.keys(editor).sort()).toEqual([ev.buncombe, ev.second, ev.recovery].sort());
    expect(editor[ev.buncombe]).toMatchObject({ eventName: "Flood Buncombe", eventSlug: expect.any(String), eventStatus: "ACTIVE", state: "CONFIRMED", inArea: true, canUnlink: true, canRelink: false });
    expect(editor[ev.recovery]).toMatchObject({ eventStatus: "RECOVERY", state: "CONFIRMED", canUnlink: true });
    // The administrator removed this one: the organization may not restore it, the administrator may.
    expect(editor[ev.second]).toMatchObject({ state: "DISMISSED", canUnlink: false, canRelink: false });
    expect((await as(u.caB))[ev.second]).toMatchObject({ state: "DISMISSED", canRelink: true });
    // A viewer can read but never change anything.
    const viewer = await as(u.viewer);
    expect(Object.values(viewer).every((l) => !l.canUnlink && !l.canRelink)).toBe(true);
    expect(Object.keys(viewer)).toHaveLength(3);
  });

  it("flags a link whose project has moved outside the event area", async () => {
    const p = await project("DRAFT", { zip: "28801" });
    await linkProjectToEvent(db, u.admin, p, ev.zip28801);
    await linkProjectToEvent(db, u.admin, p, ev.buncombe);
    await sys((tx) => tx.query(`UPDATE projects SET zip = '28806' WHERE id = $1`, [p]));
    const links = Object.fromEntries((await listProjectEventLinks(db, u.admin, p)).map((l) => [l.eventId, l]));
    expect(links[ev.zip28801].inArea).toBe(false);
    expect(links[ev.buncombe].inArea).toBe(true);
  });

  it("shows nothing to people who cannot see the project", async () => {
    const p = await project();
    await linkProjectToEvent(db, u.admin, p, ev.buncombe);
    for (const who of [u.other, u.caH, u.plain]) {
      expect(await listProjectEventLinks(db, who, p)).toEqual([]);
      expect(await listLinkableEvents(db, who, p)).toEqual([]);
    }
    expect(await listProjectEventLinks(db, u.admin, "not-a-uuid")).toEqual([]);
    expect(await listProjectEventLinks(db, u.admin, "00000000-0000-0000-0000-000000000000")).toEqual([]);
  });

  it("offers only events the project can actually be linked to", async () => {
    const p = await project("DRAFT", { zip: "28801" });
    const ids = async (who: string) => (await listLinkableEvents(db, who, p)).map((e) => e.id);
    const offered = await ids(u.editor);
    for (const e of [ev.buncombe, ev.second, ev.recovery, ev.zip28801]) expect(offered).toContain(e);
    for (const e of [ev.draft, ev.closed, ev.buncombeSC, ev.henderson]) expect(offered).not.toContain(e);
    await linkProjectToEvent(db, u.editor, p, ev.buncombe);
    expect(await ids(u.editor)).not.toContain(ev.buncombe);
    expect(await ids(u.viewer)).toEqual([]);
    expect((await ids(u.caB)).length).toBeGreaterThan(0);
    // An event an administrator removed the project from is not offered to the organization, but is to the administrator.
    await linkProjectToEvent(db, u.caB, p, ev.second);
    await unlinkProjectFromEvent(db, u.caB, p, ev.second);
    expect(await ids(u.editor)).not.toContain(ev.second);
    expect(await ids(u.caB)).toContain(ev.second);
    const done = await project("COMPLETED");
    expect(await listLinkableEvents(db, u.admin, done)).toEqual([]);
  });
});

describe("public event needs", () => {
  const PRIVATE_NOTES = "Meet at the gravel lot behind the church";
  const INSTRUCTIONS = "SECRET-INSTRUCTIONS-park-on-elm";
  const future = (hours: number) => new Date(Date.now() + hours * 3600_000).toISOString();
  let n = 0;

  /** An OPEN project of orgA with one need, optionally linked to an event. */
  async function open(title: string, o: { eventId?: string; zip?: string; urgent?: boolean; startsInHours?: number; slots?: number } = {}) {
    const id = await createProject(db, u.admin, orgA, {
      title, description: "Volunteers help clear flood damage from homes in the neighborhood.",
      countyId: buncombe, zip: o.zip ?? "28801", audience: "COMMUNITY", privateLocationNotes: PRIVATE_NOTES,
    });
    const needId = await addNeed(db, u.admin, id, {
      title: `${title} crew`, slotsNeeded: o.slots ?? 3, urgency: o.urgent ? "URGENT" : "NORMAL",
      startsAt: future(o.startsInHours ?? 48), endsAt: future((o.startsInHours ?? 48) + 4), instructions: INSTRUCTIONS,
    });
    await submitProject(db, u.admin, id);
    await reviewProject(db, exec, id, { decision: "APPROVE", note: "Approved for volunteers" });
    if (o.eventId) await linkProjectToEvent(db, u.admin, id, o.eventId);
    return { id, needId };
  }
  const titles = async (eventId: string) => (await listEventProjects(db, eventId)).map((p) => p.title);
  const volunteer = async (needId: string, name: string, email: string) => {
    await signUpForNeed(db, { needId, name, email, consentShare: true });
    const mail = await sys((tx) => tx.query<{ body_text: string }>(`SELECT body_text FROM notification_jobs WHERE recipient_email = $1 AND kind = 'VOLUNTEER_CONFIRM'`, [email]));
    await confirmCommitment(db, /token=([A-Za-z0-9_-]+)/.exec(mail[0].body_text)![1]);
  };

  it("lists open, approved projects linked to an active event, with real spots left and no private fields", async () => {
    const e = await event(`Needs event ${++n}`, [buncombe]);
    const p = await open("Needs live project", { eventId: e, slots: 3 });
    const before = (await listEventProjects(db, e))[0];
    expect(before).toMatchObject({ id: p.id, title: "Needs live project", countyName: "Buncombe", state: "NC", spotsLeft: 3, totalSlots: 3 });
    expect(before.needs).toMatchObject([{ title: "Needs live project crew", slotsNeeded: 3, spotsLeft: 3 }]);
    await volunteer(p.needId, "Quentin Confirmed", "quentin-needs@example.test");
    const after = await listEventProjects(db, e);
    expect(after[0].spotsLeft).toBe(2);
    expect(after[0].needs[0]).toMatchObject({ slotsTaken: 1, spotsLeft: 2 });
    const everything = JSON.stringify(after);
    for (const secret of [PRIVATE_NOTES, INSTRUCTIONS, "Quentin", "quentin-needs"]) expect(everything).not.toContain(secret);
  });

  it("leaves out drafts, pending, paused and completed projects, suspended orgs, and dismissed links", async () => {
    const e = await event(`Needs event ${++n}`, [buncombe]);
    const live = await open("Filter live project", { eventId: e });
    const mk = (title: string) => project("DRAFT", { title });
    const draft = await mk("Filter draft project");
    const pending = await project("PENDING_REVIEW", { title: "Filter pending project" });
    const paused = await open("Filter paused project", { eventId: e });
    await setProjectStatus(db, u.admin, paused.id, "PAUSED");
    const done = await open("Filter completed project", { eventId: e });
    await setProjectStatus(db, u.admin, done.id, "COMPLETED");
    const dismissed = await open("Filter dismissed project", { eventId: e });
    await unlinkProjectFromEvent(db, u.admin, dismissed.id, e);
    for (const id of [draft, pending]) await linkProjectToEvent(db, u.admin, id, e);
    expect(await titles(e)).toEqual(["Filter live project"]);

    // Everything that was hidden for a reason that can be undone comes back when it is.
    await setProjectStatus(db, u.admin, paused.id, "OPEN");
    await linkProjectToEvent(db, u.admin, dismissed.id, e);
    expect((await titles(e)).sort()).toEqual(["Filter dismissed project", "Filter live project", "Filter paused project"]);

    await sys((tx) => tx.query(`UPDATE organizations SET publication_suspended = true WHERE id = $1`, [orgA]));
    try {
      expect(await titles(e)).toEqual([]);
    } finally {
      await sys((tx) => tx.query(`UPDATE organizations SET publication_suspended = false WHERE id = $1`, [orgA]));
    }
    expect(await titles(e)).toContain("Filter live project");
    expect(live.id).toBeTruthy();
  });

  it("drops a project the moment it is outside the event's area", async () => {
    const narrow = await event(`Needs event ${++n}`, [buncombe], { zips: ["28801"] });
    const p = await open("Area zip project", { eventId: narrow, zip: "28801" });
    expect(await titles(narrow)).toEqual(["Area zip project"]);
    // The project moves to another ZIP and is re-approved: it is no longer inside the event, with no change to the link row.
    await updateProject(db, u.admin, p.id, {
      title: "Area zip project", description: "Volunteers help clear flood damage from homes in the neighborhood.",
      countyId: buncombe, zip: "28806", audience: "COMMUNITY",
    });
    await reviewProject(db, exec, p.id, { decision: "APPROVE", note: "Approved after moving" });
    expect(await titles(narrow)).toEqual([]);
    expect((await linkRow(p.id, narrow)).state).toBe("CONFIRMED");

    const wide = await event(`Needs event ${++n}`, [buncombe]);
    const q = await open("Area county project", { eventId: wide });
    expect(await titles(wide)).toEqual(["Area county project"]);
    const edit = (countyIds: string[]) => updateEvent(db, exec, wide, { name: `Needs event ${n}`, hazardType: "FLOOD", startsOn: "2026-09-10", countyIds });
    await edit([henderson]);
    expect(await titles(wide)).toEqual([]);
    await edit([buncombe]);
    expect(await titles(wide)).toEqual(["Area county project"]);
    expect(q.id).toBeTruthy();
  });

  it("returns nothing for a draft or closed event, and keeps the links when an event closes", async () => {
    const e = await event(`Needs event ${++n}`, [buncombe]);
    const p = await open("Closing project", { eventId: e });
    expect(await titles(e)).toEqual(["Closing project"]);
    await setEventStatus(db, exec, e, "CLOSED");
    expect(await listEventProjects(db, e)).toEqual([]);
    expect((await linkRow(p.id, e)).state).toBe("CONFIRMED");
    // Force a confirmed link to the draft event so the answer is empty because of the event's status, not for lack of links.
    await sys((tx) =>
      tx.query(
        `INSERT INTO project_event_links (project_id, event_id, state, decided_by, decided_by_role, decided_at) VALUES ($1, $2, 'CONFIRMED', $3, 'ADMIN', now())`,
        [p.id, ev.draft, exec],
      ),
    );
    expect(await listEventProjects(db, ev.draft)).toEqual([]);
    expect(await listEventProjects(db, "00000000-0000-0000-0000-000000000000")).toEqual([]);
    expect(await listEventProjects(db, "not-a-uuid")).toEqual([]);
  });

  it("orders urgent projects first, then the soonest shift, then title", async () => {
    const e = await event(`Needs event ${++n}`, [buncombe]);
    // Alphabetical order is the OPPOSITE of the expected order, so removing either sort key would fail this test.
    await open("Xray later", { eventId: e, startsInHours: 96 });
    await open("Yankee sooner", { eventId: e, startsInHours: 24 });
    await open("Zulu urgent", { eventId: e, startsInHours: 200, urgent: true });
    expect(await titles(e)).toEqual(["Zulu urgent", "Yankee sooner", "Xray later"]);
  });

  it("lists a project's public events and never a draft event", async () => {
    const a = await event(`Needs event ${++n}`, [buncombe]);
    const r = await event(`Needs event ${++n}`, [buncombe], { to: ["ACTIVE", "RECOVERY"] });
    const c = await event(`Needs event ${++n}`, [buncombe]);
    const p = await open("Multi event project", { eventId: a });
    await linkProjectToEvent(db, u.admin, p.id, r);
    await linkProjectToEvent(db, u.admin, p.id, c);
    await setEventStatus(db, exec, c, "CLOSED");
    // A link to a draft event cannot be made through the service; force one to prove the view itself hides it.
    await sys((tx) =>
      tx.query(
        `INSERT INTO project_event_links (project_id, event_id, state, decided_by, decided_by_role, decided_at) VALUES ($1, $2, 'CONFIRMED', $3, 'ADMIN', now())`,
        [p.id, ev.draft, exec],
      ),
    );
    const events = await listPublicProjectEvents(db, p.id);
    expect(events.map((x) => x.id).sort()).toEqual([a, r, c].sort());
    expect(events.find((x) => x.id === r)).toMatchObject({ status: "RECOVERY", slug: expect.any(String), name: expect.any(String) });
    const unlisted = await project("DRAFT", { title: "Hidden multi event project" });
    await linkProjectToEvent(db, u.admin, unlisted, a);
    expect(await listPublicProjectEvents(db, unlisted)).toEqual([]);
    expect(await listPublicProjectEvents(db, "not-a-uuid")).toEqual([]);
  });

  it("exposes only ids in the public view", async () => {
    const cols = await sys((tx) => tx.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'public_event_links' ORDER BY column_name`));
    expect(cols.map((c) => c.column_name)).toEqual(["event_id", "project_id"]);
  });
});

describe("fixes from the independent review", () => {
  const future = (hours: number) => new Date(Date.now() + hours * 3600_000).toISOString();

  /** An OPEN project of orgA whose needs run at the given offsets (hours from now: [start, end, slots]). */
  async function openWith(title: string, eventId: string, needs: [number, number, number][]) {
    const id = await createProject(db, u.admin, orgA, {
      title, description: "Volunteers help clear flood damage from homes in the neighborhood.",
      countyId: buncombe, zip: "28801", audience: "COMMUNITY",
    });
    for (const [i, [s, e, slots]] of needs.entries()) {
      await addNeed(db, u.admin, id, { title: `${title} role ${i + 1}`, slotsNeeded: slots, startsAt: future(s), endsAt: future(e) });
    }
    await submitProject(db, u.admin, id);
    await reviewProject(db, exec, id, { decision: "APPROVE", note: "Approved for volunteers" });
    await linkProjectToEvent(db, u.admin, id, eventId);
    return id;
  }

  it("does not count a shift that has already ended as a spot left", async () => {
    const e = await event("Ended shift event", [buncombe]);
    await openWith("Ended shift project", e, [[-10, -6, 5]]);
    await openWith("Mixed shift project", e, [[-10, -6, 5], [24, 28, 2]]);
    const byTitle = Object.fromEntries((await listEventProjects(db, e)).map((p) => [p.title, p]));
    const ended = byTitle["Ended shift project"];
    expect(ended.spotsLeft).toBe(0);
    expect(ended.needs[0]).toMatchObject({ ended: true, spotsLeft: 0, slotsNeeded: 5 });
    const mixed = byTitle["Mixed shift project"];
    expect(mixed.spotsLeft).toBe(2);
    expect(mixed.needs.map((n) => [n.ended, n.spotsLeft])).toEqual([[true, 0], [false, 2]]);
  });

  it("says who removed a link, so the page never blames the wrong person", async () => {
    const p = await project();
    await linkProjectToEvent(db, u.editor, p, ev.buncombe);
    await linkProjectToEvent(db, u.editor, p, ev.second);
    await linkProjectToEvent(db, u.editor, p, ev.recovery);
    await unlinkProjectFromEvent(db, u.editor, p, ev.second);
    await unlinkProjectFromEvent(db, u.caB, p, ev.recovery);
    const links = Object.fromEntries((await listProjectEventLinks(db, u.viewer, p)).map((l) => [l.eventId, l]));
    expect(links[ev.buncombe].dismissedBy).toBeNull();
    expect(links[ev.second].dismissedBy).toBe("ORG");
    expect(links[ev.recovery].dismissedBy).toBe("ADMIN");
  });

  it("offers Restore only when it would succeed", async () => {
    const p = await project("DRAFT", { zip: "28801" });
    await linkProjectToEvent(db, u.admin, p, ev.zip28801);
    await unlinkProjectFromEvent(db, u.admin, p, ev.zip28801);
    const row = async () => (await listProjectEventLinks(db, u.admin, p)).find((l) => l.eventId === ev.zip28801)!;
    expect(await row()).toMatchObject({ state: "DISMISSED", canRelink: true, inArea: true });
    await sys((tx) => tx.query(`UPDATE projects SET zip = '28806' WHERE id = $1`, [p]));
    expect(await row()).toMatchObject({ state: "DISMISSED", canRelink: false, inArea: false });
    await expect(linkProjectToEvent(db, u.admin, p, ev.zip28801)).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("does not let a member of the owning org act as an administrator on its own project", async () => {
    // A county administrator who is only a VIEWER of the owning org may not decide about that org's project links,
    // matching the rule that nobody reviews their own organization's project.
    const viewerAdmin = await makeUser(db, "viewer-admin-link@example.test");
    await sys((tx) => tx.query(`INSERT INTO organization_memberships (org_id, user_id, role, status) VALUES ($1, $2, 'VIEWER', 'ACTIVE')`, [orgA, viewerAdmin]));
    await assignCountyAdmin(db, exec, { email: "viewer-admin-link@example.test", countyId: buncombe, reason: "Viewer who is also coordinator" });
    const p = await project();
    await linkProjectToEvent(db, u.editor, p, ev.buncombe);
    await unlinkProjectFromEvent(db, u.caB, p, ev.buncombe);
    await expect(linkProjectToEvent(db, viewerAdmin, p, ev.buncombe)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(unlinkProjectFromEvent(db, viewerAdmin, p, ev.second)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await listLinkableEvents(db, viewerAdmin, p)).toEqual([]);
    expect((await linkRow(p, ev.buncombe)).state).toBe("DISMISSED");
    // Administrators who are not members still can.
    await expect(linkProjectToEvent(db, u.caB, p, ev.buncombe)).resolves.toBeUndefined();
  });
});
