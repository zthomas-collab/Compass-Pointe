import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver, Tx } from "@/server/db";
import { runIn } from "@/server/db/context";
import { assignCountyAdmin, createCounty } from "@/server/modules/counties";
import {
  addNeed, createProject, getProjectForEditor, listOrgProjects, listProjectsForReview, removeNeed, reviewProject, setProjectStatus,
  getPublicProject, searchProjects, submitProject, updateNeed, updateProject,
} from "@/server/modules/projects";
import { eastern, easternLocalToIso, isoToEasternLocal } from "@/lib/projects";
import { freshDb } from "./helpers/db";
import { grantRole, makeOrg, makeUser } from "./helpers/fixtures";

let db: Driver;
let exec: string;
let buncombe: string;
let henderson: string;
let orgA: string;
let orgB: string;
let orgSuspended: string;
let u: Record<"admin" | "editor" | "viewer" | "other" | "suspended" | "caB" | "caH" | "plain", string>;
let hendersonZip: string;
const sys = <T>(fn: (tx: Tx) => Promise<T>) => runIn(db, { kind: "system" }, fn);
const count = async () => (await sys((tx) => tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM projects`)))[0].n;

const base = (over: Record<string, unknown> = {}) => ({
  title: "Mucking out flooded homes",
  description: "Volunteers help clear flood damage from homes in the neighborhood.",
  countyId: buncombe,
  zip: "28801",
  audience: "COMMUNITY",
  privateLocationNotes: "Meet at the gravel lot behind the church",
  ...over,
});

beforeAll(async () => {
  db = await freshDb();
  exec = await makeUser(db, "exec@example.test");
  await grantRole(db, exec, "PLATFORM_ADMIN");
  buncombe = await createCounty(db, exec, { name: "Buncombe", state: "NC", fips: "37021" });
  henderson = await createCounty(db, exec, { name: "Henderson", state: "NC", fips: "37089" });
  u = {
    admin: await makeUser(db, "org-admin@example.test"),
    editor: await makeUser(db, "org-editor@example.test"),
    viewer: await makeUser(db, "org-viewer@example.test"),
    other: await makeUser(db, "other-org@example.test"),
    suspended: await makeUser(db, "suspended-org@example.test"),
    caB: "",
    caH: "",
    plain: await makeUser(db, "plain@example.test"),
  };
  orgA = await makeOrg(db, { name: "Org A", members: [{ userId: u.admin, role: "ORG_ADMIN" }, { userId: u.editor, role: "EDITOR" }, { userId: u.viewer, role: "VIEWER" }] });
  orgB = await makeOrg(db, { name: "Org B", members: [{ userId: u.other, role: "ORG_ADMIN" }] });
  orgSuspended = await makeOrg(db, { name: "Org Suspended", status: "SUSPENDED", members: [{ userId: u.suspended, role: "ORG_ADMIN" }] });
  for (const org of [orgA, orgB, orgSuspended]) {
    await sys((tx) => tx.query(`INSERT INTO organization_counties (org_id, county_id) VALUES ($1, $2)`, [org, buncombe]));
  }
  await assignCountyAdmin(db, exec, { email: "ca-buncombe@example.test", countyId: buncombe, reason: "Buncombe coordinator" });
  await assignCountyAdmin(db, exec, { email: "ca-henderson@example.test", countyId: henderson, reason: "Henderson coordinator" });
  const id = (email: string) => sys((tx) => tx.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [email])).then((r) => r[0].id);
  u.caB = await id("ca-buncombe@example.test");
  u.caH = await id("ca-henderson@example.test");
  // A Henderson ZIP that has no Buncombe share, from the shipped crosswalk.
  hendersonZip = (await sys((tx) =>
    tx.query<{ zip: string }>(
      `SELECT zip FROM zip_county WHERE county_fips = '37089'
          AND zip NOT IN (SELECT zip FROM zip_county WHERE county_fips = '37021') ORDER BY zip LIMIT 1`,
    ),
  ))[0].zip;
});
afterAll(async () => db?.close());

describe("project creation and editing", () => {
  it("lets org admins and editors create a DRAFT project, and audits it", async () => {
    const a = await createProject(db, u.admin, orgA, base());
    const e = await createProject(db, u.editor, orgA, base({ title: "Editor's project title" }));
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    const p = (await getProjectForEditor(db, u.admin, a))!;
    expect(p).toMatchObject({ status: "DRAFT", needs: [], countyName: "Buncombe", zip: "28801", orgId: orgA });
    expect((await getProjectForEditor(db, u.editor, e))!.title).toBe("Editor's project title");
    const audit = await sys((tx) => tx.query(`SELECT 1 FROM audit_logs WHERE action = 'PROJECT_CREATED' AND subject_id = $1`, [a]));
    expect(audit).toHaveLength(1);
  });

  it("refuses viewers, other orgs, and suspended orgs", async () => {
    const before = await count();
    await expect(createProject(db, u.viewer, orgA, base())).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(createProject(db, u.other, orgA, base())).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(createProject(db, u.suspended, orgSuspended, base())).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(createProject(db, u.plain, orgA, base())).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await count()).toBe(before);
  });

  it("requires the org to serve the county and the ZIP to belong to it", async () => {
    const before = await count();
    await expect(createProject(db, u.admin, orgA, base({ countyId: henderson, zip: hendersonZip }))).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(createProject(db, u.admin, orgA, base({ zip: hendersonZip }))).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(createProject(db, u.admin, orgA, base({ zip: "00000" }))).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await count()).toBe(before);
    await expect(createProject(db, u.admin, orgA, base({ zip: "28801" }))).resolves.toMatch(/^[0-9a-f-]{36}$/);
  });

  it("lets editors edit a draft and refuses other users", async () => {
    const id = await createProject(db, u.admin, orgA, base({ title: "Draft to edit now" }));
    await updateProject(db, u.editor, id, base({ title: "Draft edited by editor" }));
    expect((await getProjectForEditor(db, u.admin, id))!.title).toBe("Draft edited by editor");
    for (const who of [u.viewer, u.other, u.caH, u.plain]) {
      await expect(updateProject(db, who, id, base({ title: "Hijacked project title" }))).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    expect((await getProjectForEditor(db, u.admin, id))!.title).toBe("Draft edited by editor");
    await expect(updateProject(db, u.admin, "00000000-0000-0000-0000-000000000000", base())).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("scopes editor reads: owner org, the county's admin, executives only", async () => {
    const id = await createProject(db, u.admin, orgA, base({ title: "Scoped read project" }));
    for (const who of [u.editor, u.viewer, u.caB, exec]) expect((await getProjectForEditor(db, who, id))?.id).toBe(id);
    for (const who of [u.caH, u.other, u.plain]) expect(await getProjectForEditor(db, who, id)).toBeNull();
  });

  it("reports whether the reader may edit the project", async () => {
    const id = await createProject(db, u.admin, orgA, base({ title: "Project for canEdit flag" }));
    const can = async (who: string) => (await getProjectForEditor(db, who, id))!.canEdit;
    expect(await can(u.admin)).toBe(true);
    expect(await can(u.editor)).toBe(true);
    expect(await can(u.viewer)).toBe(false);
    expect(await can(u.caB)).toBe(false);
    expect(await can(exec)).toBe(false);
    expect((await listOrgProjects(db, u.viewer, orgA)).every((p) => p.canEdit === false)).toBe(true);
    await sys((tx) => tx.query(`UPDATE organizations SET publication_suspended = true WHERE id = $1`, [orgA]));
    expect(await can(u.admin)).toBe(false);
    await sys((tx) => tx.query(`UPDATE organizations SET publication_suspended = false WHERE id = $1`, [orgA]));
  });

  it("lists an org's projects for its members only", async () => {
    const list = await listOrgProjects(db, u.viewer, orgA);
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((p) => p.orgId === orgA && p.needs.length === 0)).toBe(true);
    await expect(listOrgProjects(db, u.other, orgA)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("hides projects from request roles at the database", async () => {
    await expect(runIn(db, { kind: "anon" }, (tx) => tx.query(`SELECT * FROM projects`))).rejects.toMatchObject({ code: "42501" });
    await expect(runIn(db, { kind: "anon" }, (tx) => tx.query(`SELECT * FROM project_needs`))).rejects.toMatchObject({ code: "42501" });
  });
});

describe("people needs", () => {
  const need = (over: Record<string, unknown> = {}) => ({
    title: "Debris removal crew",
    details: "Carry debris to the curb",
    urgency: "URGENT",
    slotsNeeded: 6,
    startsAt: "2026-12-06T08:00:00Z",
    endsAt: "2026-12-06T12:00:00Z",
    skills: "Strong back, work gloves",
    instructions: "Park on Elm Street",
    ...over,
  });
  const mk = (title = "Project for needs tests") => createProject(db, u.admin, orgA, base({ title }));
  const needs = async (id: string) => (await getProjectForEditor(db, u.admin, id))!.needs;
  const status = async (id: string) => (await getProjectForEditor(db, u.admin, id))!.status;
  const force = (id: string, to: string) => sys((tx) => tx.query(`UPDATE projects SET status = $2 WHERE id = $1`, [id, to]));
  const audited = async (id: string, action: string) =>
    (await sys((tx) => tx.query(`SELECT 1 FROM audit_logs WHERE action = $1 AND subject_id = $2`, [action, id]))).length;

  it("adds, edits and removes needs on a draft, and audits each", async () => {
    const id = await mk();
    const n = await addNeed(db, u.editor, id, need());
    expect(await needs(id)).toMatchObject([{ id: n, title: "Debris removal crew", slotsNeeded: 6, urgency: "URGENT" }]);
    await updateNeed(db, u.editor, n, need({ title: "Debris crew leads", slotsNeeded: "8" }));
    expect(await needs(id)).toMatchObject([{ title: "Debris crew leads", slotsNeeded: 8 }]);
    await removeNeed(db, u.editor, n);
    expect(await needs(id)).toEqual([]);
    expect(await audited(id, "PROJECT_NEED_ADDED")).toBe(1);
    expect(await audited(id, "PROJECT_NEED_UPDATED")).toBe(1);
    expect(await audited(id, "PROJECT_NEED_REMOVED")).toBe(1);
  });

  it("rejects bad slot counts and shifts that end before they start", async () => {
    const id = await mk("Project for bad needs");
    for (const slotsNeeded of [0, -3, 501, 1.5, "abc"]) {
      await expect(addNeed(db, u.admin, id, need({ slotsNeeded }))).rejects.toMatchObject({ code: "VALIDATION" });
    }
    await expect(addNeed(db, u.admin, id, need({ startsAt: "2026-12-06T08:00:00Z", endsAt: "2026-12-06T07:00:00Z" }))).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(addNeed(db, u.admin, id, need({ startsAt: "not a date" }))).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await needs(id)).toEqual([]);
  });

  it("sends an OPEN project back to review when a need changes", async () => {
    const a = await mk("Open project add need");
    await force(a, "OPEN");
    await addNeed(db, u.admin, a, need());
    expect(await status(a)).toBe("PENDING_REVIEW");

    const b = await mk("Open project edit need");
    const nb = await addNeed(db, u.admin, b, need());
    await force(b, "OPEN");
    await updateNeed(db, u.admin, nb, need({ slotsNeeded: 9 }));
    expect(await status(b)).toBe("PENDING_REVIEW");

    const c = await mk("Paused project remove need");
    const nc = await addNeed(db, u.admin, c, need());
    await force(c, "PAUSED");
    await removeNeed(db, u.admin, nc);
    expect(await status(c)).toBe("PENDING_REVIEW");
  });

  it("refuses need changes by viewers and other orgs, and on closed projects", async () => {
    const id = await mk("Project for forbidden needs");
    const n = await addNeed(db, u.admin, id, need());
    for (const who of [u.viewer, u.other, u.caH, u.plain]) {
      await expect(addNeed(db, who, id, need())).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(updateNeed(db, who, n, need())).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(removeNeed(db, who, n)).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    for (const closed of ["COMPLETED", "PENDING_REVIEW"]) {
      await force(id, closed);
      await expect(addNeed(db, u.admin, id, need())).rejects.toMatchObject({ code: "VALIDATION" });
      await expect(updateNeed(db, u.admin, n, need())).rejects.toMatchObject({ code: "VALIDATION" });
      await expect(removeNeed(db, u.admin, n)).rejects.toMatchObject({ code: "VALIDATION" });
    }
    expect(await needs(id)).toHaveLength(1);
    await expect(removeNeed(db, u.admin, "00000000-0000-0000-0000-000000000000")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("returns needs in shift order, unscheduled last", async () => {
    const id = await mk("Project for ordering needs");
    await addNeed(db, u.admin, id, need({ title: "No shift set", startsAt: "", endsAt: "" }));
    await addNeed(db, u.admin, id, need({ title: "Later shift", startsAt: "2026-12-07T08:00:00Z", endsAt: "2026-12-07T12:00:00Z" }));
    await addNeed(db, u.admin, id, need({ title: "Earlier shift", startsAt: "2026-12-06T08:00:00Z", endsAt: "2026-12-06T12:00:00Z" }));
    expect((await needs(id)).map((n) => n.title)).toEqual(["Earlier shift", "Later shift", "No shift set"]);
  });
});

describe("submit, review, and status", () => {
  const need = { title: "Volunteer crew", slotsNeeded: 5 };
  const mk = async (title: string, withNeed = true, org = orgA, by = u.admin, county = buncombe, zip = "28801") => {
    const id = await createProject(db, by, org, base({ title, countyId: county, zip }));
    if (withNeed) await addNeed(db, by, id, need);
    return id;
  };
  const get = async (id: string) => (await getProjectForEditor(db, exec, id))!;
  const audited = async (id: string, action: string) =>
    (await sys((tx) => tx.query(`SELECT 1 FROM audit_logs WHERE action = $1 AND subject_id = $2`, [action, id]))).length;
  const approve = (who: string, id: string) => reviewProject(db, who, id, { decision: "APPROVE", note: "Looks good to publish" });

  it("walks DRAFT to PENDING_REVIEW to OPEN with a reviewer, and audits each step", async () => {
    const id = await mk("Project to approve");
    await submitProject(db, u.editor, id);
    expect((await get(id)).status).toBe("PENDING_REVIEW");
    await approve(u.caB, id);
    expect((await get(id)).status).toBe("OPEN");
    const r = await sys((tx) => tx.query<{ reviewed_by: string; reviewed_at: Date | null }>(`SELECT reviewed_by, reviewed_at FROM projects WHERE id = $1`, [id]));
    expect(r[0].reviewed_by).toBe(u.caB);
    expect(r[0].reviewed_at).not.toBeNull();
    expect(await audited(id, "PROJECT_SUBMITTED")).toBe(1);
    expect(await audited(id, "PROJECT_APPROVED")).toBe(1);
  });

  it("refuses to submit a project with no needs", async () => {
    const id = await mk("Project without needs", false);
    await expect(submitProject(db, u.admin, id)).rejects.toMatchObject({ code: "VALIDATION" });
    expect((await get(id)).status).toBe("DRAFT");
    await expect(submitProject(db, u.viewer, id)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("returns a project to draft with a note, and requires a real note", async () => {
    const id = await mk("Project to return");
    await submitProject(db, u.admin, id);
    await expect(reviewProject(db, u.caB, id, { decision: "RETURN", note: "no" })).rejects.toMatchObject({ code: "VALIDATION" });
    expect((await get(id)).status).toBe("PENDING_REVIEW");
    await reviewProject(db, u.caB, id, { decision: "RETURN", note: "Please remove the street address" });
    expect(await get(id)).toMatchObject({ status: "DRAFT", reviewNote: "Please remove the street address" });
    expect(await audited(id, "PROJECT_RETURNED")).toBe(1);
  });

  it("limits review to the executive and the project's county administrators", async () => {
    const id = await mk("Project for review limits");
    await submitProject(db, u.admin, id);
    for (const who of [u.caH, u.admin, u.editor, u.plain]) {
      await expect(approve(who, id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    expect((await get(id)).status).toBe("PENDING_REVIEW");
    await approve(exec, id);
    expect((await get(id)).status).toBe("OPEN");
    await expect(approve(exec, id)).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("does not let a county administrator approve their own organization's project", async () => {
    const dual = await makeUser(db, "dual@example.test");
    await sys((tx) => tx.query(`INSERT INTO organization_memberships (org_id, user_id, role, status) VALUES ($1, $2, 'EDITOR', 'ACTIVE')`, [orgA, dual]));
    await assignCountyAdmin(db, exec, { email: "dual@example.test", countyId: buncombe, reason: "Dual role coordinator" });
    const id = await mk("Project by dual-role org");
    await submitProject(db, u.admin, id);
    await expect(approve(dual, id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await get(id)).status).toBe("PENDING_REVIEW");
    await approve(u.caB, id);
    expect((await get(id)).status).toBe("OPEN");
  });

  it("scopes the review queue by county", async () => {
    const hOrg = await makeOrg(db, { name: "Henderson Org", members: [{ userId: u.other, role: "EDITOR" }] });
    await sys((tx) => tx.query(`INSERT INTO organization_counties (org_id, county_id) VALUES ($1, $2)`, [hOrg, henderson]));
    const hp = await mk("Henderson project in queue", true, hOrg, u.other, henderson, hendersonZip);
    await submitProject(db, u.other, hp);
    const bp = await mk("Buncombe project in queue");
    await submitProject(db, u.admin, bp);
    const ids = async (who: string) => (await listProjectsForReview(db, who)).map((p) => p.id);
    expect(await ids(u.caB)).toContain(bp);
    expect(await ids(u.caB)).not.toContain(hp);
    expect(await ids(u.caH)).toContain(hp);
    expect(await ids(u.caH)).not.toContain(bp);
    expect(await ids(exec)).toEqual(expect.arrayContaining([bp, hp]));
    const queue = await listProjectsForReview(db, exec);
    expect(queue.every((p) => p.status === "PENDING_REVIEW")).toBe(true);
    expect(queue.find((p) => p.id === bp)!.needs).toHaveLength(1);
    await expect(listProjectsForReview(db, u.admin)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("pauses, resumes, completes and cancels without going back to review", async () => {
    const id = await mk("Project for status moves");
    await submitProject(db, u.admin, id);
    await approve(exec, id);
    for (const to of ["PAUSED", "OPEN", "PAUSED", "COMPLETED"] as const) {
      await setProjectStatus(db, u.editor, id, to);
      expect((await get(id)).status).toBe(to);
    }
    await expect(setProjectStatus(db, u.editor, id, "OPEN")).rejects.toMatchObject({ code: "VALIDATION" });
    const d = await mk("Draft cannot jump to open");
    await expect(setProjectStatus(db, u.admin, d, "OPEN")).rejects.toMatchObject({ code: "VALIDATION" });
    await setProjectStatus(db, u.admin, d, "CANCELLED");
    expect((await get(d)).status).toBe("CANCELLED");
    await expect(setProjectStatus(db, u.viewer, d, "CANCELLED")).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await audited(id, "PROJECT_STATUS_CHANGED")).toBe(4);
  });
});

describe("public projects", () => {
  const SECRET_NOTE = "Meet at the gravel lot behind the church";
  const SECRET_INSTRUCTIONS = "SECRET-INSTRUCTIONS-park-on-elm";
  const SECRET_REVIEW = "SECRET-REVIEW-NOTE-remove-address";
  const pub = async (raw: Record<string, unknown> = {}) =>
    (await searchProjects(db, raw)).projects.filter((p) => p.title.startsWith("Public Case"));
  const titles = async (raw: Record<string, unknown> = {}) => (await pub(raw)).map((p) => p.title).sort();
  const draft = async (title: string, o: { zip?: string; county?: string; org?: string; by?: string; needTitle?: string } = {}) => {
    const by = o.by ?? u.admin;
    const id = await createProject(db, by, o.org ?? orgA, base({ title, zip: o.zip ?? "28801", countyId: o.county ?? buncombe }));
    await addNeed(db, by, id, { title: o.needTitle ?? "Volunteer crew", slotsNeeded: 4, urgency: "NORMAL", instructions: SECRET_INSTRUCTIONS });
    return id;
  };
  const open = async (title: string, o: Parameters<typeof draft>[1] = {}) => {
    const id = await draft(title, o);
    await submitProject(db, o.by ?? u.admin, id);
    await reviewProject(db, exec, id, { decision: "APPROVE", note: "Approved for the public" });
    return id;
  };

  it("shows only OPEN projects of approved orgs, with needs and no private fields", async () => {
    const pending = await draft("Public Case pending");
    await submitProject(db, u.admin, pending);
    await draft("Public Case draft only");
    const paused = await open("Public Case paused");
    await setProjectStatus(db, u.admin, paused, "PAUSED");
    const done = await open("Public Case completed");
    await setProjectStatus(db, u.admin, done, "COMPLETED");
    const returned = await draft("Public Case with review note");
    await submitProject(db, u.admin, returned);
    await reviewProject(db, exec, returned, { decision: "RETURN", note: SECRET_REVIEW });
    await submitProject(db, u.admin, returned);
    await reviewProject(db, exec, returned, { decision: "APPROVE", note: "Fixed, approved" });
    const live = await open("Public Case live");

    expect(await titles()).toEqual(["Public Case live", "Public Case with review note"]);
    for (const hidden of [pending, paused, done]) expect(await getPublicProject(db, hidden)).toBeNull();
    const detail = (await getPublicProject(db, live))!;
    expect(detail).toMatchObject({ title: "Public Case live", countyName: "Buncombe", state: "NC", zip: "28801", totalSlots: 4 });
    expect(detail.needs).toMatchObject([{ title: "Volunteer crew", slotsNeeded: 4, urgency: "NORMAL" }]);

    const everything = JSON.stringify([await searchProjects(db, {}), detail, await getPublicProject(db, returned)]);
    for (const secret of [SECRET_NOTE, SECRET_INSTRUCTIONS, SECRET_REVIEW]) expect(everything).not.toContain(secret);
    const cols = await sys((tx) =>
      tx.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name IN ('public_projects','public_project_needs')`),
    );
    const names = cols.map((c) => c.column_name);
    expect(names.length).toBeGreaterThan(5);
    for (const banned of ["private_location_notes", "review_note", "instructions", "created_by", "reviewed_by"]) expect(names).not.toContain(banned);
    expect(await getPublicProject(db, "not-a-uuid")).toBeNull();
  });

  it("hides a project the moment its org is suspended", async () => {
    const id = await open("Public Case suspension check");
    expect(await titles()).toContain("Public Case suspension check");
    await sys((tx) => tx.query(`UPDATE organizations SET publication_suspended = true WHERE id = $1`, [orgA]));
    expect(await titles()).not.toContain("Public Case suspension check");
    expect(await getPublicProject(db, id)).toBeNull();
    await sys((tx) => tx.query(`UPDATE organizations SET publication_suspended = false WHERE id = $1`, [orgA]));
    expect(await titles()).toContain("Public Case suspension check");
  });

  it("hides an approved project again after its content changes", async () => {
    const id = await open("Public Case edited after approval");
    expect(await titles()).toContain("Public Case edited after approval");
    await updateProject(db, u.admin, id, base({ title: "Public Case edited after approval", description: "A materially different description now." }));
    expect(await titles()).not.toContain("Public Case edited after approval");
    expect(await getPublicProject(db, id)).toBeNull();
    await reviewProject(db, exec, id, { decision: "APPROVE", note: "Re-approved after edit" });
    expect(await titles()).toContain("Public Case edited after approval");
  });

  it("searches by text across title, description and need titles", async () => {
    await open("Public Case quiet title", { needTitle: "Zebrafish rescue shift" });
    expect(await titles({ q: "zebrafish" })).toEqual(["Public Case quiet title"]);
    expect(await titles({ q: "flood damage" })).toContain("Public Case quiet title");
    expect(await titles({ q: "nothingmatchesthis" })).toEqual([]);
  });

  it("sorts by distance for a ZIP and honors the radius", async () => {
    await sys((tx) =>
      tx.query(
        `INSERT INTO zip_codes (zip, location) VALUES ('28801', ST_GeogFromText('POINT(-82.55 35.59)')), ('28806', ST_GeogFromText('POINT(-82.85 35.59)'))
         ON CONFLICT (zip) DO NOTHING`,
      ),
    );
    await open("Public Case near", { zip: "28801" });
    await open("Public Case farther", { zip: "28806" });
    const near5 = await pub({ zip: "28801", radius: 5 });
    expect(near5.map((p) => p.title)).toContain("Public Case near");
    expect(near5.map((p) => p.title)).not.toContain("Public Case farther");
    const near25 = await pub({ zip: "28801", radius: 25 });
    const order = near25.map((p) => p.title).filter((t) => ["Public Case near", "Public Case farther"].includes(t));
    expect(order).toEqual(["Public Case near", "Public Case farther"]);
    expect(near25.find((p) => p.title === "Public Case near")!.distanceMiles).toBe(0);
    expect(near25.find((p) => p.title === "Public Case farther")!.distanceMiles).toBeGreaterThan(10);
  });

  it("filters by county", async () => {
    const hOrg = await makeOrg(db, { name: "Henderson Public Org", members: [{ userId: u.other, role: "EDITOR" }] });
    await sys((tx) => tx.query(`INSERT INTO organization_counties (org_id, county_id) VALUES ($1, $2)`, [hOrg, henderson]));
    await open("Public Case in Henderson", { org: hOrg, by: u.other, county: henderson, zip: hendersonZip });
    expect(await titles({ countyId: henderson })).toEqual(["Public Case in Henderson"]);
    expect(await titles({ countyId: buncombe })).not.toContain("Public Case in Henderson");
  });

  it("rejects a malformed ZIP, radius or county id", async () => {
    await expect(searchProjects(db, { zip: "abc" })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(searchProjects(db, { zip: "28801", radius: 7 })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(searchProjects(db, { countyId: "nope" })).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

describe("shift times are entered and shown in Eastern Time", () => {
  it("converts a local Eastern time to UTC across daylight saving", () => {
    expect(eastern).toBe("America/New_York");
    expect(easternLocalToIso("2026-12-06T08:00")).toBe("2026-12-06T13:00:00.000Z");
    expect(easternLocalToIso("2026-07-04T08:00")).toBe("2026-07-04T12:00:00.000Z");
  });

  it("round-trips back to the local value, and leaves empty or invalid input alone", () => {
    for (const local of ["2026-12-06T08:00", "2026-07-04T23:30", "2026-03-08T12:15", "2026-11-01T09:45"]) {
      expect(isoToEasternLocal(easternLocalToIso(local))).toBe(local);
    }
    expect(easternLocalToIso("")).toBe("");
    expect(easternLocalToIso("not a date")).toBe("not a date");
    expect(isoToEasternLocal(null)).toBe("");
  });
});
