-- 0013: community projects (ZIP-level resource needs, commitments, verified delivery).
--
-- Additive and reversible (drop the tables, view, sequence and functions below).
--  * A project belongs to one county and covers one or more ZIP codes.
--  * Each need has a requested quantity. Commitments (from an offer and/or a participating nonprofit) carry
--    five separate, monotonic quantities: offered >= accepted >= dispatched >= received >= verified.
--  * The database refuses double-counting: an offer's active commitments across ALL projects can never add up to more
--    than the offer's quantity, and accepted quantities on a need can never exceed what was requested. Once a commitment
--    is VERIFIED it reserves only the verified quantity, so a shortfall frees the remainder for other commitments.
--  * Nothing is committed automatically. A commitment starts PROPOSED and needs an authorized acceptance.
--  * Anonymous visitors read only public_projects / public_project_updates (summary-level, ZIP-level, aggregate
--    numbers). Commitments, contributors and organizations are never in a public view.

CREATE SEQUENCE project_reference_seq;

CREATE TABLE community_projects (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference            text NOT NULL UNIQUE
                       DEFAULT ('PRJ-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('project_reference_seq')::text, 6, '0')),
  title                text NOT NULL CHECK (length(title) BETWEEN 5 AND 140),
  description          text NOT NULL CHECK (length(description) BETWEEN 10 AND 4000),
  public_summary       text CHECK (public_summary IS NULL OR length(public_summary) BETWEEN 10 AND 600),
  county_id            uuid NOT NULL REFERENCES counties(id),
  category             text NOT NULL CHECK (category IN
                       ('VOLUNTEER_LABOR','PROFESSIONAL_SKILLS','EQUIPMENT','TRANSPORTATION','DRINKING_WATER','FOOD',
                        'BUILDING_SUPPLIES','CLEANING_SUPPLIES','STORAGE_SPACE','OTHER')),
  priority             text NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('LOW','NORMAL','HIGH','CRITICAL')),
  status               text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ACTIVE','ON_HOLD','COMPLETED','CANCELED')),
  visibility           text NOT NULL DEFAULT 'PRIVATE' CHECK (visibility IN ('PRIVATE','PUBLIC')),
  responsible_admin_id uuid REFERENCES users(id),
  start_date           date,
  target_date          date,
  completed_at         timestamptz,
  created_by           uuid NOT NULL REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (visibility = 'PRIVATE' OR public_summary IS NOT NULL),
  CHECK (target_date IS NULL OR start_date IS NULL OR target_date >= start_date),
  CHECK ((status = 'COMPLETED') = (completed_at IS NOT NULL))
);
CREATE INDEX projects_county_status_idx ON community_projects (county_id, status);
CREATE TRIGGER projects_touch BEFORE UPDATE ON community_projects FOR EACH ROW EXECUTE FUNCTION ics.touch_updated_at();

CREATE TABLE project_zips (
  project_id uuid NOT NULL REFERENCES community_projects(id) ON DELETE CASCADE,
  zip        text NOT NULL CHECK (zip ~ '^[0-9]{5}$'),
  PRIMARY KEY (project_id, zip)
);

CREATE TABLE project_needs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id         uuid NOT NULL REFERENCES community_projects(id) ON DELETE CASCADE,
  label              text NOT NULL CHECK (length(label) BETWEEN 2 AND 120),
  contribution_type  text NOT NULL CHECK (contribution_type IN
                     ('VOLUNTEER_LABOR','PROFESSIONAL_SKILLS','EQUIPMENT','TRANSPORTATION','DRINKING_WATER','FOOD',
                      'BUILDING_SUPPLIES','CLEANING_SUPPLIES','STORAGE_SPACE','OTHER')),
  unit               text NOT NULL CHECK (length(unit) BETWEEN 1 AND 40),
  quantity_requested numeric(12,2) NOT NULL CHECK (quantity_requested > 0),
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX project_needs_project_idx ON project_needs (project_id);

CREATE TABLE project_organizations (
  project_id uuid NOT NULL REFERENCES community_projects(id) ON DELETE CASCADE,
  org_id     uuid NOT NULL REFERENCES organizations(id),
  added_by   uuid NOT NULL REFERENCES users(id),
  added_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, org_id)
);

