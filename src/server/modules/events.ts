import { z } from "zod";
import type { Driver, Tx } from "../db";
import { runIn } from "../db/context";
import { AppError, fromDbError } from "../errors";
import { assertExecutive } from "./access";
import { parseOrThrow } from "./identity";
import { writeAudit } from "./shared";

import { HAZARD_TYPES } from "@/lib/events";
import type { OfferType } from "@/lib/offers";
export { HAZARD_TYPES };
export type EventStatus = "DRAFT" | "ACTIVE" | "RECOVERY" | "CLOSED";

export type EventRow = {
  id: string;
  name: string;
  slug: string;
  hazardType: string;
  status: EventStatus;
  summary: string | null;
  startsOn: string;
  closedOn: string | null;
  counties: { id: string; name: string; state: string }[];
  zips: string[];
};

const RESERVED_SLUGS = new Set(["new"]);
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** "Hurricane X – Carteret" -> "hurricane-x-carteret". May return "" when the name has no letters or digits. */
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
}

const list = (v: unknown) => (typeof v === "string" ? v.split(/[\s,]+/).filter(Boolean) : v);

export const eventSchema = z.object({
  name: z.string().trim().min(3).max(120),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .optional()
    .or(z.literal("").transform(() => undefined)),
  hazardType: z.enum(HAZARD_TYPES),
  summary: z
    .string()
    .trim()
    .max(2000)
    .optional()
    .or(z.literal("").transform(() => undefined)),
  startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-09-10"),
  countyIds: z.preprocess(list, z.array(z.string().uuid()).min(1, "Choose at least one county")).transform((a) => [...new Set(a)]),
  zips: z
    .preprocess(list, z.array(z.string().regex(/^[0-9]{5}$/, "ZIP codes are 5 digits")).default([]))
    .transform((a) => [...new Set(a)]),
});
export type EventInput = z.infer<typeof eventSchema>;

function resolveSlug(input: EventInput, fallback?: string): string {
  const slug = input.slug ?? fallback ?? slugify(input.name);
  const fail = (msg: string) => new AppError("VALIDATION", "Please correct the highlighted fields.", { slug: [msg] });
  if (!slug) throw fail("Add a slug: the name has no letters or digits to build one from");
  if (slug.length < 3 || slug.length > 80 || !SLUG.test(slug)) throw fail("Use 3-80 lowercase letters, digits and hyphens");
  if (RESERVED_SLUGS.has(slug)) throw fail(`"${slug}" is reserved`);
  return slug;
}

async function assertKnownZips(tx: Tx, zips: string[]): Promise<void> {
  if (!zips.length) return;
  const known = await tx.query<{ zip: string }>(`SELECT DISTINCT zip FROM zip_county WHERE zip = ANY($1::text[])`, [zips]);
  const have = new Set(known.map((r) => r.zip));
  const unknown = zips.filter((z) => !have.has(z));
  if (unknown.length) {
    throw new AppError("VALIDATION", "Please correct the highlighted fields.", { zips: [`Unknown ZIP code: ${unknown.join(", ")}`] });
  }
}

type DbEvent = {
  id: string; name: string; slug: string; hazard_type: string; status: EventStatus; summary: string | null;
  starts_on: string; closed_on: string | null;
  counties: { id: string; name: string; state: string }[]; zips: string[];
};

export const toEventRow = (r: DbEvent): EventRow => ({
  id: r.id, name: r.name, slug: r.slug, hazardType: r.hazard_type, status: r.status, summary: r.summary,
  startsOn: r.starts_on, closedOn: r.closed_on, counties: r.counties, zips: r.zips,
});

/** Admin read: every event, drafts included. Caller must already have asserted the actor is an executive. */
export const ADMIN_EVENT_SELECT = `
  SELECT e.id, e.name, e.slug, e.hazard_type, e.status, e.summary, e.starts_on::text AS starts_on, e.closed_on::text AS closed_on,
         coalesce((SELECT json_agg(json_build_object('id', c.id, 'name', c.name, 'state', c.state) ORDER BY c.state, c.name)
                     FROM event_counties ec JOIN counties c ON c.id = ec.county_id WHERE ec.event_id = e.id), '[]'::json) AS counties,
         coalesce((SELECT array_agg(z.zip ORDER BY z.zip) FROM event_zips z WHERE z.event_id = e.id), '{}') AS zips
    FROM events e`;

