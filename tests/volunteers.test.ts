import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver, Tx } from "@/server/db";
import { runIn } from "@/server/db/context";
import { createCounty } from "@/server/modules/counties";
import { addNeed, createProject, reviewProject, setProjectStatus, submitProject } from "@/server/modules/projects";
import { signUpForNeed } from "@/server/modules/volunteers";
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
