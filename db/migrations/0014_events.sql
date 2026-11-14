-- 0014: disaster-response events and logistics.
--
-- Additive and reversible (drop the tables/view/functions below and the community_projects.event_id column).
--  * An event belongs to one county, covers ZIP codes and has a schedule, a lead coordinator, tasks, requirements
--    (supplies, equipment, volunteers), participating organizations and status updates.
--  * Events are PRIVATE by default. Creating one never discloses staging sites or operations: the public view shows only
--    a coordinator-written summary, ZIP codes, dates and status.
--  * Projects can be linked to an event so resource commitments and verified deliveries roll up into event reporting.

CREATE SEQUENCE event_reference_seq;

CREATE TABLE events (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference           text NOT NULL UNIQUE
                      DEFAULT ('EVT-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('event_reference_seq')::text, 6, '0')),
  name                text NOT NULL CHECK (length(name) BETWEEN 3 AND 140),
  description         text NOT NULL CHECK (length(description) BETWEEN 5 AND 4000),
  category            text NOT NULL CHECK (category IN ('HURRICANE','FLOOD','WINTER_STORM','TORNADO','WILDFIRE','LANDSLIDE','EXTREME_HEAT','OTHER')),
  county_id           uuid NOT NULL REFERENCES counties(id),
  start_date          date NOT NULL,
  end_date            date,
  status              text NOT NULL DEFAULT 'SCHEDULED' CHECK (status IN ('SCHEDULED','ACTIVE','COMPLETED','CANCELED')),
  lead_coordinator_id uuid REFERENCES users(id),
  visibility          text NOT NULL DEFAULT 'PRIVATE' CHECK (visibility IN ('PRIVATE','PUBLIC')),
  public_summary      text CHECK (public_summary IS NULL OR length(public_summary) BETWEEN 10 AND 600),
  internal_notes      text CHECK (internal_notes IS NULL OR length(internal_notes) <= 4000),
  created_by          uuid NOT NULL REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date IS NULL OR end_date >= start_date),
  CHECK (visibility = 'PRIVATE' OR public_summary IS NOT NULL)
);
CREATE INDEX events_county_status_idx ON events (county_id, status, start_date);
CREATE TRIGGER events_touch BEFORE UPDATE ON events FOR EACH ROW EXECUTE FUNCTION ics.touch_updated_at();

CREATE FUNCTION ics.event_transition_ok(f text, t text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT f = t OR (f, t) IN (('SCHEDULED','ACTIVE'), ('SCHEDULED','CANCELED'), ('ACTIVE','COMPLETED'), ('ACTIVE','CANCELED')) $$;
CREATE FUNCTION ics.events_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.county_id <> OLD.county_id OR NEW.created_at <> OLD.created_at OR NEW.reference <> OLD.reference THEN
    RAISE EXCEPTION 'event county and reference cannot be changed' USING ERRCODE = '42501';
  END IF;
  IF NOT ics.event_transition_ok(OLD.status, NEW.status) THEN
    RAISE EXCEPTION 'illegal event status change % -> %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER events_guard_trg BEFORE UPDATE ON events FOR EACH ROW EXECUTE FUNCTION ics.events_guard();

CREATE TABLE event_zips (
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  zip      text NOT NULL CHECK (zip ~ '^[0-9]{5}$'),
  PRIMARY KEY (event_id, zip)
);

CREATE TABLE event_organizations (
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  org_id   uuid NOT NULL REFERENCES organizations(id),
  added_by uuid NOT NULL REFERENCES users(id),
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, org_id)
);

CREATE TABLE event_tasks (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id         uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  title            text NOT NULL CHECK (length(title) BETWEEN 3 AND 140),
  description      text CHECK (description IS NULL OR length(description) <= 2000),
  status           text NOT NULL DEFAULT 'TODO' CHECK (status IN ('TODO','IN_PROGRESS','BLOCKED','DONE')),
  priority         text NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('LOW','NORMAL','HIGH','CRITICAL')),
  assignee_user_id uuid REFERENCES users(id),
  assignee_org_id  uuid REFERENCES organizations(id),
  due_date         date,
  completed_at     timestamptz,
  created_by       uuid NOT NULL REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'DONE') = (completed_at IS NOT NULL))
);
CREATE INDEX event_tasks_event_idx ON event_tasks (event_id, status);
CREATE TRIGGER event_tasks_touch BEFORE UPDATE ON event_tasks FOR EACH ROW EXECUTE FUNCTION ics.touch_updated_at();

