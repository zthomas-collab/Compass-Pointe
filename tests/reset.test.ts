import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver, Tx } from "@/server/db";
import { runIn } from "@/server/db/context";
import { PRESERVED_TABLES, resetBlockedReason, resolveResetTarget, wipeData } from "@/server/reset";
import { freshDb } from "./helpers/db";
import { createCounty } from "@/server/modules/counties";
import { makeUser } from "./helpers/fixtures";

/** The guarded data reset: it refuses anything production-like, and wipes user data while keeping schema + reference data. */

describe("reset target classification", () => {
  it("treats a localhost database as safe to reset", () => {
    const t = resolveResetTarget({ DATABASE_URL: "postgres://u:p@localhost:5432/ics_las" });
    expect(t).toMatchObject({ kind: "postgres", productionLike: false, confirmToken: "ics_las" });
    expect(resetBlockedReason(t, { DATABASE_URL: "postgres://u:p@localhost:5432/ics_las" })).toBeNull();
  });

  it("treats a remote database with a staging/dev/test marker as safe", () => {
    for (const name of ["ics_las_staging", "ics-dev", "icslas_qa", "sandbox_db", "ics_preview"]) {
      const env = { DATABASE_URL: `postgres://u:p@db.example.com:5432/${name}` };
      expect(resolveResetTarget(env).productionLike, name).toBe(false);
      expect(resetBlockedReason(resolveResetTarget(env), env), name).toBeNull();
    }
  });

  it("refuses a remote database with no non-production marker", () => {
    const env = { DATABASE_URL: "postgres://u:p@db.prod.example.com:5432/ics_las" };
    const t = resolveResetTarget(env);
    expect(t.productionLike).toBe(true);
    expect(resetBlockedReason(t, env)).toMatch(/production/i);
  });

  it("refuses when NODE_ENV is production, even against local PGlite", () => {
    const env = { NODE_ENV: "production" };
    const t = resolveResetTarget(env);
    expect(t.kind).toBe("pglite");
    expect(resetBlockedReason(t, env)).toMatch(/production/i);
  });

  it("classifies local PGlite with a pglite confirm token", () => {
    const t = resolveResetTarget({});
    expect(t).toMatchObject({ kind: "pglite", productionLike: false, confirmToken: "pglite" });
    expect(resetBlockedReason(t, {})).toBeNull();
  });
});

describe("wipeData", () => {
  let db: Driver;
  const sys = <T>(fn: (tx: Tx) => Promise<T>) => runIn(db, { kind: "system" }, fn);
  const count = (table: string) => sys((tx) => tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).then((r) => r[0].n);

  beforeAll(async () => {
    db = await freshDb();
    await makeUser(db, "reset-victim@example.test");
    await createCounty(db, await makeUser(db, "reset-exec@example.test").then(async (id) => {
      await runIn(db, { kind: "system" }, (tx) => tx.query(
        `INSERT INTO role_assignments (user_id, role, reason) VALUES ($1, 'PLATFORM_ADMIN', 'test')`, [id]));
      return id;
    }), { name: "Wipe County", state: "NC", fips: "37021" });
  });
  afterAll(async () => db?.close());

  it("clears user data but keeps the schema and the preserved reference tables", async () => {
    expect(await count("users")).toBeGreaterThan(0);
    const zipsBefore = await count("zip_county");
    const migrationsBefore = await count("schema_migrations");
    expect(zipsBefore).toBeGreaterThan(0);

    const result = await wipeData(db);
    expect(result.tablesCleared).toBeGreaterThan(0);

    expect(await count("users")).toBe(0);
    expect(await count("counties")).toBe(0);
    expect(await count("role_assignments")).toBe(0);
    // Reference and bookkeeping tables survive, so the app still runs after a wipe.
    expect(await count("zip_county")).toBe(zipsBefore);
    expect(await count("schema_migrations")).toBe(migrationsBefore);
    expect(PRESERVED_TABLES).toEqual(expect.arrayContaining(["schema_migrations", "zip_county"]));
  });
});
