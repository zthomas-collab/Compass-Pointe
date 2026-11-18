import { z } from "zod";
import type { Driver } from "../db";
import { runIn } from "../db/context";
import { publicNeeds, publicProjectColumns, toPublicProject, type DbPublicProject, type PublicProject } from "./projects";

/**
 * What a public organization profile shows besides its own details: its locations on the public map, its open
 * volunteer projects, and the open events those projects are confirmed on. Anonymous reads through public views only,
 * so nothing private (sites, drafts, suggestions, dismissed links, closed events) can appear. An organization without a
 * public profile gets empty lists.
 *
 * Its own module because projects.ts imports directory.ts (where the profile itself is read).
 */
export type OrganizationActivity = {
  sites: { id: string; name: string; city: string | null; state: string | null }[];
  projects: PublicProject[];
  events: { name: string; slug: string; status: "ACTIVE" | "RECOVERY" }[];
};

const EMPTY: OrganizationActivity = { sites: [], projects: [], events: [] };

export async function getPublicOrganizationActivity(driver: Driver, orgId: string): Promise<OrganizationActivity> {
  const id = z.string().uuid().safeParse(orgId);
  if (!id.success) return { ...EMPTY };
  return runIn(driver, { kind: "anon" }, async (tx) => {
    const visible = await tx.query(`SELECT 1 FROM public_contacts WHERE id = $1`, [id.data]);
    if (!visible.length) return { ...EMPTY };
    const sites = await tx.query<{ id: string; name: string; city: string | null; state: string | null }>(
      `SELECT id, name, city, state FROM public_sites WHERE org_id = $1 ORDER BY name, id LIMIT 100`, [id.data]);
    const projectRows = await tx.query<DbPublicProject>(
      `SELECT ${publicProjectColumns("p")}
         FROM public_projects p WHERE p.org_id = $1
        ORDER BY p.has_urgent DESC, p.title, p.id LIMIT 100`,
      [id.data],
    );
    const needs = await publicNeeds(tx, projectRows.map((r) => r.id));
    const events = await tx.query<{ name: string; slug: string; status: "ACTIVE" | "RECOVERY" }>(
      `SELECT DISTINCT e.name, e.slug, e.status, e.starts_on
         FROM public_event_links l
         JOIN public_events e ON e.id = l.event_id
         JOIN public_projects p ON p.id = l.project_id
        WHERE p.org_id = $1 AND e.status IN ('ACTIVE','RECOVERY')
        ORDER BY e.starts_on DESC, e.name`,
      [id.data],
    );
    return {
      sites,
      projects: projectRows.map((r) => toPublicProject(r, needs.get(r.id) ?? [])),
      events: events.map((e) => ({ name: e.name, slug: e.slug, status: e.status })),
    };
  });
}