/** Executive: create a DRAFT event. */
export async function createEvent(driver: Driver, actorId: string, raw: unknown): Promise<string> {
  const input = parseOrThrow(eventSchema, raw);
  const slug = resolveSlug(input);
  try {
    return await runIn(driver, { kind: "system" }, async (tx) => {
      await assertExecutive(tx, actorId);
      await assertKnownZips(tx, input.zips);
      const rows = await tx.query<{ id: string }>(
        `INSERT INTO events (name, slug, hazard_type, summary, starts_on, created_by)
         VALUES ($1, $2, $3, $4, $5::date, $6) RETURNING id`,
        [input.name, slug, input.hazardType, input.summary ?? null, input.startsOn, actorId],
      );
      const id = rows[0].id;
      for (const countyId of input.countyIds) {
        await tx.query(`INSERT INTO event_counties (event_id, county_id) VALUES ($1, $2)`, [id, countyId]);
      }
      for (const zip of input.zips) await tx.query(`INSERT INTO event_zips (event_id, zip) VALUES ($1, $2)`, [id, zip]);
      await writeAudit(tx, {
        actorUserId: actorId,
        action: "EVENT_CREATED",
        subjectType: "event",
        subjectId: id,
        details: { name: input.name, slug },
      });
      return id;
    });
  } catch (err) {
    throw fromDbError(err);
  }
}

export async function listEventsAdmin(driver: Driver, actorId: string): Promise<EventRow[]> {
  try {
    return await runIn(driver, { kind: "system" }, async (tx) => {
      await assertExecutive(tx, actorId);
      const rows = await tx.query<DbEvent>(`${ADMIN_EVENT_SELECT} ORDER BY e.starts_on DESC, e.name`);
      return rows.map(toEventRow);
    });
  } catch (err) {
    throw fromDbError(err);
  }
}

export async function getEventAdmin(driver: Driver, actorId: string, id: string): Promise<EventRow | null> {
  const eventId = parseOrThrow(z.string().uuid(), id);
  try {
    return await runIn(driver, { kind: "system" }, async (tx) => {
      await assertExecutive(tx, actorId);
      const rows = await tx.query<DbEvent>(`${ADMIN_EVENT_SELECT} WHERE e.id = $1`, [eventId]);
      return rows[0] ? toEventRow(rows[0]) : null;
    });
  } catch (err) {
    throw fromDbError(err);
  }
}

/** Lifecycle: a closed event is an archive and never reopens. */
export const ALLOWED_TRANSITIONS: Record<EventStatus, EventStatus[]> = {
  DRAFT: ["ACTIVE"],
  ACTIVE: ["RECOVERY", "CLOSED"],
  RECOVERY: ["ACTIVE", "CLOSED"],
  CLOSED: [],
};

type Locked = { id: string; slug: string; status: EventStatus };

async function lockEvent(tx: Tx, id: string): Promise<Locked> {
  const rows = await tx.query<Locked>(`SELECT id, slug, status FROM events WHERE id = $1 FOR UPDATE`, [id]);
  if (!rows.length) throw new AppError("NOT_FOUND", "Event not found.");
  return rows[0];
}

/** Executive: edit an event and replace its counties and ZIPs. The slug is fixed once the event leaves DRAFT. */
export async function updateEvent(driver: Driver, actorId: string, id: string, raw: unknown): Promise<void> {
  const eventId = parseOrThrow(z.string().uuid(), id);
  const input = parseOrThrow(eventSchema, raw);
  try {
    await runIn(driver, { kind: "system" }, async (tx) => {
      await assertExecutive(tx, actorId);
      const current = await lockEvent(tx, eventId);
      if (current.status === "CLOSED") throw new AppError("VALIDATION", "A closed event is an archive and cannot be edited.");
      const slug = resolveSlug(input, current.slug);
      if (slug !== current.slug && current.status !== "DRAFT") {
        throw new AppError("VALIDATION", "Please correct the highlighted fields.", { slug: ["The slug cannot change after an event is activated"] });
      }
      await assertKnownZips(tx, input.zips);
      await tx.query(
        `UPDATE events SET name = $2, slug = $3, hazard_type = $4, summary = $5, starts_on = $6::date WHERE id = $1`,
        [eventId, input.name, slug, input.hazardType, input.summary ?? null, input.startsOn],
      );
      await tx.query(`DELETE FROM event_counties WHERE event_id = $1`, [eventId]);
      await tx.query(`DELETE FROM event_zips WHERE event_id = $1`, [eventId]);
      for (const countyId of input.countyIds) {
        await tx.query(`INSERT INTO event_counties (event_id, county_id) VALUES ($1, $2)`, [eventId, countyId]);
      }
      for (const zip of input.zips) await tx.query(`INSERT INTO event_zips (event_id, zip) VALUES ($1, $2)`, [eventId, zip]);
      await writeAudit(tx, { actorUserId: actorId, action: "EVENT_UPDATED", subjectType: "event", subjectId: eventId, details: { slug } });
    });
  } catch (err) {
    throw fromDbError(err);
  }
}

