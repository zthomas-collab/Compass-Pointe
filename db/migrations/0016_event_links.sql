-- ---------------------------------------------------------------------------
-- Event-project links: which projects belong to which disaster event.
-- A project may belong to several events. Written only by the connection (system) role after the service
-- re-derives the actor's role; no request role can read the table. The public sees only the confirmed links that
-- still pass every check, through the public_event_links view (added below).
-- States: SUGGESTED (a later stage proposes links), CONFIRMED (shown publicly once everything else checks out),
-- DISMISSED (taken off; an administrator's dismissal cannot be undone by the organization).
-- ---------------------------------------------------------------------------
CREATE TABLE project_event_links (
  project_id      uuid NOT NULL REFERENCES projects(id),
  event_id        uuid NOT NULL REFERENCES events(id),
  state           text NOT NULL CHECK (state IN ('SUGGESTED','CONFIRMED','DISMISSED')),
  suggested_by    uuid REFERENCES users(id),
  decided_by      uuid REFERENCES users(id),
  decided_by_role text CHECK (decided_by_role IS NULL OR decided_by_role IN ('ORG','ADMIN')),
  decided_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, event_id),
  -- Every decided link records who decided, in what capacity, and when.
  CHECK (state = 'SUGGESTED' OR (decided_by IS NOT NULL AND decided_by_role IS NOT NULL AND decided_at IS NOT NULL))
);
CREATE INDEX project_event_links_event_idx ON project_event_links (event_id, state);
CREATE TRIGGER project_event_links_touch BEFORE UPDATE ON project_event_links FOR EACH ROW EXECUTE FUNCTION ics.touch_updated_at();

ALTER TABLE project_event_links ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Public read model. A link is public only while EVERYTHING still checks out, evaluated at read time:
-- the link is confirmed, the event is not a draft, the project is open with an approved, non-suspended
-- organization, and the project is inside the event's area right now (ZIPs when the event names any, else counties).
-- Editing a project's ZIP/county or an event's area therefore takes effect immediately, with no rewrite of link rows.
-- Only the two ids are exposed.
-- ---------------------------------------------------------------------------
CREATE VIEW public_event_links AS
SELECT l.event_id, l.project_id
  FROM project_event_links l
  JOIN public_events e ON e.id = l.event_id
  JOIN public_projects p ON p.id = l.project_id
 WHERE l.state = 'CONFIRMED'
   AND CASE WHEN EXISTS (SELECT 1 FROM event_zips z WHERE z.event_id = l.event_id)
            THEN EXISTS (SELECT 1 FROM event_zips z WHERE z.event_id = l.event_id AND z.zip = p.zip)
            ELSE EXISTS (SELECT 1 FROM event_counties ec WHERE ec.event_id = l.event_id AND ec.county_id = p.county_id)
       END;

GRANT SELECT ON public_event_links TO ics_anon, ics_app;
