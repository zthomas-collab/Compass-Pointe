import { z } from "zod";
import type { Driver, Tx } from "../db";
import { runIn } from "../db/context";
import { AppError } from "../errors";
import { loadAccess } from "./access";
import { parseOrThrow } from "./identity";
import { OFFER_TYPES } from "./offers";
import { privilegedMfaRequired } from "./organizations";

/**
 * Role dashboards. Every number is counted from live database records at request time (no stored or hard-coded
 * figures) and only for what the caller may see: executives platform-wide, county administrators their counties, and
 * organization members their own organization. Application counts are aggregates only; no applicant details appear here.
 */
const uuid = z.string().uuid();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const dashboardFilterSchema = z.object({
  countyId: uuid.optional().or(z.literal("").transform(() => undefined)),
  category: z.enum(OFFER_TYPES).optional().or(z.literal("").transform(() => undefined)),
  from: day.optional().or(z.literal("").transform(() => undefined)),
  to: day.optional().or(z.literal("").transform(() => undefined)),
});
export type DashboardFilter = z.infer<typeof dashboardFilterSchema>;

export type Range = { from: string; to: string };
export type ExecutiveDashboard = {
  scope: "EXECUTIVE" | "COUNTY";
  range: Range;
  counties: { id: string; name: string; state: string }[];
  metrics: {
    activeEvents: number; activeCounties: number; approvedNonprofits: number; newRequests: number; pendingApplications: number;
    openNeeds: number; outstandingDonations: number; availableVolunteers: number; activeDeliveries: number; completedProjects: number;
    awaitingVerification: number; upcomingEvents: number; resourceListings: number; availableResourceListings: number;
  };
  applicationsByStatus: { status: string; count: number }[];
  shortfalls: { projectId: string; projectTitle: string; need: string; unit: string; requested: number; verified: number }[];
  upcoming: { id: string; name: string; startDate: string; countyName: string }[];
};

