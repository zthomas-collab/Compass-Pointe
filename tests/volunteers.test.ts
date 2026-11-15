import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver, Tx } from "@/server/db";
import { runIn } from "@/server/db/context";
import { assignCountyAdmin, createCounty } from "@/server/modules/counties";
import { addNeed, createProject, getPublicProject, removeNeed, reviewProject, searchProjects, setProjectStatus, submitProject, updateNeed } from "@/server/modules/projects";
import { cancelCommitment, confirmCommitment, getCommitmentByToken, listRoster, markAttendance, signUpForNeed } from "@/server/modules/volunteers";
import { freshDb } from "./helpers/db";
import { grantRole, makeOrg, makeUser } from "./helpers/fixtures";

let db: Driver;
let exec: string;
let admin: string;
let orgA: string;
let buncombe: string;
const sys = <T>(fn: (tx: Tx) => Promise<T>) => runIn(db, { kind: "system" }, fn);

const PRIVATE_NOTES = "Meet at the gravel lot behind the church";
const INSTRUCTIONS = "Park on Elm Street and bring gloves";
const future = (hours: number) => new Date(Date.now() + hours * 3600_000).toISOString();

type NeedOpts = { slots?: number; startsAt?: string; endsAt?: string; title?: string };

/** Create a project with the given needs and walk it to the requested status. */
async function makeProject(
  to: "DRAFT" | "PENDING_REVIEW" | "OPEN" | "PAUSED" | "COMPLETED",
  needs: NeedOpts[] = [{}],
  title = "Volunteer sign-up test project",
): Promise<{ projectId: string; needIds: string[] }> {
  const projectId = await createProject(db, admin, orgA, {
    title,
    description: "Volunteers help clear flood damage from homes in the neighborhood.",
    countyId: buncombe,
    zip: "28801",
    audience: "COMMUNITY",
    privateLocationNotes: PRIVATE_NOTES,
  });
  const needIds: string[] = [];
  for (const [i, n] of needs.entries()) {
    needIds.push(
      await addNeed(db, admin, projectId, {
        title: n.title ?? `Crew ${i + 1}`,
        slotsNeeded: n.slots ?? 5,
        startsAt: n.startsAt ?? future(48),
        endsAt: n.endsAt ?? future(52),
        instructions: INSTRUCTIONS,
      }),
    );
  }
  if (to === "DRAFT") return { projectId, needIds };
  await submitProject(db, admin, projectId);
  if (to === "PENDING_REVIEW") return { projectId, needIds };
  await reviewProject(db, exec, projectId, { decision: "APPROVE", note: "Approved for volunteers" });
  if (to === "OPEN") return { projectId, needIds };
  if (to === "PAUSED") await setProjectStatus(db, admin, projectId, "PAUSED");
  else await setProjectStatus(db, admin, projectId, "COMPLETED");
  return { projectId, needIds };
}

const signup = (needId: string, over: Record<string, unknown> = {}) =>
  signUpForNeed(db, { needId, name: "Pat Volunteer", email: "pat@example.test", phone: "555-010-0199", consentShare: true, ...over });

let n = 0;
const uniqueEmail = () => `vol-${++n}@example.test`;
const holding = async (needId: string) =>
  (
    await sys((tx) =>
      tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM volunteer_commitments
          WHERE need_id = $1 AND (status IN ('CONFIRMED','ATTENDED') OR (status = 'PENDING_EMAIL' AND hold_expires_at > now()))`,
        [needId],
      ),
    )
  )[0].n;
const total = async () => (await sys((tx) => tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM volunteer_commitments`)))[0].n;

beforeAll(async () => {
  db = await freshDb();
  exec = await makeUser(db, "exec@example.test");
  await grantRole(db, exec, "PLATFORM_ADMIN");
  buncombe = await createCounty(db, exec, { name: "Buncombe", state: "NC", fips: "37021" });
  admin = await makeUser(db, "org-admin@example.test");
  orgA = await makeOrg(db, { name: "Org A", members: [{ userId: admin, role: "ORG_ADMIN" }] });
  await sys((tx) => tx.query(`INSERT INTO organization_counties (org_id, county_id) VALUES ($1, $2)`, [orgA, buncombe]));
});
afterAll(async () => db?.close());

