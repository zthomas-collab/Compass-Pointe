import type { Driver } from "./db";
import { runIn } from "./db/context";

/**
 * The guarded "wipe all data" operation behind `npm run db:reset`.
 *
 * There is deliberately NO hidden trigger and NO secret password: a destructive wipe should never be reachable by
 * signing in or by typing a magic string. It is an explicit operator command that (1) refuses anything that looks like
 * production, (2) makes a JSON backup of every table first, and (3) requires the operator to type the target's name.
 * It clears the data people created but keeps the schema and the static reference tables, so the app still runs after.
 */

/** Tables kept on a wipe: migration bookkeeping and shipped reference data (ZIP→county), never user-created rows. */
export const PRESERVED_TABLES = ["schema_migrations", "zip_county"] as const;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);
// A database name that explicitly marks a non-production environment.
const NON_PROD_MARKER = /(^|[_-])(dev|test|staging|stage|sandbox|qa|preview|local|demo|ci|scratch)([_-]|$)/i;

export type ResetTarget = {
  kind: "pglite" | "postgres";
  /** Human-readable description of what would be wiped. */
  label: string;
  /** The phrase the operator must type to confirm (the database name, or "pglite"). */
  confirmToken: string;
  /** True when the target cannot be shown to be non-production; such a target is never resettable. */
  productionLike: boolean;
};

type Env = Record<string, string | undefined>;

/** Work out what `createDriver` would connect to, from the same environment variables, without connecting. */
export function resolveResetTarget(env: Env = process.env): ResetTarget {
  const url = env.DATABASE_URL;
  if (url) {
    let host = "";
    let dbName = "";
    try {
      const u = new URL(url);
      host = u.hostname;
      dbName = decodeURIComponent(u.pathname.replace(/^\//, ""));
    } catch {
      // An unparseable URL is treated as production-like: we cannot prove it is safe.
    }
    const local = LOCAL_HOSTS.has(host);
    const marked = NON_PROD_MARKER.test(dbName);
    return {
      kind: "postgres",
      label: `PostgreSQL "${dbName || "(default)"}" on ${host || "(unknown host)"}`,
      confirmToken: dbName || host || "database",
      productionLike: !local && !marked,
    };
  }
  const dir = env.PGLITE_DATA_DIR ?? "./.data/pglite";
  return { kind: "pglite", label: `local PGlite (${dir})`, confirmToken: "pglite", productionLike: false };
}

/**
 * Why this target must not be wiped, or null when it may be. Production is blocked outright: there is no override flag,
 * because a destructive reset of real coordination data should never be one typo or leaked variable away.
 */
export function resetBlockedReason(target: ResetTarget, env: Env = process.env): string | null {
  if (env.NODE_ENV === "production") return "NODE_ENV is production — refusing to wipe any database.";
  if (target.productionLike) {
    return `${target.label} is not marked as a development, test or staging database, so it is treated as production and cannot be reset.`;
  }
  return null;
}

/** Every base table in the public schema, in a stable order. */
async function publicTables(db: Driver): Promise<string[]> {
  const rows = await runIn(db, { kind: "system" }, (tx) =>
    tx.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`),
  );
  return rows.map((r) => r.tablename);
}

/**
 * Read every row of every public table (including the preserved ones), as a full logical backup that can be restored
 * even though the reset only truncates. JSON, so it needs no external tool and works on PGlite and PostgreSQL alike.
 */
export async function dumpAllData(db: Driver): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const table of await publicTables(db)) {
    out[table] = await runIn(db, { kind: "system" }, (tx) => tx.query(`SELECT * FROM "${table}"`));
  }
  return out;
}

/** Clear all user-created data: truncate every public table except the preserved reference/bookkeeping tables. */
export async function wipeData(db: Driver): Promise<{ tablesCleared: number; preserved: string[] }> {
  const preserved = new Set<string>(PRESERVED_TABLES);
  const toClear = (await publicTables(db)).filter((t) => !preserved.has(t));
  if (toClear.length > 0) {
    const list = toClear.map((t) => `"${t}"`).join(", ");
    await runIn(db, { kind: "system" }, (tx) => tx.query(`TRUNCATE ${list} RESTART IDENTITY CASCADE`));
  }
  return { tablesCleared: toClear.length, preserved: [...preserved] };
}
