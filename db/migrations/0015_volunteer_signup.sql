-- ---------------------------------------------------------------------------
-- Volunteer sign-up: a member of the public holds a slot of a project need with no account.
-- Written only by the connection (system) role. No request role can read these tables; the public sees
-- only counts (added to public_project_needs below), never a name, email, phone or token.
-- The emailed link carries a random token; only its SHA-256 hash is stored.
-- ---------------------------------------------------------------------------
CREATE TABLE volunteer_commitments (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- RESTRICT: a need that has sign-up history cannot be deleted out from under the volunteers.
  need_id              uuid NOT NULL REFERENCES project_needs(id),
  volunteer_name       text NOT NULL CHECK (length(volunteer_name) BETWEEN 2 AND 120),
  email                text NOT NULL CHECK (email = lower(email) AND length(email) BETWEEN 5 AND 254),
  phone                text CHECK (phone IS NULL OR length(phone) BETWEEN 7 AND 40),
  status               text NOT NULL DEFAULT 'PENDING_EMAIL'
                       CHECK (status IN ('PENDING_EMAIL','CONFIRMED','CANCELLED','ATTENDED','NO_SHOW')),
  token_hash           text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  -- A PENDING_EMAIL sign-up holds its slot only until this moment.
  hold_expires_at      timestamptz,
  consent_share        boolean NOT NULL CHECK (consent_share),
  created_at           timestamptz NOT NULL DEFAULT now(),
  confirmed_at         timestamptz,
  cancelled_at         timestamptz,
  attendance_marked_by uuid REFERENCES users(id),
  attendance_marked_at timestamptz
);
-- One active sign-up per email per need. (Expired pending holds are cancelled by the service before a re-sign-up.)
CREATE UNIQUE INDEX volunteer_commitments_active_uq ON volunteer_commitments (need_id, email)
  WHERE status IN ('PENDING_EMAIL','CONFIRMED','ATTENDED');
CREATE INDEX volunteer_commitments_need_status_idx ON volunteer_commitments (need_id, status);
CREATE INDEX volunteer_commitments_email_idx ON volunteer_commitments (email, created_at);

CREATE TABLE volunteer_commitment_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  commitment_id uuid NOT NULL REFERENCES volunteer_commitments(id),
  event_type    text NOT NULL CHECK (length(event_type) BETWEEN 3 AND 40),
  from_status   text,
  to_status     text,
  actor_role    text NOT NULL CHECK (actor_role IN ('VOLUNTEER','ORG','SYSTEM')),
  occurred_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX volunteer_commitment_events_idx ON volunteer_commitment_events (commitment_id, occurred_at);
CREATE TRIGGER volunteer_commitment_events_append_only BEFORE UPDATE OR DELETE ON volunteer_commitment_events
  FOR EACH ROW EXECUTE FUNCTION ics.reject_mutation();

ALTER TABLE volunteer_commitments ENABLE ROW LEVEL SECURITY;
ALTER TABLE volunteer_commitment_events ENABLE ROW LEVEL SECURITY;
