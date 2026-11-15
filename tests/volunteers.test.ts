import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDriver, type Driver, type Tx } from "@/server/db";
import { migrate } from "@/server/db/migrate";
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

  it("stops one email taking two slots of a need, without telling the caller, and applies a per-email daily limit", async () => {
    const { needIds } = await makeProject("OPEN", [{}, {}, {}, {}, {}, {}], "Many needs project");
    const first = await signup(needIds[0], { email: "Dup@Example.test" });
    // The same email again (different letter case) quietly resolves to the existing sign-up: no second row, no second email.
    const again = await signup(needIds[0], { email: "dup@example.test" });
    expect(again.commitmentId).toBe(first.commitmentId);
    const rows = await sys((tx) => tx.query(`SELECT 1 FROM volunteer_commitments WHERE need_id = $1 AND email = 'dup@example.test'`, [needIds[0]]));
    expect(rows).toHaveLength(1);
    const mails = await sys((tx) => tx.query(`SELECT 1 FROM notification_jobs WHERE recipient_email = 'dup@example.test'`));
    expect(mails).toHaveLength(1);
    for (const id of needIds.slice(1, 5)) await signup(id, { email: "dup@example.test" });
    // 5 sign-ups so far for this email in the last 24 hours (needs 0-4); the 6th is refused.
    await expect(signup(needIds[5], { email: "dup@example.test" })).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("does not reveal whether an email is already signed up for a shift", async () => {
    const { needIds } = await makeProject("OPEN", [{ slots: 1 }], "No oracle project");
    await signup(needIds[0], { email: "holder@example.test" });
    // The shift is full. The holder asking again and a stranger asking must get the very same answer.
    const asHolder = await signup(needIds[0], { email: "holder@example.test" }).catch((e: Error & { code?: string }) => e);
    const asStranger = await signup(needIds[0], { email: "stranger@example.test" }).catch((e: Error & { code?: string }) => e);
    expect(asHolder).toBeInstanceOf(Error);
    expect(asStranger).toBeInstanceOf(Error);
    expect((asHolder as { code?: string }).code).toBe((asStranger as { code?: string }).code);
    expect((asHolder as Error).message).toBe((asStranger as Error).message);
  });

  it("does not count cancelled sign-ups against the daily limit", async () => {
    const { needIds } = await makeProject("OPEN", [{}, {}, {}, {}, {}, {}], "Cancel frees the limit project");
    const email = "canceller@example.test";
    for (const id of needIds.slice(0, 5)) await signup(id, { email });
    await expect(signup(needIds[5], { email })).rejects.toMatchObject({ code: "RATE_LIMITED" });
    // Someone else cannot lock this person out for a day: once they cancel one, they can sign up again.
    const t = await sys((tx) => tx.query<{ body_text: string }>(`SELECT body_text FROM notification_jobs WHERE recipient_email = $1 ORDER BY created_at, id LIMIT 1`, [email]));
    await cancelCommitment(db, /token=([A-Za-z0-9_-]+)/.exec(t[0].body_text)![1]);
    await expect(signup(needIds[5], { email })).resolves.toBeTruthy();
  });

  it("never exceeds the slot count across many sign-ups fired at once", async () => {
    // PGlite runs transactions one at a time, so this proves the capacity LOGIC, not the row lock: the lock is exercised
    // by the real-Postgres test below (runs when DATABASE_URL points at a disposable PostGIS database).
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
      expect(v).toMatchObject({ status: "PENDING_EMAIL", privateLocationNotes: null, instructions: null, withdrawn: false });
      // A link that reached the wrong inbox (a typo'd address) must not show the volunteer's name.
      expect(v).not.toHaveProperty("volunteerName");
      expect(JSON.stringify(v)).not.toContain("Pat Volunteer");
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

describe("withdrawn projects and volunteer notices", () => {
  const tokenFor = async (email: string) => {
    const rows = await sys((tx) =>
      tx.query<{ body_text: string }>(`SELECT body_text FROM notification_jobs WHERE recipient_email = $1 AND kind = 'VOLUNTEER_CONFIRM' ORDER BY created_at DESC, id DESC LIMIT 1`, [email]),
    );
    return /token=([A-Za-z0-9_-]+)/.exec(rows[0].body_text)![1];
  };
  const join = async (needId: string, confirm: boolean) => {
    const email = uniqueEmail();
    const { commitmentId } = await signup(needId, { email });
    const token = await tokenFor(email);
    if (confirm) await confirmCommitment(db, token);
    return { email, token, commitmentId };
  };
  const notices = async (email: string) =>
    sys((tx) => tx.query<{ subject: string; body_text: string }>(`SELECT subject, body_text FROM notification_jobs WHERE recipient_email = $1 AND kind = 'VOLUNTEER_NOTICE'`, [email]));

  it("hides the meeting details and refuses confirmation once the organization cancels the project", async () => {
    const { projectId, needIds } = await makeProject("OPEN", [{ slots: 5 }], "Cancelled with volunteers project");
    const confirmed = await join(needIds[0], true);
    const pending = await join(needIds[0], false);
    expect((await getCommitmentByToken(db, confirmed.token))!).toMatchObject({ status: "CONFIRMED", withdrawn: false, privateLocationNotes: PRIVATE_NOTES });
    await setProjectStatus(db, admin, projectId, "CANCELLED");
    const view = (await getCommitmentByToken(db, confirmed.token))!;
    expect(view).toMatchObject({ withdrawn: true, privateLocationNotes: null, instructions: null });
    await expect(confirmCommitment(db, pending.token)).rejects.toMatchObject({ code: "VALIDATION" });
    expect((await getCommitmentByToken(db, pending.token))!.withdrawn).toBe(true);
    // Volunteers can still step back from a cancelled project.
    await expect(cancelCommitment(db, confirmed.token)).resolves.toBeUndefined();
  });

  it("treats a suspended organization the same way, and recovers when it is reinstated", async () => {
    const { needIds } = await makeProject("OPEN", [{ slots: 5 }], "Suspended org project");
    const confirmed = await join(needIds[0], true);
    const pending = await join(needIds[0], false);
    await sys((tx) => tx.query(`UPDATE organizations SET publication_suspended = true WHERE id = $1`, [orgA]));
    try {
      expect((await getCommitmentByToken(db, confirmed.token))!).toMatchObject({ withdrawn: true, privateLocationNotes: null, instructions: null });
      await expect(confirmCommitment(db, pending.token)).rejects.toMatchObject({ code: "VALIDATION" });
    } finally {
      await sys((tx) => tx.query(`UPDATE organizations SET publication_suspended = false WHERE id = $1`, [orgA]));
    }
    expect((await getCommitmentByToken(db, confirmed.token))!).toMatchObject({ withdrawn: false, privateLocationNotes: PRIVATE_NOTES });
    await expect(confirmCommitment(db, pending.token)).resolves.toBeUndefined();
  });

  it("emails confirmed and pending volunteers when a project is cancelled, and nobody else", async () => {
    const { projectId, needIds } = await makeProject("OPEN", [{ slots: 5 }], "Notice on cancel project");
    const confirmed = await join(needIds[0], true);
    const pending = await join(needIds[0], false);
    const stepped = await join(needIds[0], true);
    await cancelCommitment(db, stepped.token);
    const expired = await join(needIds[0], false);
    await sys((tx) => tx.query(`UPDATE volunteer_commitments SET hold_expires_at = now() - interval '1 minute' WHERE id = $1`, [expired.commitmentId]));
    await setProjectStatus(db, admin, projectId, "CANCELLED");
    for (const v of [confirmed, pending]) {
      const n = await notices(v.email);
      expect(n).toHaveLength(1);
      expect(n[0].subject.toLowerCase()).toContain("cancel");
      expect(n[0].body_text).toContain("Notice on cancel project");
      expect(n[0].body_text).not.toContain("token=");
      expect(n[0].body_text).not.toContain(PRIVATE_NOTES);
    }
    expect(await notices(stepped.email)).toHaveLength(0);
    expect(await notices(expired.email)).toHaveLength(0);
  });

  it("does not email volunteers when a project is only paused or completed", async () => {
    const { projectId, needIds } = await makeProject("OPEN", [{ slots: 5 }], "Pause sends no notice project");
    const v = await join(needIds[0], true);
    await setProjectStatus(db, admin, projectId, "PAUSED");
    await setProjectStatus(db, admin, projectId, "OPEN");
    await setProjectStatus(db, admin, projectId, "COMPLETED");
    expect(await notices(v.email)).toHaveLength(0);
  });

  it("emails a volunteer whom the organization removes", async () => {
    const { needIds } = await makeProject("OPEN", [{ slots: 5 }], "Removed volunteer project");
    const v = await join(needIds[0], true);
    await markAttendance(db, admin, v.commitmentId, "CANCELLED");
    const n = await notices(v.email);
    expect(n).toHaveLength(1);
    expect(n[0].body_text).toContain("Removed volunteer project");
    expect(n[0].body_text).not.toContain("token=");
    // Marking someone attended or a no-show sends nothing.
    const w = await join(needIds[0], true);
    await sys((tx) => tx.query(`UPDATE project_needs SET starts_at = now() - interval '1 hour' WHERE id = $1`, [needIds[0]]));
    await markAttendance(db, admin, w.commitmentId, "ATTENDED");
    expect(await notices(w.email)).toHaveLength(0);
  });
});

describe("database guards", () => {
  it("requires a hold expiry on every pending sign-up", async () => {
    const { needIds } = await makeProject("OPEN", [{}], "Hold expiry constraint project");
    await expect(
      sys((tx) =>
        tx.query(
          `INSERT INTO volunteer_commitments (need_id, volunteer_name, email, status, token_hash, hold_expires_at, consent_share)
           VALUES ($1, 'No Hold', 'nohold@example.test', 'PENDING_EMAIL', repeat('a', 64), NULL, true)`,
          [needIds[0]],
        ),
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});

// Real-Postgres concurrency: PGlite (the default test database) serialises transactions, so only a real server can
// prove that the row lock on the need keeps the last slots from being given out twice. Point DATABASE_URL at a
// disposable PostGIS database (CI does) to run this; it is skipped otherwise.
describe.skipIf(!process.env.DATABASE_URL)("sign-up capacity on real PostgreSQL", () => {
  it("never overbooks when sign-ups truly race", async () => {
    const pg = await createDriver({ databaseUrl: process.env.DATABASE_URL });
    try {
      await migrate(pg);
      const saved = db;
      db = pg;
      try {
        const rexec = await makeUser(pg, `race-exec-${Date.now()}@example.test`);
        await grantRole(pg, rexec, "PLATFORM_ADMIN");
        const radmin = await makeUser(pg, `race-admin-${Date.now()}@example.test`);
        const county = await createCounty(pg, rexec, { name: `Race ${Date.now() % 100000}`, state: "NC" });
        const org = await makeOrg(pg, { name: `Race Org ${Date.now()}`, members: [{ userId: radmin, role: "ORG_ADMIN" }] });
        await runIn(pg, { kind: "system" }, (tx) => tx.query(`INSERT INTO organization_counties (org_id, county_id) VALUES ($1, $2)`, [org, county]));
        const pid = await createProject(pg, radmin, org, {
          title: "Race project", description: "A project used to race sign-ups for the last slots.",
          countyId: county, zip: "28801", audience: "COMMUNITY",
        });
        const needId = await addNeed(pg, radmin, pid, { title: "Race crew", slotsNeeded: 3, startsAt: future(48), endsAt: future(52) });
        await submitProject(pg, radmin, pid);
        await reviewProject(pg, rexec, pid, { decision: "APPROVE", note: "Approved for the race" });
        const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => signup(needId, { email: `racer-${Date.now()}-${i}@example.test` })));
        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
        expect(await holding(needId)).toBe(3);
      } finally {
        db = saved;
      }
    } finally {
      await pg.close();
    }
  });
});
