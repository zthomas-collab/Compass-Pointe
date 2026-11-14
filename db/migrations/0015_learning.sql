-- 0015: educational library (/learn): YouTube videos and written articles, with moderation before publication.
--
-- Additive and reversible (drop the table, view and functions below).
--  * Only YouTube is accepted for video. The database stores the 11-character video id, never a pasted URL or HTML, and the
--    embed URL is built in code from that id on the youtube-nocookie.com host.
--  * Articles are plain text. They are rendered as escaped text, so no HTML or script can be injected.
--  * Nothing becomes public without moderation by an executive administrator. Submissions from organizations wait in
--    PENDING_REVIEW; executives can publish their own content directly.
--  * Anonymous visitors read only public_learning_resources (published items). Review notes and submitter identities
--    stay inside signed-in views.

CREATE TABLE learning_resources (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title            text NOT NULL CHECK (length(title) BETWEEN 5 AND 140),
  description      text NOT NULL CHECK (length(description) BETWEEN 10 AND 600),
  category         text NOT NULL CHECK (category IN
                   ('PREPAREDNESS','VOLUNTEER_ONBOARDING','RESOURCE_REQUESTS','APPLICATION_WALKTHROUGH','RECOVERY','SAFETY','OTHER')),
  kind             text NOT NULL CHECK (kind IN ('VIDEO','ARTICLE')),
  youtube_id       text CHECK (youtube_id IS NULL OR youtube_id ~ '^[A-Za-z0-9_-]{11}$'),
  body             text CHECK (body IS NULL OR length(body) BETWEEN 50 AND 20000),
  org_id           uuid REFERENCES organizations(id),
  submitted_by     uuid NOT NULL REFERENCES users(id),
  status           text NOT NULL DEFAULT 'PENDING_REVIEW' CHECK (status IN ('DRAFT','PENDING_REVIEW','PUBLISHED','REJECTED','ARCHIVED')),
  review_note      text CHECK (review_note IS NULL OR length(review_note) <= 1000),
  reviewed_by      uuid REFERENCES users(id),
  reviewed_at      timestamptz,
  last_reviewed_at timestamptz,
  published_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'VIDEO' AND youtube_id IS NOT NULL AND body IS NULL) OR (kind = 'ARTICLE' AND body IS NOT NULL AND youtube_id IS NULL)),
  CHECK ((status = 'PUBLISHED') = (published_at IS NOT NULL))
);
CREATE INDEX learning_status_idx ON learning_resources (status, category);
CREATE INDEX learning_org_idx ON learning_resources (org_id) WHERE org_id IS NOT NULL;
CREATE TRIGGER learning_touch BEFORE UPDATE ON learning_resources FOR EACH ROW EXECUTE FUNCTION ics.touch_updated_at();

CREATE FUNCTION ics.learning_transition_ok(f text, t text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT f = t OR (f, t) IN (
    ('PENDING_REVIEW','PUBLISHED'), ('PENDING_REVIEW','REJECTED'), ('REJECTED','PENDING_REVIEW'),
    ('PUBLISHED','ARCHIVED'), ('PUBLISHED','PENDING_REVIEW'), ('ARCHIVED','PUBLISHED'), ('DRAFT','PENDING_REVIEW'), ('DRAFT','PUBLISHED')
  ) $$;
CREATE FUNCTION ics.learning_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind <> OLD.kind OR NEW.submitted_by <> OLD.submitted_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'kind and submitter cannot be changed' USING ERRCODE = '42501';
  END IF;
  IF NOT ics.learning_transition_ok(OLD.status, NEW.status) THEN
    RAISE EXCEPTION 'illegal status change % -> %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  -- Editing published content sends it back for review unless it is the same status being re-saved by the moderator.
  RETURN NEW;
END $$;
CREATE TRIGGER learning_guard_trg BEFORE UPDATE ON learning_resources FOR EACH ROW EXECUTE FUNCTION ics.learning_guard();

-- Row-level security: executives see everything; a signed-in person sees what they or their organization submitted.
ALTER TABLE learning_resources ENABLE ROW LEVEL SECURITY;
CREATE POLICY learning_select ON learning_resources FOR SELECT TO ics_app USING (
  ics.is_platform_admin() OR submitted_by = ics.viewer_id() OR (org_id IS NOT NULL AND org_id = ANY (ics.viewer_approved_org_ids())));
GRANT SELECT ON learning_resources TO ics_app;

-- Public read model: published items only; the organization is named only if it is approved and opted into the public directory (same rule as Contacts).
CREATE VIEW public_learning_resources AS
  SELECT l.id, l.title, l.description, l.category, l.kind, l.youtube_id, l.body, l.published_at, l.last_reviewed_at,
         CASE WHEN o.status = 'APPROVED' AND NOT o.publication_suspended AND o.profile_status = 'APPROVED' AND o.directory_consent_at IS NOT NULL THEN o.display_name END AS org_name
    FROM learning_resources l LEFT JOIN organizations o ON o.id = l.org_id
   WHERE l.status = 'PUBLISHED';
GRANT SELECT ON public_learning_resources TO ics_anon, ics_app;