CREATE TABLE project_commitments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     uuid NOT NULL REFERENCES community_projects(id) ON DELETE CASCADE,
  need_id        uuid NOT NULL REFERENCES project_needs(id) ON DELETE CASCADE,
  offer_id       uuid REFERENCES contribution_offers(id),
  org_id         uuid REFERENCES organizations(id),
  source_label   text NOT NULL CHECK (length(source_label) BETWEEN 2 AND 160),
  qty_offered    numeric(12,2) NOT NULL CHECK (qty_offered > 0),
  qty_accepted   numeric(12,2) NOT NULL DEFAULT 0,
  qty_dispatched numeric(12,2) NOT NULL DEFAULT 0,
  qty_received   numeric(12,2) NOT NULL DEFAULT 0,
  qty_verified   numeric(12,2) NOT NULL DEFAULT 0,
  status         text NOT NULL DEFAULT 'PROPOSED'
                 CHECK (status IN ('PROPOSED','ACCEPTED','DISPATCHED','RECEIVED','VERIFIED','DECLINED','CANCELED')),
  scheduled_for  date,
  receiver_name  text CHECK (receiver_name IS NULL OR length(receiver_name) BETWEEN 2 AND 120),
  note           text CHECK (note IS NULL OR length(note) <= 1000),
  proposed_by    uuid NOT NULL REFERENCES users(id),
  accepted_by    uuid REFERENCES users(id),
  accepted_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (offer_id IS NOT NULL OR org_id IS NOT NULL),
  CHECK (qty_accepted >= 0 AND qty_dispatched >= 0 AND qty_received >= 0 AND qty_verified >= 0),
  CHECK (qty_verified <= qty_received AND qty_received <= qty_dispatched AND qty_dispatched <= qty_accepted AND qty_accepted <= qty_offered)
);
CREATE INDEX commitments_need_idx ON project_commitments (need_id);
CREATE INDEX commitments_offer_idx ON project_commitments (offer_id) WHERE offer_id IS NOT NULL;
CREATE INDEX commitments_org_idx ON project_commitments (org_id) WHERE org_id IS NOT NULL;
CREATE TRIGGER commitments_touch BEFORE UPDATE ON project_commitments FOR EACH ROW EXECUTE FUNCTION ics.touch_updated_at();