async function scopeFor(tx: Tx, userId: string): Promise<{ executive: boolean; countyIds: string[]; orgIds: string[] }> {
  const a = await loadAccess(tx, userId);
  if ((a.executive || a.countyIds.length) && privilegedMfaRequired()) {
    const r = await tx.query<{ mfa: boolean }>(`SELECT mfa_enrolled_at IS NOT NULL AS mfa FROM users WHERE id = $1`, [userId]);
    if (!r[0]?.mfa) throw new AppError("FORBIDDEN", "Multi-factor authentication is required.");
  }
  return { executive: a.executive, countyIds: a.countyIds, orgIds: a.orgIds };
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
function rangeOf(f: DashboardFilter): Range {
  const to = f.to ?? iso(new Date());
  const from = f.from ?? iso(new Date(Date.now() - 30 * 86400_000));
  if (from > to) throw new AppError("VALIDATION", "The start date is after the end date.", { from: ["Must be on or before the end date"] });
  return { from, to };
}
const n = (v: unknown) => Number(v ?? 0);

/** Executive (all counties) or county administrator (assigned counties) dashboard. */
export async function getDashboard(driver: Driver, userId: string, raw: unknown = {}): Promise<ExecutiveDashboard> {
  const f = parseOrThrow(dashboardFilterSchema, raw);
  const range = rangeOf(f);
  return runIn(driver, { kind: "system" }, async (tx) => {
    const s = await scopeFor(tx, userId);
    if (!s.executive && s.countyIds.length === 0) throw new AppError("FORBIDDEN", "You do not have access to this dashboard.");
    const counties = await tx.query<{ id: string; name: string; state: string }>(
      s.executive ? `SELECT id, name, state FROM counties WHERE active ORDER BY state, name`
                  : `SELECT id, name, state FROM counties WHERE active AND id = ANY($1::uuid[]) ORDER BY state, name`,
      s.executive ? [] : [s.countyIds]);
    let ids = counties.map((c) => c.id);
    if (f.countyId) {
      if (!ids.includes(f.countyId)) throw new AppError("NOT_FOUND", "County not found.");
      ids = [f.countyId];
    }
    const cat = f.category ?? null;
    // Offers whose county is not yet known are visible to executives only (matches the database policy).
    const offerScope = `(o.county_id = ANY($1::uuid[]) ${s.executive && !f.countyId ? "OR o.county_id IS NULL" : ""})`;
    const q = async (sql: string, params: unknown[] = []) => (await tx.query<Record<string, unknown>>(sql, [ids, ...params]))[0];

    const [events, activeCounties, nonprofits, newReq, pending, needs, donations, volunteers, deliveries, completed, verifying, upcoming, listings] = await Promise.all([
      q(`SELECT count(*)::int AS v FROM events WHERE status = 'ACTIVE' AND county_id = ANY($1::uuid[])`),
      q(`SELECT count(*)::int AS v FROM (
           SELECT county_id FROM events WHERE status = 'ACTIVE' AND county_id = ANY($1::uuid[])
           UNION SELECT county_id FROM community_projects WHERE status = 'ACTIVE' AND county_id = ANY($1::uuid[])
           UNION SELECT county_id FROM assistance_applications WHERE status NOT IN ('COMPLETED','CLOSED') AND county_id = ANY($1::uuid[])) x`),
      s.executive && !f.countyId
        ? tx.query<Record<string, unknown>>(`SELECT count(*)::int AS v FROM organizations WHERE status = 'APPROVED' AND NOT publication_suspended`).then((r) => r[0])
        : q(`SELECT count(DISTINCT oc.org_id)::int AS v FROM organization_counties oc JOIN organizations o ON o.id = oc.org_id
              WHERE oc.county_id = ANY($1::uuid[]) AND o.status = 'APPROVED' AND NOT o.publication_suspended`),
      q(`SELECT count(*)::int AS v FROM assistance_applications WHERE county_id = ANY($1::uuid[]) AND created_at::date BETWEEN $2::date AND $3::date
            AND ($4::text IS NULL OR category_code = $4)`, [range.from, range.to, null]),
      q(`SELECT count(*)::int AS v FROM assistance_applications WHERE county_id = ANY($1::uuid[]) AND status IN ('SUBMITTED','UNDER_REVIEW','INFO_REQUIRED')`),
      q(`SELECT count(*)::int AS v FROM project_needs n JOIN community_projects p ON p.id = n.project_id
          WHERE p.status = 'ACTIVE' AND p.county_id = ANY($1::uuid[]) AND ($2::text IS NULL OR n.contribution_type = $2)
            AND coalesce((SELECT sum(k.qty_verified) FROM project_commitments k WHERE k.need_id = n.id AND k.status NOT IN ('DECLINED','CANCELED')), 0) < n.quantity_requested`, [cat]),
      q(`SELECT count(*)::int AS v FROM contribution_offers o WHERE ${offerScope} AND o.status IN ('SUBMITTED','REVIEWED','MATCHED','ACCEPTED','SCHEDULED')
            AND o.contribution_type NOT IN ('VOLUNTEER_LABOR','PROFESSIONAL_SKILLS') AND ($2::text IS NULL OR o.contribution_type = $2)`, [cat]),
      q(`SELECT count(*)::int AS v FROM contribution_offers o WHERE ${offerScope} AND o.status IN ('SUBMITTED','REVIEWED','MATCHED','ACCEPTED','SCHEDULED')
            AND o.contribution_type IN ('VOLUNTEER_LABOR','PROFESSIONAL_SKILLS') AND ($2::text IS NULL OR o.contribution_type = $2)`, [cat]),
      q(`SELECT count(*)::int AS v FROM project_commitments k JOIN community_projects p ON p.id = k.project_id
          WHERE p.county_id = ANY($1::uuid[]) AND k.status IN ('DISPATCHED','RECEIVED') AND ($2::text IS NULL OR p.category = $2)`, [cat]),
      q(`SELECT count(*)::int AS v FROM community_projects WHERE status = 'COMPLETED' AND county_id = ANY($1::uuid[]) AND ($2::text IS NULL OR category = $2)`, [cat]),
      q(`SELECT count(*)::int AS v FROM project_commitments k JOIN community_projects p ON p.id = k.project_id
          WHERE p.county_id = ANY($1::uuid[]) AND k.status = 'RECEIVED'`),
      q(`SELECT count(*)::int AS v FROM events WHERE status = 'SCHEDULED' AND county_id = ANY($1::uuid[]) AND start_date BETWEEN current_date AND current_date + 30`),
      q(`SELECT count(*)::int AS total, count(*) FILTER (WHERE a.availability_status = 'AVAILABLE')::int AS available
           FROM resources r JOIN staging_sites s ON s.id = r.site_id JOIN counties c ON lower(c.name) = lower(s.county) AND c.state = s.state
           LEFT JOIN resource_availability a ON a.resource_id = r.id
          WHERE r.status = 'ACTIVE' AND s.status = 'ACTIVE' AND c.id = ANY($1::uuid[])`),
    ]);
    const apps = await tx.query<{ status: string; count: number }>(
      `SELECT status, count(*)::int AS count FROM assistance_applications WHERE county_id = ANY($1::uuid[]) GROUP BY status ORDER BY count DESC`, [ids]);
    const shortfalls = await tx.query<Record<string, unknown>>(
      `SELECT p.id AS pid, p.title, n.label, n.unit, n.quantity_requested,
              coalesce((SELECT sum(k.qty_verified) FROM project_commitments k WHERE k.need_id = n.id AND k.status NOT IN ('DECLINED','CANCELED')), 0) AS verified
         FROM project_needs n JOIN community_projects p ON p.id = n.project_id
        WHERE p.status = 'ACTIVE' AND p.county_id = ANY($1::uuid[]) AND ($2::text IS NULL OR n.contribution_type = $2)
        ORDER BY array_position(ARRAY['CRITICAL','HIGH','NORMAL','LOW'], p.priority), (n.quantity_requested - coalesce((SELECT sum(k.qty_verified) FROM project_commitments k WHERE k.need_id = n.id AND k.status NOT IN ('DECLINED','CANCELED')), 0)) DESC LIMIT 8`, [ids, cat]);
    const up = await tx.query<Record<string, unknown>>(
      `SELECT e.id, e.name, e.start_date::text AS start_date, c.name AS county_name FROM events e JOIN counties c ON c.id = e.county_id
        WHERE e.status IN ('SCHEDULED','ACTIVE') AND e.county_id = ANY($1::uuid[]) AND coalesce(e.end_date, e.start_date) >= current_date ORDER BY e.start_date LIMIT 5`, [ids]);
    return {
      scope: s.executive ? "EXECUTIVE" : "COUNTY",
      range, counties,
      metrics: {
        activeEvents: n(events.v), activeCounties: n(activeCounties.v), approvedNonprofits: n(nonprofits.v), newRequests: n(newReq.v), pendingApplications: n(pending.v),
        openNeeds: n(needs.v), outstandingDonations: n(donations.v), availableVolunteers: n(volunteers.v), activeDeliveries: n(deliveries.v), completedProjects: n(completed.v),
        awaitingVerification: n(verifying.v), upcomingEvents: n(upcoming.v), resourceListings: n(listings.total), availableResourceListings: n(listings.available),
      },
      applicationsByStatus: apps,
      shortfalls: shortfalls.filter((r) => n(r.verified) < n(r.quantity_requested)).map((r) => ({ projectId: r.pid as string, projectTitle: r.title as string, need: r.label as string, unit: r.unit as string, requested: n(r.quantity_requested), verified: n(r.verified) })),
      upcoming: up.map((e) => ({ id: e.id as string, name: e.name as string, startDate: e.start_date as string, countyName: e.county_name as string })),
    } satisfies ExecutiveDashboard;
  });
}

export type OrgDashboard = {
  orgId: string; orgName: string; range: Range; orgs: { id: string; name: string }[];
  metrics: { listings: number; availableListings: number; assignedRequests: number; pendingCommitments: number; activeProjects: number; scheduledDeliveries: number; completedCommitments: number; verifiedQuantity: number; completedReferrals: number };
  scheduled: { commitmentId: string; projectTitle: string; need: string; quantity: number; scheduledFor: string; status: string }[];
};

/** Nonprofit dashboard for one of the caller's organizations (the first, unless orgId is given). */
export async function getOrgDashboard(driver: Driver, userId: string, raw: unknown = {}, orgIdRaw?: unknown): Promise<OrgDashboard> {
  const f = parseOrThrow(dashboardFilterSchema, raw);
  const range = rangeOf(f);
  const wanted = orgIdRaw ? parseOrThrow(uuid, orgIdRaw) : null;
  return runIn(driver, { kind: "system" }, async (tx) => {
    const s = await scopeFor(tx, userId);
    if (s.orgIds.length === 0) throw new AppError("FORBIDDEN", "You do not have access to an organization dashboard.");
    const orgId = wanted ?? s.orgIds[0];
    if (!s.orgIds.includes(orgId)) throw new AppError("NOT_FOUND", "Organization not found.");
    const orgs = await tx.query<{ id: string; name: string }>(`SELECT id, display_name AS name FROM organizations WHERE id = ANY($1::uuid[]) ORDER BY display_name`, [s.orgIds]);
    const q = async (sql: string, params: unknown[] = []) => (await tx.query<Record<string, unknown>>(sql, [orgId, ...params]))[0];
    const [lst, req, pend, proj, sched, done, refs] = await Promise.all([
      q(`SELECT count(*)::int AS total, count(*) FILTER (WHERE a.availability_status = 'AVAILABLE')::int AS available
           FROM resources r JOIN staging_sites s ON s.id = r.site_id LEFT JOIN resource_availability a ON a.resource_id = r.id
          WHERE r.org_id = $1 AND r.status = 'ACTIVE' AND s.status = 'ACTIVE' AND ($2::text IS NULL OR r.category_code = $2)`, [null]),
      q(`SELECT count(*)::int AS v FROM assistance_applications WHERE referred_org_id = $1 AND status IN ('REFERRED','IN_PROGRESS') AND consent_share_providers`),
      q(`SELECT count(*)::int AS v FROM project_commitments WHERE org_id = $1 AND status = 'PROPOSED'`),
      q(`SELECT count(*)::int AS v FROM project_organizations po JOIN community_projects p ON p.id = po.project_id WHERE po.org_id = $1 AND p.status = 'ACTIVE'`),
      q(`SELECT count(*)::int AS v FROM project_commitments WHERE org_id = $1 AND status IN ('ACCEPTED','DISPATCHED') AND scheduled_for >= current_date`),
      q(`SELECT count(*)::int AS v, coalesce(sum(qty_verified), 0) AS qty FROM project_commitments WHERE org_id = $1 AND status = 'VERIFIED' AND updated_at::date BETWEEN $2::date AND $3::date`, [range.from, range.to]),
      q(`SELECT count(*)::int AS v FROM assistance_applications WHERE referred_org_id = $1 AND status = 'COMPLETED' AND status_changed_at::date BETWEEN $2::date AND $3::date`, [range.from, range.to]),
    ]);
    const sch = await tx.query<Record<string, unknown>>(
      `SELECT k.id, p.title, nd.label, k.qty_accepted, k.scheduled_for::text AS scheduled_for, k.status
         FROM project_commitments k JOIN community_projects p ON p.id = k.project_id JOIN project_needs nd ON nd.id = k.need_id
        WHERE k.org_id = $1 AND k.status IN ('ACCEPTED','DISPATCHED') AND k.scheduled_for >= current_date ORDER BY k.scheduled_for LIMIT 10`, [orgId]);
    return {
      orgId, orgName: orgs.find((o) => o.id === orgId)?.name ?? "", range, orgs,
      metrics: {
        listings: n(lst.total), availableListings: n(lst.available), assignedRequests: n(req.v), pendingCommitments: n(pend.v), activeProjects: n(proj.v),
        scheduledDeliveries: n(sched.v), completedCommitments: n(done.v), verifiedQuantity: n(done.qty), completedReferrals: n(refs.v),
      },
      scheduled: sch.map((r) => ({ commitmentId: r.id as string, projectTitle: r.title as string, need: r.label as string, quantity: n(r.qty_accepted), scheduledFor: r.scheduled_for as string, status: r.status as string })),
    };
  });
}
