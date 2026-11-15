import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver, Tx } from "@/server/db";
import { runIn } from "@/server/db/context";
import { assignCountyAdmin, createCounty } from "@/server/modules/counties";
import { createProject, getProjectForEditor, listOrgProjects, updateProject } from "@/server/modules/projects";
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
