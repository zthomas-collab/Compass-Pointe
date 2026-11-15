import { z } from "zod";
import type { Driver, Tx } from "../db";
import { runIn } from "../db/context";
import { AppError, fromDbError } from "../errors";
import { assertExecutive } from "./access";
import { parseOrThrow } from "./identity";
import { writeAudit } from "./shared";

export const HAZARD_TYPES = ["HURRICANE", "FLOOD", "WILDFIRE", "TORNADO", "WINTER_STORM", "EARTHQUAKE", "OTHER"] as const;
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

function resolveSlug(input: EventInput): string {
  const slug = input.slug ?? slugify(input.name);
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