CREATE TABLE project_updates (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     uuid NOT NULL REFERENCES community_projects(id) ON DELETE CASCADE,
  author_user_id uuid NOT NULL REFERENCES users(id),
  body           text NOT NULL CHECK (length(body) BETWEEN 2 AND 2000),
  is_public      boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX project_updates_project_idx ON project_updates (project_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Integrity that must hold no matter which code path writes
-- ---------------------------------------------------------------------------
CREATE FUNCTION ics.commitment_transition_ok(f text, t text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT f = t OR (f, t) IN (
    ('PROPOSED','ACCEPTED'), ('PROPOSED','DECLINED'), ('PROPOSED','CANCELED'),
    ('ACCEPTED','DISPATCHED'), ('ACCEPTED','CANCELED'),
    ('DISPATCHED','RECEIVED'), ('DISPATCHED','CANCELED'),
    ('RECEIVED','VERIFIED')
  ) $$;

CREATE FUNCTION ics.commitments_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  need_row project_needs%ROWTYPE;
  proj_status text;
  offer_qty numeric;
  offer_type text;
  used numeric;
  accepted_others numeric;
BEGIN
  SELECT * INTO need_row FROM project_needs WHERE id = NEW.need_id FOR UPDATE;   -- serializes writers per need
  IF NOT FOUND OR need_row.project_id <> NEW.project_id THEN
    RAISE EXCEPTION 'need does not belong to this project' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.project_id <> OLD.project_id OR NEW.need_id <> OLD.need_id OR NEW.offer_id IS DISTINCT FROM OLD.offer_id
       OR NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.qty_offered <> OLD.qty_offered THEN
      RAISE EXCEPTION 'commitment target and offered quantity cannot be changed' USING ERRCODE = '42501';
    END IF;
    IF NOT ics.commitment_transition_ok(OLD.status, NEW.status) THEN
      RAISE EXCEPTION 'illegal commitment status change % -> %', OLD.status, NEW.status USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT status INTO proj_status FROM community_projects WHERE id = NEW.project_id;
    IF proj_status NOT IN ('DRAFT','ACTIVE','ON_HOLD') THEN
      RAISE EXCEPTION 'project is closed' USING ERRCODE = '23514';
    END IF;
    IF NEW.org_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM project_organizations WHERE project_id = NEW.project_id AND org_id = NEW.org_id) THEN
      RAISE EXCEPTION 'organization is not a participant in this project' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.offer_id IS NOT NULL THEN
    SELECT quantity, contribution_type INTO offer_qty, offer_type FROM contribution_offers WHERE id = NEW.offer_id FOR UPDATE; -- serializes writers per offer
    IF offer_qty IS NULL THEN
      RAISE EXCEPTION 'the offer has no quantity, so it cannot be allocated' USING ERRCODE = '23514';
    END IF;
    IF offer_type <> need_row.contribution_type THEN
      RAISE EXCEPTION 'the offer type does not match the need' USING ERRCODE = '23514';
    END IF;
    IF NEW.status NOT IN ('DECLINED','CANCELED') THEN
      SELECT coalesce(sum(CASE WHEN status = 'VERIFIED' THEN qty_verified ELSE qty_offered END), 0) INTO used FROM project_commitments
       WHERE offer_id = NEW.offer_id AND id <> NEW.id AND status NOT IN ('DECLINED','CANCELED');
      IF used + (CASE WHEN NEW.status = 'VERIFIED' THEN NEW.qty_verified ELSE NEW.qty_offered END) > offer_qty THEN
        RAISE EXCEPTION 'allocating % would exceed the offer quantity (% already allocated of %)', NEW.qty_offered, used, offer_qty USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;

  IF NEW.status NOT IN ('DECLINED','CANCELED') THEN
    SELECT coalesce(sum(CASE WHEN status = 'VERIFIED' THEN qty_verified ELSE qty_accepted END), 0) INTO accepted_others FROM project_commitments
     WHERE need_id = NEW.need_id AND id <> NEW.id AND status NOT IN ('DECLINED','CANCELED');
    IF accepted_others + (CASE WHEN NEW.status = 'VERIFIED' THEN NEW.qty_verified ELSE NEW.qty_accepted END) > need_row.quantity_requested THEN
      RAISE EXCEPTION 'accepted quantity would exceed the quantity requested for this need' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commitments_guard_trg BEFORE INSERT OR UPDATE ON project_commitments FOR EACH ROW EXECUTE FUNCTION ics.commitments_guard();

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
-- A project is visible to those who manage its county and to approved members of participating organizations.
CREATE FUNCTION ics.can_view_project(p_project uuid, p_county uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, ics AS $$
  SELECT ics.can_manage_county(p_county)
      OR EXISTS (SELECT 1 FROM project_organizations po WHERE po.project_id = p_project AND po.org_id = ANY (ics.viewer_approved_org_ids())) $$;

ALTER TABLE community_projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY projects_select ON community_projects FOR SELECT TO ics_app USING (ics.can_view_project(id, county_id));

ALTER TABLE project_zips ENABLE ROW LEVEL SECURITY;
CREATE POLICY project_zips_select ON project_zips FOR SELECT TO ics_app USING (EXISTS (SELECT 1 FROM community_projects p WHERE p.id = project_id));

ALTER TABLE project_needs ENABLE ROW LEVEL SECURITY;
CREATE POLICY project_needs_select ON project_needs FOR SELECT TO ics_app USING (EXISTS (SELECT 1 FROM community_projects p WHERE p.id = project_id));

ALTER TABLE project_organizations ENABLE ROW LEVEL SECURITY;
CREATE POLICY project_orgs_select ON project_organizations FOR SELECT TO ics_app USING (EXISTS (SELECT 1 FROM community_projects p WHERE p.id = project_id));

ALTER TABLE project_updates ENABLE ROW LEVEL SECURITY;
CREATE POLICY project_updates_select ON project_updates FOR SELECT TO ics_app USING (EXISTS (SELECT 1 FROM community_projects p WHERE p.id = project_id));

-- Managers see every commitment in their county; a participating organization sees only its own.
ALTER TABLE project_commitments ENABLE ROW LEVEL SECURITY;
CREATE POLICY commitments_select ON project_commitments FOR SELECT TO ics_app USING (
  EXISTS (SELECT 1 FROM community_projects p WHERE p.id = project_id AND ics.can_manage_county(p.county_id))
  OR (org_id IS NOT NULL AND org_id = ANY (ics.viewer_approved_org_ids())));

GRANT SELECT ON community_projects, project_zips, project_needs, project_organizations, project_commitments, project_updates TO ics_app;

-- ---------------------------------------------------------------------------
-- Public read model: summary only, ZIP-level, aggregate numbers, no people and no organizations
-- ---------------------------------------------------------------------------
CREATE VIEW public_projects AS
  SELECT p.id, p.reference, p.title, p.public_summary AS summary, c.name AS county_name, c.state, p.category, p.priority, p.status,
         p.start_date, p.target_date,
         coalesce((SELECT array_agg(z.zip ORDER BY z.zip) FROM project_zips z WHERE z.project_id = p.id), '{}') AS zips,
         coalesce((SELECT jsonb_agg(jsonb_build_object(
                     'label', n.label, 'unit', n.unit, 'requested', n.quantity_requested,
                     'verified', coalesce((SELECT sum(k.qty_verified) FROM project_commitments k
                                             WHERE k.need_id = n.id AND k.status NOT IN ('DECLINED','CANCELED')), 0)) ORDER BY n.created_at)
                    FROM project_needs n WHERE n.project_id = p.id), '[]'::jsonb) AS needs
    FROM community_projects p JOIN counties c ON c.id = p.county_id
   WHERE p.visibility = 'PUBLIC' AND p.status IN ('ACTIVE','COMPLETED');

CREATE VIEW public_project_updates AS
  SELECT u.id, u.project_id, u.body, u.created_at
    FROM project_updates u JOIN community_projects p ON p.id = u.project_id
   WHERE u.is_public AND p.visibility = 'PUBLIC' AND p.status IN ('ACTIVE','COMPLETED');

GRANT SELECT ON public_projects, public_project_updates TO ics_anon, ics_app;