describe("volunteer sign-up", () => {
  it("holds a slot as PENDING_EMAIL and queues one confirmation email with a link", async () => {
    const { needIds } = await makeProject("OPEN");
    const { commitmentId } = await signup(needIds[0], { email: "link@example.test" });
    expect(commitmentId).toMatch(/^[0-9a-f-]{36}$/);
    const row = (await sys((tx) => tx.query<Record<string, unknown>>(`SELECT * FROM volunteer_commitments WHERE id = $1`, [commitmentId])))[0];
    expect(row.status).toBe("PENDING_EMAIL");
    const hold = await sys((tx) =>
      tx.query(`SELECT 1 FROM volunteer_commitments WHERE id = $1 AND hold_expires_at > now() + interval '23 hours' AND hold_expires_at < now() + interval '25 hours'`, [commitmentId]),
    );
    expect(hold).toHaveLength(1);
    const jobs = await sys((tx) =>
      tx.query<{ kind: string; body_text: string }>(`SELECT kind, body_text FROM notification_jobs WHERE recipient_email = 'link@example.test'`),
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0].kind).toBe("VOLUNTEER_CONFIRM");
    expect(jobs[0].body_text).toContain("/volunteer/commitments?token=");
    const token = /token=([A-Za-z0-9_-]+)/.exec(jobs[0].body_text)![1];
    expect(token.length).toBeGreaterThanOrEqual(40);
    expect(String(row.token_hash)).toHaveLength(64);
    expect(Object.values(row).some((v) => v === token)).toBe(false);
  });

  it("refuses a project that is not OPEN and a need whose shift has ended", async () => {
    const before = await total();
    for (const state of ["DRAFT", "PENDING_REVIEW", "PAUSED", "COMPLETED"] as const) {
      const { needIds } = await makeProject(state, [{}], `Not open: ${state}`);
      await expect(signup(needIds[0], { email: uniqueEmail() })).rejects.toMatchObject({ code: "VALIDATION" });
    }
    const ended = await makeProject("OPEN", [{ startsAt: future(-5), endsAt: future(-2) }], "Ended shift project");
    await expect(signup(ended.needIds[0], { email: uniqueEmail() })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(signup("00000000-0000-0000-0000-000000000000", { email: uniqueEmail() })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await total()).toBe(before);
  });

  it("requires name, a valid email, and consent to share contact details", async () => {
    const { needIds } = await makeProject("OPEN", [{}], "Validation project");
    const before = await total();
    await expect(signup(needIds[0], { name: "" })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(signup(needIds[0], { email: "not-an-email" })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(signup(needIds[0], { consentShare: false })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(signup(needIds[0], { consentShare: undefined })).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await total()).toBe(before);
    await expect(signup(needIds[0], { email: uniqueEmail(), consentShare: "on" })).resolves.toBeTruthy();
  });

  it("stops one email taking two slots of a need, and applies a per-email daily limit", async () => {
    const { needIds } = await makeProject("OPEN", [{}, {}, {}, {}, {}, {}], "Many needs project");
    await signup(needIds[0], { email: "Dup@Example.test" });
    await expect(signup(needIds[0], { email: "dup@example.test" })).rejects.toMatchObject({ code: "CONFLICT" });
    for (const id of needIds.slice(0, 5)) {
      if (id === needIds[0]) continue;
      await signup(id, { email: "dup@example.test" });
    }
    // 5 sign-ups so far for this email in the last 24 hours (needs 0-4); the 6th is refused.
    await expect(signup(needIds[5], { email: "dup@example.test" })).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("never overbooks under concurrent sign-ups", async () => {
    const { needIds } = await makeProject("OPEN", [{ slots: 3 }], "Concurrent project");
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => signup(needIds[0], { email: uniqueEmail() })));
    const ok = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(3);
    expect(refused).toHaveLength(5);
    expect(refused.every((r) => (r.reason as { code?: string }).code === "CONFLICT")).toBe(true);
    expect(await holding(needIds[0])).toBe(3);
  });

  it("frees a slot whose hold has expired", async () => {
    const { needIds } = await makeProject("OPEN", [{ slots: 1 }], "Expiring hold project");
    const first = await signup(needIds[0], { email: uniqueEmail() });
    await expect(signup(needIds[0], { email: uniqueEmail() })).rejects.toMatchObject({ code: "CONFLICT" });
    await sys((tx) => tx.query(`UPDATE volunteer_commitments SET hold_expires_at = now() - interval '1 minute' WHERE id = $1`, [first.commitmentId]));
    await expect(signup(needIds[0], { email: uniqueEmail() })).resolves.toBeTruthy();
    const old = await sys((tx) => tx.query<{ status: string }>(`SELECT status FROM volunteer_commitments WHERE id = $1`, [first.commitmentId]));
    expect(old[0].status).toBe("CANCELLED");
    expect(await holding(needIds[0])).toBe(1);
  });

  it("does not expose commitments to request roles", async () => {
    await expect(runIn(db, { kind: "anon" }, (tx) => tx.query(`SELECT * FROM volunteer_commitments`))).rejects.toMatchObject({ code: "42501" });
    await expect(runIn(db, { kind: "anon" }, (tx) => tx.query(`SELECT * FROM volunteer_commitment_events`))).rejects.toMatchObject({ code: "42501" });
  });

  it("audits sign-ups without personal data", async () => {
    const { needIds } = await makeProject("OPEN", [{}], "Audit project");
    const { commitmentId } = await signup(needIds[0], { name: "Zelda Audit-Test", email: "zelda-audit@example.test", phone: "555-010-7777" });
    const rows = await sys((tx) =>
      tx.query<{ details: unknown }>(`SELECT details FROM audit_logs WHERE action = 'VOLUNTEER_SIGNED_UP' AND subject_id = $1`, [commitmentId]),
    );
    expect(rows).toHaveLength(1);
    const text = JSON.stringify(rows[0].details);
    for (const pii of ["Zelda", "zelda-audit", "555-010-7777"]) expect(text).not.toContain(pii);
  });
});

describe("token page, confirm and cancel", () => {
  /** The volunteer's token exists only in the email, so tests read it from the queued message like a real person would. */
  const tokenFor = async (email: string) => {
    const rows = await sys((tx) =>
      tx.query<{ body_text: string }>(`SELECT body_text FROM notification_jobs WHERE recipient_email = $1 AND kind = 'VOLUNTEER_CONFIRM' ORDER BY created_at DESC, id DESC LIMIT 1`, [email]),
    );
    return /token=([A-Za-z0-9_-]+)/.exec(rows[0].body_text)![1];
  };
  const fresh = async (opts: NeedOpts = {}) => {
    const { needIds } = await makeProject("OPEN", [opts], `Token project ${++n}`);
    const email = uniqueEmail();
    const { commitmentId } = await signup(needIds[0], { email });
    return { needId: needIds[0], email, commitmentId, token: await tokenFor(email) };
  };
  const row = async (id: string) =>
    (await sys((tx) => tx.query<{ status: string; confirmed_at: Date | null; cancelled_at: Date | null }>(`SELECT status, confirmed_at, cancelled_at FROM volunteer_commitments WHERE id = $1`, [id])))[0];
  const events = async (id: string) =>
    (await sys((tx) => tx.query<{ event_type: string; actor_role: string }>(`SELECT event_type, actor_role FROM volunteer_commitment_events WHERE commitment_id = $1 ORDER BY occurred_at, id`, [id])));

  it("shows a pending sign-up read-only and never changes it on view", async () => {
    const f = await fresh();
    for (let i = 0; i < 5; i++) {
      const v = (await getCommitmentByToken(db, f.token))!;
      expect(v).toMatchObject({ status: "PENDING_EMAIL", privateLocationNotes: null, instructions: null, volunteerName: "Pat Volunteer" });
      expect(v.project.title).toContain("Token project");
      expect(v.holdExpiresAt).not.toBeNull();
    }
    expect(await row(f.commitmentId)).toMatchObject({ status: "PENDING_EMAIL", confirmed_at: null, cancelled_at: null });
    expect((await events(f.commitmentId)).map((e) => e.event_type)).toEqual(["SIGNED_UP"]);
  });

  it("confirms with an explicit call and then reveals the private details", async () => {
    const f = await fresh();
    await confirmCommitment(db, f.token);
    const v = (await getCommitmentByToken(db, f.token))!;
    expect(v).toMatchObject({ status: "CONFIRMED", privateLocationNotes: PRIVATE_NOTES, instructions: INSTRUCTIONS });
    await expect(confirmCommitment(db, f.token)).resolves.toBeUndefined();
    expect((await events(f.commitmentId)).map((e) => e.event_type)).toEqual(["SIGNED_UP", "CONFIRMED"]);
    const audited = await sys((tx) => tx.query(`SELECT 1 FROM audit_logs WHERE action = 'VOLUNTEER_CONFIRMED' AND subject_id = $1`, [f.commitmentId]));
    expect(audited).toHaveLength(1);
  });

  it("reveals nothing for a wrong or malformed token", async () => {
    const f = await fresh();
    const hash = (await sys((tx) => tx.query<{ token_hash: string }>(`SELECT token_hash FROM volunteer_commitments WHERE id = $1`, [f.commitmentId])))[0].token_hash;
    for (const bad of ["", "short", "x".repeat(43), "not a token!!", hash]) {
      expect(await getCommitmentByToken(db, bad)).toBeNull();
      await expect(confirmCommitment(db, bad)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(cancelCommitment(db, bad)).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    expect(await row(f.commitmentId)).toMatchObject({ status: "PENDING_EMAIL", confirmed_at: null });
  });

  it("refuses to confirm after the hold expires, cancels it, and frees the slot", async () => {
    const f = await fresh({ slots: 1 });
    await sys((tx) => tx.query(`UPDATE volunteer_commitments SET hold_expires_at = now() - interval '1 minute' WHERE id = $1`, [f.commitmentId]));
    await expect(confirmCommitment(db, f.token)).rejects.toMatchObject({ code: "VALIDATION" });
    expect((await row(f.commitmentId)).status).toBe("CANCELLED");
    expect((await events(f.commitmentId)).map((e) => `${e.event_type}:${e.actor_role}`)).toContain("HOLD_EXPIRED:SYSTEM");
    expect((await getCommitmentByToken(db, f.token))!).toMatchObject({ status: "CANCELLED", privateLocationNotes: null, instructions: null });
    await expect(signup(f.needId, { email: uniqueEmail() })).resolves.toBeTruthy();
  });

  it("cancels a pending or confirmed sign-up, frees the slot, and is idempotent", async () => {
    const f = await fresh({ slots: 1 });
    await confirmCommitment(db, f.token);
    await expect(signup(f.needId, { email: uniqueEmail() })).rejects.toMatchObject({ code: "CONFLICT" });
    await cancelCommitment(db, f.token);
    expect((await row(f.commitmentId)).status).toBe("CANCELLED");
    await expect(cancelCommitment(db, f.token)).resolves.toBeUndefined();
    expect((await getCommitmentByToken(db, f.token))!).toMatchObject({ status: "CANCELLED", privateLocationNotes: null, instructions: null });
    await expect(signup(f.needId, { email: uniqueEmail() })).resolves.toBeTruthy();
    const p = await fresh();
    await cancelCommitment(db, p.token);
    expect((await row(p.commitmentId)).status).toBe("CANCELLED");
    await expect(confirmCommitment(db, p.token)).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("refuses to cancel once the shift has ended or attendance is recorded", async () => {
    const a = await fresh();
    await confirmCommitment(db, a.token);
    await sys((tx) => tx.query(`UPDATE project_needs SET starts_at = now() - interval '5 hours', ends_at = now() - interval '1 hour' WHERE id = $1`, [a.needId]));
    await expect(cancelCommitment(db, a.token)).rejects.toMatchObject({ code: "VALIDATION" });
    expect((await row(a.commitmentId)).status).toBe("CONFIRMED");
    const b = await fresh();
    await confirmCommitment(db, b.token);
    await sys((tx) => tx.query(`UPDATE volunteer_commitments SET status = 'ATTENDED' WHERE id = $1`, [b.commitmentId]));
    await expect(cancelCommitment(db, b.token)).rejects.toMatchObject({ code: "VALIDATION" });
    expect((await row(b.commitmentId)).status).toBe("ATTENDED");
  });
});

describe("spots left, roster and attendance", () => {
  let editor: string;
  let viewer: string;
  let otherOrg: string;
  let caBuncombe: string;
  let caHenderson: string;
  let plain: string;
  const userId = async (email: string) => (await sys((tx) => tx.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [email])))[0].id;
  const tokenFor = async (email: string) => {
    const rows = await sys((tx) =>
      tx.query<{ body_text: string }>(`SELECT body_text FROM notification_jobs WHERE recipient_email = $1 AND kind = 'VOLUNTEER_CONFIRM' ORDER BY created_at DESC, id DESC LIMIT 1`, [email]),
    );
    return /token=([A-Za-z0-9_-]+)/.exec(rows[0].body_text)![1];
  };
  const volunteer = async (needId: string, confirm: boolean, over: Record<string, unknown> = {}) => {
    const email = uniqueEmail();
    const { commitmentId } = await signup(needId, { email, ...over });
    const token = await tokenFor(email);
    if (confirm) await confirmCommitment(db, token);
    return { commitmentId, token, email };
  };
  const status = async (id: string) => (await sys((tx) => tx.query<{ status: string }>(`SELECT status FROM volunteer_commitments WHERE id = $1`, [id])))[0].status;

  beforeAll(async () => {
    editor = await makeUser(db, "roster-editor@example.test");
    viewer = await makeUser(db, "roster-viewer@example.test");
    otherOrg = await makeUser(db, "roster-other-org@example.test");
    plain = await makeUser(db, "roster-plain@example.test");
    for (const [uid, role] of [[editor, "EDITOR"], [viewer, "VIEWER"]] as const) {
      await sys((tx) => tx.query(`INSERT INTO organization_memberships (org_id, user_id, role, status) VALUES ($1, $2, $3::membership_role, 'ACTIVE')`, [orgA, uid, role]));
    }
    const orgB = await makeOrg(db, { name: "Org B roster", members: [{ userId: otherOrg, role: "ORG_ADMIN" }] });
    expect(orgB).toBeTruthy();
    const henderson = await createCounty(db, exec, { name: "Henderson", state: "NC", fips: "37089" });
    await assignCountyAdmin(db, exec, { email: "roster-ca-buncombe@example.test", countyId: buncombe, reason: "Buncombe coordinator" });
    await assignCountyAdmin(db, exec, { email: "roster-ca-henderson@example.test", countyId: henderson, reason: "Henderson coordinator" });
    caBuncombe = await userId("roster-ca-buncombe@example.test");
    caHenderson = await userId("roster-ca-henderson@example.test");
  });

  it("shows real spots left on public needs and never volunteer data", async () => {
    const { projectId, needIds } = await makeProject("OPEN", [{ slots: 3 }], "Spots left project");
    const a = await volunteer(needIds[0], true, { name: "Quentin Confirmed", phone: "555-010-4444" });
    await volunteer(needIds[0], false, { name: "Priya Pending" });
    const c = await volunteer(needIds[0], true, { name: "Carla Cancelled" });
    await cancelCommitment(db, c.token);
    const p = (await getPublicProject(db, projectId))!;
    expect(p.needs[0]).toMatchObject({ slotsNeeded: 3, slotsTaken: 2, spotsLeft: 1 });
    expect(p).toMatchObject({ totalSlots: 3, spotsLeft: 1 });
    const found = (await searchProjects(db, { q: "Spots left project" })).projects.find((x) => x.id === projectId)!;
    expect(found.spotsLeft).toBe(1);
    const everything = JSON.stringify([p, await searchProjects(db, {})]);
    for (const secret of ["Quentin", "Priya", "Carla", "555-010-4444", "@example.test", PRIVATE_NOTES, INSTRUCTIONS]) {
      expect(everything).not.toContain(secret);
    }
    const cols = (await sys((tx) => tx.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'public_project_needs'`))).map((r) => r.column_name);
    expect(cols).toContain("slots_taken");
    for (const banned of ["email", "phone", "volunteer_name", "token_hash", "instructions"]) expect(cols).not.toContain(banned);
    expect(a.commitmentId).toBeTruthy();
  });

  it("shows full needs as zero spots left and an expired hold as free", async () => {
    const { projectId, needIds } = await makeProject("OPEN", [{ slots: 2 }], "Full needs project");
    await volunteer(needIds[0], true);
    const pending = await volunteer(needIds[0], false);
    expect((await getPublicProject(db, projectId))!.needs[0]).toMatchObject({ spotsLeft: 0, slotsTaken: 2 });
    await sys((tx) => tx.query(`UPDATE volunteer_commitments SET hold_expires_at = now() - interval '1 minute' WHERE id = $1`, [pending.commitmentId]));
    expect((await getPublicProject(db, projectId))!.needs[0]).toMatchObject({ spotsLeft: 1, slotsTaken: 1 });
  });

  it("lists the roster for the owning org's editors, county admins and executives", async () => {
    const { projectId, needIds } = await makeProject("OPEN", [{ slots: 4 }], "Roster project");
    await volunteer(needIds[0], true, { name: "Rosa Roster", phone: "555-010-5555" });
    const stale = await volunteer(needIds[0], false, { name: "Stale Hold" });
    await sys((tx) => tx.query(`UPDATE volunteer_commitments SET hold_expires_at = now() - interval '1 minute' WHERE id = $1`, [stale.commitmentId]));
    for (const who of [admin, editor, caBuncombe, exec]) {
      const roster = await listRoster(db, who, projectId);
      expect(roster.map((r) => r.volunteerName)).toEqual(["Rosa Roster"]);
      expect(roster[0]).toMatchObject({ phone: "555-010-5555", status: "CONFIRMED", needTitle: expect.any(String) });
      expect(roster[0].email).toContain("@example.test");
    }
  });

  it("refuses the roster to viewers, other orgs, other counties, and the public", async () => {
    const { projectId } = await makeProject("OPEN", [{}], "Private roster project");
    for (const who of [viewer, otherOrg, caHenderson, plain]) {
      await expect(listRoster(db, who, projectId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    await expect(listRoster(db, admin, "00000000-0000-0000-0000-000000000000")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("marks attendance and no-shows once the shift starts, and cancelling by the org frees the slot", async () => {
    const { needIds } = await makeProject("OPEN", [{ slots: 2 }], "Attendance project");
    const a = await volunteer(needIds[0], true);
    const b = await volunteer(needIds[0], true);
    await expect(markAttendance(db, admin, a.commitmentId, "ATTENDED")).rejects.toMatchObject({ code: "VALIDATION" });
    await sys((tx) => tx.query(`UPDATE project_needs SET starts_at = now() - interval '1 hour', ends_at = now() + interval '3 hours' WHERE id = $1`, [needIds[0]]));
    await markAttendance(db, editor, a.commitmentId, "ATTENDED");
    await markAttendance(db, admin, b.commitmentId, "NO_SHOW");
    expect(await status(a.commitmentId)).toBe("ATTENDED");
    expect(await status(b.commitmentId)).toBe("NO_SHOW");
    const by = await sys((tx) => tx.query<{ attendance_marked_by: string }>(`SELECT attendance_marked_by FROM volunteer_commitments WHERE id = $1`, [a.commitmentId]));
    expect(by[0].attendance_marked_by).toBe(editor);
    const ev = await sys((tx) => tx.query<{ actor_role: string }>(`SELECT actor_role FROM volunteer_commitment_events WHERE commitment_id = $1 AND event_type = 'ATTENDED'`, [a.commitmentId]));
    expect(ev[0].actor_role).toBe("ORG");

    const full = await makeProject("OPEN", [{ slots: 1 }], "Org cancel project");
    const v = await volunteer(full.needIds[0], true);
    await expect(signup(full.needIds[0], { email: uniqueEmail() })).rejects.toMatchObject({ code: "CONFLICT" });
    await markAttendance(db, editor, v.commitmentId, "CANCELLED");
    expect(await status(v.commitmentId)).toBe("CANCELLED");
    await expect(signup(full.needIds[0], { email: uniqueEmail() })).resolves.toBeTruthy();
  });

  it("refuses attendance changes by viewers, other orgs, and county admins", async () => {
    const { needIds } = await makeProject("OPEN", [{}], "Attendance guard project");
    const v = await volunteer(needIds[0], true);
    for (const who of [viewer, otherOrg, caBuncombe, caHenderson, plain, exec]) {
      await expect(markAttendance(db, who, v.commitmentId, "CANCELLED")).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    expect(await status(v.commitmentId)).toBe("CONFIRMED");
    await expect(markAttendance(db, admin, "00000000-0000-0000-0000-000000000000", "CANCELLED")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("guards needs that already have volunteers", async () => {
    const { projectId, needIds } = await makeProject("DRAFT", [{ slots: 3 }], "Needs guard project");
    // Volunteers can only sign up once open, so open it, sign up, then pause (a paused project still allows edits).
    await submitProject(db, admin, projectId);
    await reviewProject(db, exec, projectId, { decision: "APPROVE", note: "Approved for volunteers" });
    const v = await volunteer(needIds[0], true);
    await volunteer(needIds[0], true);
    const reopen = () => reviewProject(db, exec, projectId, { decision: "APPROVE", note: "Re-approved after edit" });
    const guard = { code: "VALIDATION", message: expect.stringMatching(/volunteer/i) };
    const current = (await sys((tx) => tx.query<{ starts_at: Date; ends_at: Date }>(`SELECT starts_at, ends_at FROM project_needs WHERE id = $1`, [needIds[0]])))[0];
    const same = { title: "Crew 1", slotsNeeded: 3, startsAt: new Date(current.starts_at).toISOString(), endsAt: new Date(current.ends_at).toISOString() };
    await expect(removeNeed(db, admin, needIds[0])).rejects.toMatchObject(guard);
    await expect(updateNeed(db, admin, needIds[0], { ...same, slotsNeeded: 1 })).rejects.toMatchObject(guard);
    await expect(updateNeed(db, admin, needIds[0], { ...same, startsAt: future(60), endsAt: future(64) })).rejects.toMatchObject(guard);
    await expect(updateNeed(db, admin, needIds[0], { ...same, slotsNeeded: 2 })).resolves.toBeUndefined();
    await reopen();
    await expect(updateNeed(db, admin, needIds[0], { ...same, slotsNeeded: 6, details: "More help wanted" })).resolves.toBeUndefined();
    await reopen();
    // Once nobody is signed up any more, the shift time can change again (but the need still cannot be deleted: it has history).
    await cancelCommitment(db, v.token);
    const second = await sys((tx) => tx.query<{ id: string }>(`SELECT id FROM volunteer_commitments WHERE need_id = $1 AND status = 'CONFIRMED'`, [needIds[0]]));
    await markAttendance(db, admin, second[0].id, "CANCELLED");
    await expect(updateNeed(db, admin, needIds[0], { ...same, startsAt: future(60), endsAt: future(64) })).resolves.toBeUndefined();
    await reopen();
    await expect(removeNeed(db, admin, needIds[0])).rejects.toMatchObject(guard);
  });
});