/** Executive: move an event along its lifecycle. Closing stamps closed_on. */
export async function setEventStatus(driver: Driver, actorId: string, id: string, to: EventStatus): Promise<void> {
  const eventId = parseOrThrow(z.string().uuid(), id);
  const target = parseOrThrow(z.enum(["DRAFT", "ACTIVE", "RECOVERY", "CLOSED"]), to);
  try {
    await runIn(driver, { kind: "system" }, async (tx) => {
      await assertExecutive(tx, actorId);
      const current = await lockEvent(tx, eventId);
      if (!ALLOWED_TRANSITIONS[current.status].includes(target)) {
        throw new AppError("VALIDATION", `An event cannot move from ${current.status} to ${target}.`);
      }
      // greatest(): an event that has not started yet can still be closed without breaking closed_on >= starts_on.
      await tx.query(
        `UPDATE events SET status = $2, closed_on = CASE WHEN $2 = 'CLOSED' THEN greatest(current_date, starts_on) END WHERE id = $1`,
        [eventId, target],
      );
      await writeAudit(tx, {
        actorUserId: actorId, action: "EVENT_STATUS_CHANGED", subjectType: "event", subjectId: eventId,
        details: { from: current.status, to: target },
      });
    });
  } catch (err) {
    throw fromDbError(err);
  }
}

const PUBLIC_EVENT_SELECT = `
  SELECT id, name, slug, hazard_type, status, summary, starts_on, closed_on, counties, zips FROM public_events`;

/** Public: open events first (newest start first), then the closed archive (most recently closed first). */
export async function listPublicEvents(driver: Driver): Promise<EventRow[]> {
  const rows = await runIn(driver, { kind: "anon" }, (tx) =>
    tx.query<DbEvent>(
      `${PUBLIC_EVENT_SELECT}
        ORDER BY (status = 'CLOSED'), CASE WHEN status = 'CLOSED' THEN NULL ELSE starts_on END DESC, closed_on DESC, name`,
    ),
  );
  return rows.map(toEventRow);
}

/** Public: null for an unknown slug or a DRAFT (the view never returns drafts). */
export async function getPublicEvent(driver: Driver, slug: string): Promise<EventRow | null> {
  const rows = await runIn(driver, { kind: "anon" }, (tx) => tx.query<DbEvent>(`${PUBLIC_EVENT_SELECT} WHERE slug = $1`, [slug]));
  return rows[0] ? toEventRow(rows[0]) : null;
}

export type EventHelpSite = {
  siteId: string;
  siteName: string;
  orgName: string;
  city: string | null;
  postalCode: string | null;
  hoursText: string | null;
  resources: { name: string; categoryLabel: string; reportedStatus: string; freshness: string }[];
};

type DbHelpSite = {
  site_id: string; site_name: string; org_name: string; city: string | null; postal_code: string | null; hours_text: string | null;
  resources: { name: string; categoryLabel: string; reportedStatus: string; freshness: string }[];
};

/** Strip a trailing " County" and compare case-insensitively: site county text is free-form. */
const norm = (col: string) => `lower(btrim(regexp_replace(${col}, '[[:space:]]+county$', '', 'i')))`;

