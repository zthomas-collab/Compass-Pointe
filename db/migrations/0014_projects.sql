-- ---------------------------------------------------------------------------
-- Projects: local, need-based work posted by approved organizations for volunteers.
-- Written only by the connection (system) role after the service re-derives the actor's role.
-- No request role can read these tables; the public reads the public_* views (added below), which
-- expose only OPEN projects of approved organizations and never the private location notes.
-- ---------------------------------------------------------------------------
CREATE TABLE projects (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 uuid NOT NULL REFERENCES organizations(id),
  title                  text NOT NULL CHECK (length(title) BETWEEN 5 AND 140),
  description            text NOT NULL CHECK (length(description) BETWEEN 10 AND 4000),
  county_id              uuid NOT NULL REFERENCES counties(id),
  zip                    text NOT NULL CHECK (zip ~ '^[0-9]{5}$'),
  audience               text NOT NULL CHECK (audience IN ('COMMUNITY','ORG_FACILITY','HOUSEHOLD_GENERALIZED')),
  status                 text NOT NULL DEFAULT 'DRAFT'
                         CHECK (status IN ('DRAFT','PENDING_REVIEW','OPEN','PAUSED','COMPLETED','CANCELLED')),
  -- Exact address or meeting point. Shown only to confirmed volunteers (a later stage); never public.
  private_location_notes text CHECK (private_location_notes IS NULL OR length(private_location_notes) <= 1000),
  review_note            text CHECK (review_note IS NULL OR length(review_note) <= 2000),
  reviewed_by            uuid REFERENCES users(id),
  reviewed_at            timestamptz,
  created_by             uuid REFERENCES users(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX projects_org_idx ON projects (org_id);
CREATE INDEX projects_county_status_idx ON projects (county_id, status);
CREATE INDEX projects_zip_idx ON projects (zip);
CREATE TRIGGER projects_touch BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION ics.touch_updated_at();

CREATE TABLE project_needs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- Stage 2 supports people needs only; Stage 6 relaxes this to include GOODS.
  need_type    text NOT NULL DEFAULT 'PEOPLE' CHECK (need_type = 'PEOPLE'),
  title        text NOT NULL CHECK (length(title) BETWEEN 3 AND 120),
  details      text CHECK (details IS NULL OR length(details) <= 1000),
  urgency      text NOT NULL DEFAULT 'NORMAL' CHECK (urgency IN ('NORMAL','URGENT')),
  slots_needed int NOT NULL CHECK (slots_needed BETWEEN 1 AND 500),
  starts_at    timestamptz,
  ends_at      timestamptz,
  skills       text CHECK (skills IS NULL OR length(skills) <= 200),
  instructions text CHECK (instructions IS NULL OR length(instructions) <= 1000),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at)
);
CREATE INDEX project_needs_project_idx ON project_needs (project_id);
CREATE TRIGGER project_needs_touch BEFORE UPDATE ON project_needs FOR EACH ROW EXECUTE FUNCTION ics.touch_updated_at();

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_needs ENABLE ROW LEVEL SECURITY;