CREATE TABLE event_requirements (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  kind     text NOT NULL CHECK (kind IN ('SUPPLY','EQUIPMENT','VOLUNTEER')),
  label    text NOT NULL CHECK (length(label) BETWEEN 2 AND 120),
  quantity numeric(12,2) NOT NULL CHECK (quantity > 0),
  unit     text NOT NULL CHECK (length(unit) BETWEEN 1 AND 40)
);
CREATE INDEX event_requirements_event_idx ON event_requirements (event_id);

CREATE TABLE event_updates (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id       uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  author_user_id uuid NOT NULL REFERENCES users(id),
  body           text NOT NULL CHECK (length(body) BETWEEN 2 AND 2000),
  is_public      boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX event_updates_event_idx ON event_updates (event_id, created_at DESC);

-- Projects can belong to an event (nullable, so every existing project is unchanged).
ALTER TABLE community_projects ADD COLUMN event_id uuid REFERENCES events(id);
CREATE INDEX projects_event_idx ON community_projects (event_id) WHERE event_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Row-level security: coordinators of the county, and approved members of participating organizations
-- ---------------------------------------------------------------------------
CREATE FUNCTION ics.can_view_event(p_event uuid, p_county uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, ics AS $$
  SELECT ics.can_manage_county(p_county)
      OR EXISTS (SELECT 1 FROM event_organizations eo WHERE eo.event_id = p_event AND eo.org_id = ANY (ics.viewer_approved_org_ids())) $$;

ALTER TABLE events ENABLE ROW LEVEL SECURITY;
CREATE POLICY events_select ON events FOR SELECT TO ics_app USING (ics.can_view_event(id, county_id));
-- Internal notes are for coordinators only: participants read the event row through a column-limited path in code.

ALTER TABLE event_zips ENABLE ROW LEVEL SECURITY;
CREATE POLICY event_zips_select ON event_zips FOR SELECT TO ics_app USING (EXISTS (SELECT 1 FROM events e WHERE e.id = event_id));
ALTER TABLE event_organizations ENABLE ROW LEVEL SECURITY;
CREATE POLICY event_orgs_select ON event_organizations FOR SELECT TO ics_app USING (EXISTS (SELECT 1 FROM events e WHERE e.id = event_id));
ALTER TABLE event_requirements ENABLE ROW LEVEL SECURITY;
CREATE POLICY event_reqs_select ON event_requirements FOR SELECT TO ics_app USING (EXISTS (SELECT 1 FROM events e WHERE e.id = event_id));
ALTER TABLE event_updates ENABLE ROW LEVEL SECURITY;
CREATE POLICY event_updates_select ON event_updates FOR SELECT TO ics_app USING (EXISTS (SELECT 1 FROM events e WHERE e.id = event_id));

-- Coordinators see every task; a participating organization sees only tasks assigned to it.
ALTER TABLE event_tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY event_tasks_select ON event_tasks FOR SELECT TO ics_app USING (
  EXISTS (SELECT 1 FROM events e WHERE e.id = event_id AND ics.can_manage_county(e.county_id))
  OR (assignee_org_id IS NOT NULL AND assignee_org_id = ANY (ics.viewer_approved_org_ids())));

GRANT SELECT ON events, event_zips, event_organizations, event_tasks, event_requirements, event_updates TO ics_app;
-- The column-level grant keeps internal_notes out of reach of anything but coordinator code paths that run as the system role.
REVOKE SELECT ON events FROM ics_app;
GRANT SELECT (id, reference, name, description, category, county_id, start_date, end_date, status, lead_coordinator_id, visibility, public_summary,
              created_by, created_at, updated_at) ON events TO ics_app;

-- ---------------------------------------------------------------------------
-- Public read model: no tasks, no organizations, no internal notes, no locations beyond ZIP codes
-- ---------------------------------------------------------------------------
CREATE VIEW public_events AS
  SELECT e.id, e.reference, e.name, e.category, e.public_summary AS summary, c.name AS county_name, c.state, e.start_date, e.end_date, e.status,
         coalesce((SELECT array_agg(z.zip ORDER BY z.zip) FROM event_zips z WHERE z.event_id = e.id), '{}') AS zips
    FROM events e JOIN counties c ON c.id = e.county_id
   WHERE e.visibility = 'PUBLIC' AND e.status IN ('SCHEDULED','ACTIVE','COMPLETED');

CREATE VIEW public_event_updates AS
  SELECT u.id, u.event_id, u.body, u.created_at
    FROM event_updates u JOIN events e ON e.id = u.event_id
   WHERE u.is_public AND e.visibility = 'PUBLIC' AND e.status IN ('SCHEDULED','ACTIVE','COMPLETED');

GRANT SELECT ON public_events, public_event_updates TO ics_anon, ics_app;
