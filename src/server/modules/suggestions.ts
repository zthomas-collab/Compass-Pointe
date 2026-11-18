import type { Tx } from "../db";

/**
 * Stage 5, "suggest, then confirm": geography proposes (project, event) pairs as SUGGESTED rows in
 * project_event_links; a person confirms (linkProjectToEvent) or dismisses (dismissSuggestion) them.
 * Suggestions are never public: public_event_links reads CONFIRMED rows only.
 *
 * Kept apart from eventlinks.ts so projects.ts and events.ts can call these inside their own transactions without an
 * import cycle (eventlinks.ts already imports projects.ts). Callers run in the system context.
 */

/** The event-area rule shared with eventlinks.ts and public_event_links: event ZIPs when it has any, else its counties. */
const IN_AREA = `CASE WHEN EXISTS (SELECT 1 FROM event_zips z WHERE z.event_id = e.id)
                      THEN EXISTS (SELECT 1 FROM event_zips z WHERE z.event_id = e.id AND z.zip = p.zip)
                      ELSE EXISTS (SELECT 1 FROM event_counties ec WHERE ec.event_id = e.id AND ec.county_id = p.county_id) END`;

/**
 * Suggest every ACTIVE or RECOVERY event whose area contains this OPEN project. Pairs that already have a link row in
 * any state (suggested, confirmed or dismissed) are left alone, so re-running never duplicates or revives anything.
 * Returns how many suggestions were added.
 */
export async function suggestForProject(tx: Tx, projectId: string): Promise<number> {
  const rows = await tx.query(
    `INSERT INTO project_event_links (project_id, event_id, state)
     SELECT p.id, e.id, 'SUGGESTED'
       FROM projects p JOIN events e ON e.status IN ('ACTIVE','RECOVERY')
      WHERE p.id = $1 AND p.status = 'OPEN' AND ${IN_AREA}
     ON CONFLICT (project_id, event_id) DO NOTHING
     RETURNING 1`,
    [projectId],
  );
  return rows.length;
}

/** Suggest every OPEN project inside this event's area, when the event is ACTIVE or RECOVERY. Same rules as above. */
export async function suggestForEvent(tx: Tx, eventId: string): Promise<number> {
  const rows = await tx.query(
    `INSERT INTO project_event_links (project_id, event_id, state)
     SELECT p.id, e.id, 'SUGGESTED'
       FROM events e JOIN projects p ON p.status = 'OPEN'
      WHERE e.id = $1 AND e.status IN ('ACTIVE','RECOVERY') AND ${IN_AREA}
     ON CONFLICT (project_id, event_id) DO NOTHING
     RETURNING 1`,
    [eventId],
  );
  return rows.length;
}
