import type { Driver } from "@/server/db";
import { runIn } from "@/server/db/context";
import { createProject, updateProject } from "@/server/modules/projects";

/** Test fixtures. All names are prefixed [TEST] — synthetic data only. */

export async function makeUser(db: Driver, email: string): Promise<string> {
  const rows = await runIn(db, { kind: "system" }, (tx) =>
    tx.query<{ id: string }>(
      `INSERT INTO users (email, display_name, email_verified_at, is_synthetic) VALUES ($1, $2, now(), true) RETURNING id`,
      [email, `[TEST] ${email}`],
    ),
  );
  return rows[0].id;
}

export async function makeOrg(
  db: Driver,
  opts: { name: string; status?: string; serviceType?: string; consent?: boolean; members?: { userId: string; role: "ORG_ADMIN" | "EDITOR" | "VIEWER"; status?: string }[] },
): Promise<string> {
  return runIn(db, { kind: "system" }, async (tx) => {
    const o = await tx.query<{ id: string }>(
      `INSERT INTO organizations (legal_name, display_name, org_type, status, contact_email, is_synthetic, approved_at,
                                  primary_service_type, public_phone, public_email, directory_consent_at, profile_status)
       VALUES ($1, $1, 'NONPROFIT', $2::org_status, 'private-contact@example.test', true,
               CASE WHEN $2 = 'APPROVED' THEN now() END,
               CASE WHEN $2 IN ('APPROVED','SUSPENDED') THEN $3 END, '(555) 010-0000', 'public@example.test',
               CASE WHEN $4 THEN now() END, CASE WHEN $2 IN ('APPROVED','SUSPENDED') THEN 'APPROVED' ELSE 'PENDING' END) RETURNING id`,
      [`[TEST] ${opts.name}`, opts.status ?? "APPROVED", opts.serviceType ?? "FOOD", opts.consent ?? false],
    );
    for (const m of opts.members ?? []) {
      await tx.query(
        `INSERT INTO organization_memberships (org_id, user_id, role, status) VALUES ($1, $2, $3::membership_role, $4::membership_status)`,
        [o[0].id, m.userId, m.role, m.status ?? "ACTIVE"],
      );
    }
    return o[0].id;
  });
}

export async function grantRole(
  db: Driver,
  userId: string,
  role: "PLATFORM_ADMIN" | "AUTHORIZED_RESPONDER",
  scopeWkt?: string,
  orgId?: string,
): Promise<void> {
  await runIn(db, { kind: "system" }, (tx) =>
    tx.query(
      `INSERT INTO role_assignments (user_id, role, scope_area, org_id, reason)
       VALUES ($1, $2::platform_role, CASE WHEN $3::text IS NULL THEN NULL ELSE ST_GeogFromText($3) END, $4, 'test')`,
      [userId, role, scopeWkt ?? null, orgId ?? null],
    ),
  );
}

export const site = (over: Partial<Record<string, unknown>> = {}) => ({
  name: "[TEST] Site",
  visibility: "PUBLIC",
  lat: 35.5951,
  lng: -82.5515,
  city: "Asheville",
  county: "Buncombe",
  state: "NC",
  postalCode: "28801",
  ...over,
});

export const ASHEVILLE_BBOX = { w: -83, s: 35, e: -82, n: 36 };

/** Square polygon around a point, as WKT MULTIPOLYGON. */
export function squareAround(lng: number, lat: number, d = 0.2): string {
  return `MULTIPOLYGON(((${lng - d} ${lat - d},${lng + d} ${lat - d},${lng + d} ${lat + d},${lng - d} ${lat + d},${lng - d} ${lat - d})))`;
}

/**
 * A public site at a ZIP, for a project to start at (migration 0019: a project's county and ZIP come from its site).
 * Inserted directly so permission tests on projects are not short-circuited by site permissions.
 */
export async function siteAt(db: Driver, createdBy: string, orgId: string, zip: string): Promise<string> {
  const rows = await runIn(db, { kind: "system" }, (tx) =>
    tx.query<{ id: string }>(
      `INSERT INTO staging_sites (org_id, name, visibility, location, city, state, postal_code, county_id,
                                  last_confirmed_at, is_synthetic, created_by, updated_by)
       VALUES ($1, $2, 'PUBLIC', ST_SetSRID(ST_MakePoint(-82.5515, 35.5951), 4326)::geography, 'Asheville', 'NC', $3,
               ics.county_for_zip($3), now(), true, $4, $4)
       RETURNING id`,
      [orgId, `[TEST] Project site ${zip}`, zip, createdBy],
    ),
  );
  return rows[0].id;
}

/** Turns an old-style project input ({ countyId, zip, ... }) into one placed at a site at that ZIP. */
export async function withSite(db: Driver, createdBy: string, orgId: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const rest = { ...input };
  const zip = rest.zip;
  delete rest.countyId;
  delete rest.zip;
  if (rest.siteId) return rest;
  return { ...rest, siteId: await siteAt(db, createdBy, orgId, String(zip)) };
}

/** createProject for tests written before projects had sites: places the project at a site for its { countyId, zip }. */
export async function createProjectAtZip(db: Driver, userId: string, orgId: string, input: Record<string, unknown>): Promise<string> {
  return createProject(db, userId, orgId, await withSite(db, userId, orgId, input));
}

/** updateProject counterpart of createProjectAtZip (the new site belongs to the project's own organization). */
export async function updateProjectAtZip(db: Driver, userId: string, projectId: string, input: Record<string, unknown>): Promise<void> {
  const org = await runIn(db, { kind: "system" }, (tx) =>
    tx.query<{ org_id: string }>(`SELECT org_id FROM projects WHERE id::text = $1`, [projectId]));
  const placed = org.length ? await withSite(db, userId, org[0].org_id, input) : { ...input, siteId: "00000000-0000-0000-0000-000000000000" };
  return updateProject(db, userId, projectId, placed);
}
