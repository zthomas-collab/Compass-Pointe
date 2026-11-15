-- ---------------------------------------------------------------------------
-- Events: named disaster areas (counties, optionally narrowed to ZIPs).
-- Written only by the connection (system) role after the service checks the actor is a platform admin.
-- No request role can read the tables; the public reads the public_events view, which hides DRAFT events.
-- ---------------------------------------------------------------------------
CREATE TABLE events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (length(name) BETWEEN 3 AND 120),
  slug        text NOT NULL UNIQUE
              CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) BETWEEN 3 AND 80 AND slug <> 'new'),
  hazard_type text NOT NULL CHECK (hazard_type IN ('HURRICANE','FLOOD','WILDFIRE','TORNADO','WINTER_STORM','EARTHQUAKE','OTHER')),
  status      text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ACTIVE','RECOVERY','CLOSED')),
  summary     text CHECK (summary IS NULL OR length(summary) <= 2000),
  starts_on   date NOT NULL,
  closed_on   date,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (closed_on IS NULL OR closed_on >= starts_on),
  CHECK ((status = 'CLOSED') = (closed_on IS NOT NULL))
);
CREATE TRIGGER events_touch BEFORE UPDATE ON events FOR EACH ROW EXECUTE FUNCTION ics.touch_updated_at();

CREATE TABLE event_counties (
  event_id  uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  county_id uuid NOT NULL REFERENCES counties(id),
  PRIMARY KEY (event_id, county_id)
);
CREATE INDEX event_counties_county_idx ON event_counties (county_id);

CREATE TABLE event_zips (
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  zip      text NOT NULL CHECK (zip ~ '^[0-9]{5}$'),
  PRIMARY KEY (event_id, zip)
);

ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_counties ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_zips ENABLE ROW LEVEL SECURITY;

-- Public read model: whitelisted columns, never DRAFT.
CREATE VIEW public_events AS
SELECT e.id, e.name, e.slug, e.hazard_type, e.status, e.summary,
       e.starts_on::text AS starts_on, e.closed_on::text AS closed_on,
       coalesce((SELECT array_agg(c.name || ', ' || c.state ORDER BY c.state, c.name)
                   FROM event_counties ec JOIN counties c ON c.id = ec.county_id
                  WHERE ec.event_id = e.id), '{}') AS counties,
       coalesce((SELECT array_agg(z.zip ORDER BY z.zip) FROM event_zips z WHERE z.event_id = e.id), '{}') AS zips
  FROM events e
 WHERE e.status <> 'DRAFT';

GRANT SELECT ON public_events TO ics_anon, ics_app;