/** Whether public site `ps` serves public event `pe`: its ZIP when the event is narrowed to ZIPs, else its county. */
const SITE_IN_EVENT_AREA = `(
  CASE WHEN cardinality(pe.zips) > 0
       THEN ps.postal_code = ANY (pe.zips)
       ELSE EXISTS (SELECT 1 FROM jsonb_array_elements(pe.counties) c
                     WHERE c->>'state' = ps.state AND ${norm("c->>'name'")} = ${norm("ps.county")})
  END)`;

/**
 * Public: sites that serve an event's area. With ZIPs set, a site matches on its ZIP; otherwise on county
 * (same state, name tolerant of a "County" suffix). Reads only public views, so private data cannot leak,
 * and a DRAFT event (absent from public_events) yields nothing.
 */
export async function getEventHelp(driver: Driver, eventId: string): Promise<EventHelpSite[]> {
  if (!z.string().uuid().safeParse(eventId).success) return [];
  const rows = await runIn(driver, { kind: "anon" }, (tx) =>
    tx.query<DbHelpSite>(
      `SELECT ps.id AS site_id, ps.name AS site_name, ps.org_name, ps.city, ps.postal_code, ps.hours_text,
              coalesce((SELECT json_agg(json_build_object('name', r.name, 'categoryLabel', r.category_label,
                                                          'reportedStatus', r.reported_status, 'freshness', r.freshness) ORDER BY r.name)
                          FROM public_resources r WHERE r.site_id = ps.id), '[]'::json) AS resources
         FROM public_events pe
         JOIN public_sites ps ON ${SITE_IN_EVENT_AREA}
        WHERE pe.id = $1
        ORDER BY ps.name, ps.id`,
      [eventId],
    ),
  );
  return rows.map((r) => ({
    siteId: r.site_id, siteName: r.site_name, orgName: r.org_name, city: r.city, postalCode: r.postal_code,
    hoursText: r.hours_text, resources: r.resources,
  }));
}

export type EventHelper = {
  orgId: string; displayName: string; countiesServed: string[]; acceptedOfferTypes: OfferType[]; donationUrl: string | null;
  openSpots: number; hasUrgent: boolean;
};

/**
 * Public: "Who's helping" for an open (ACTIVE or RECOVERY) event. Organizations with a public profile that either have
 * a project linked to the event or a public site inside its area. Reads only public views, so a hidden, suspended or
 * unconsented organization never appears. Organizations with urgent volunteer roles come first.
 */
export async function listEventHelpers(driver: Driver, eventId: string): Promise<EventHelper[]> {
  if (!z.string().uuid().safeParse(eventId).success) return [];
  const rows = await runIn(driver, { kind: "anon" }, (tx) =>
    tx.query<{
      id: string; display_name: string; counties_served: string[]; accepted_offer_types: OfferType[]; donation_url: string | null;
      open_spots: number; has_urgent: boolean;
    }>(
      `WITH ev AS (SELECT * FROM public_events WHERE id = $1 AND status IN ('ACTIVE','RECOVERY')),
            linked AS (SELECT p.* FROM ev JOIN public_event_links l ON l.event_id = ev.id JOIN public_projects p ON p.id = l.project_id),
            helper_ids AS (
              SELECT org_id FROM linked
              UNION
              SELECT ps.org_id FROM ev pe JOIN public_sites ps ON ${SITE_IN_EVENT_AREA})
       SELECT c.id, c.display_name, c.counties_served, c.accepted_offer_types, c.donation_url,
              coalesce((SELECT sum(greatest(n.slots_needed - n.slots_taken, 0))::int
                          FROM linked lp JOIN public_project_needs n ON n.project_id = lp.id
                         WHERE lp.org_id = c.id AND (n.ends_at IS NULL OR n.ends_at > now())), 0) AS open_spots,
              EXISTS (SELECT 1 FROM linked lp WHERE lp.org_id = c.id AND lp.has_urgent) AS has_urgent
         FROM public_contacts c JOIN helper_ids h ON h.org_id = c.id
        ORDER BY has_urgent DESC, c.display_name, c.id`,
      [eventId],
    ),
  );
  return rows.map((r) => ({
    orgId: r.id, displayName: r.display_name, countiesServed: r.counties_served, acceptedOfferTypes: r.accepted_offer_types,
    donationUrl: r.donation_url, openSpots: r.open_spots, hasUrgent: r.has_urgent,
  }));
}
