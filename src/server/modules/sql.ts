/**
 * SQL fragments shared by several modules, so a rule lives in one place. Arguments are SQL expressions written by the
 * caller (column names or $n placeholders), never user input.
 */

/** An ILIKE pattern that matches `q` anywhere, with LIKE's special characters (\ % _) escaped. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * Is a project inside an event's area? When the event names ZIP codes, the project's ZIP must be one of them;
 * otherwise the project's county must be one of the event's counties. The same rule the public_event_links view
 * (migration 0016) applies at read time.
 *
 * @param eventId SQL expression for the event id
 * @param zip     SQL expression for the project's 5-digit ZIP
 * @param county  SQL expression for the project's county id
 */
export function inEventAreaSql(eventId: string, zip: string, county: string): string {
  return `CASE WHEN EXISTS (SELECT 1 FROM event_zips ez WHERE ez.event_id = ${eventId})
               THEN EXISTS (SELECT 1 FROM event_zips ez WHERE ez.event_id = ${eventId} AND ez.zip = ${zip})
               ELSE EXISTS (SELECT 1 FROM event_counties ec WHERE ec.event_id = ${eventId} AND ec.county_id = ${county}) END`;
}
