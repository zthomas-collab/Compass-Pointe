-- 0017: give to organizations.
--
-- Additive and reversible (drop the new columns, table, trigger and functions; restore offers_guard, the two
-- offer policies and public_contacts from 0012/0008).
--  * An organization may publish a link to its own donation page. It is public only while APPROVED by an
--    administrator, and any change to the link sends it back to PENDING (enforced here by trigger, not only in code).
--  * An organization lists which kinds of in-kind giving it accepts (the same ten types as contribution offers).
--  * A giver can send an offer to one organization (contribution_offers.organization_id). Such an offer needs the
--    giver's consent to share their details with that organization, starts MATCHED, and is worked by that
--    organization (actor_role 'ORG'). The organization can never send it back to central triage; an administrator
--    can (MATCHED -> REVIEWED), which detaches it from the organization in the same update. Nothing else may
--    change organization_id.
--  * Who sees a directed offer: editors (ORG_ADMIN, EDITOR) of that organization while it is eligible, the
--    administrators of any county it serves, plus everyone who already saw it under 0012 (executives and the
--    giver's county administrators). Organization VIEWERs and other organizations never see it.

-- ---------------------------------------------------------------------------
-- Donation link with its own approval
-- ---------------------------------------------------------------------------
ALTER TABLE organizations
  ADD COLUMN donation_url             text CHECK (donation_url IS NULL OR (length(donation_url) <= 300 AND donation_url ~* '^https?://')),
  ADD COLUMN donation_url_status      text NOT NULL DEFAULT 'NONE' CHECK (donation_url_status IN ('NONE','PENDING','APPROVED','REJECTED')),
  ADD COLUMN donation_url_reviewed_by uuid REFERENCES users(id),
  ADD COLUMN donation_url_reviewed_at timestamptz,
  ADD COLUMN donation_url_review_note text CHECK (donation_url_review_note IS NULL OR length(donation_url_review_note) <= 2000);

CREATE FUNCTION ics.donation_url_reset() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.donation_url IS DISTINCT FROM OLD.donation_url THEN
    NEW.donation_url_status := CASE WHEN NEW.donation_url IS NULL THEN 'NONE' ELSE 'PENDING' END;
    NEW.donation_url_reviewed_by := NULL;
    NEW.donation_url_reviewed_at := NULL;
    NEW.donation_url_review_note := NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER organizations_donation_url_reset BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION ics.donation_url_reset();

-- ---------------------------------------------------------------------------
-- Accepted offer types
-- ---------------------------------------------------------------------------
CREATE TABLE organization_accepted_offer_types (
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  offer_type text NOT NULL CHECK (offer_type IN
             ('VOLUNTEER_LABOR','PROFESSIONAL_SKILLS','EQUIPMENT','TRANSPORTATION','DRINKING_WATER','FOOD',
              'BUILDING_SUPPLIES','CLEANING_SUPPLIES','STORAGE_SPACE','OTHER')),
  PRIMARY KEY (org_id, offer_type)
);
GRANT SELECT ON organization_accepted_offer_types TO ics_app;

-- ---------------------------------------------------------------------------
-- Offers sent to an organization
-- ---------------------------------------------------------------------------
ALTER TABLE contribution_offers
  ADD COLUMN organization_id uuid REFERENCES organizations(id),
  ADD CONSTRAINT offers_directed_needs_consent CHECK (organization_id IS NULL OR consent_share);
CREATE INDEX offers_org_status_idx ON contribution_offers (organization_id, status, created_at DESC) WHERE organization_id IS NOT NULL;

ALTER TABLE contribution_offer_events DROP CONSTRAINT contribution_offer_events_actor_role_check;
ALTER TABLE contribution_offer_events ADD CONSTRAINT contribution_offer_events_actor_role_check
  CHECK (actor_role IN ('CONTRIBUTOR','COUNTY_ADMIN','EXECUTIVE','SYSTEM','ORG'));

-- Eligible to receive (and keep working) offers: approved, publishing, approved public profile, directory consent.
CREATE FUNCTION ics.org_is_eligible(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, ics AS $$
  SELECT EXISTS (SELECT 1 FROM organizations o
                  WHERE o.id = p_org AND o.status = 'APPROVED' AND NOT o.publication_suspended
                    AND o.profile_status = 'APPROVED' AND o.directory_consent_at IS NOT NULL) $$;

CREATE FUNCTION ics.can_view_directed_offer(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, ics AS $$
  SELECT p_org IS NOT NULL AND (
    ics.is_platform_admin()
    OR EXISTS (SELECT 1 FROM organization_counties oc WHERE oc.org_id = p_org AND oc.county_id = ANY (ics.viewer_county_ids()))
    OR (ics.org_is_eligible(p_org) AND EXISTS (
          SELECT 1 FROM organization_memberships m JOIN users u ON u.id = m.user_id
           WHERE m.org_id = p_org AND m.user_id = ics.viewer_id() AND m.status = 'ACTIVE'
             AND m.role IN ('ORG_ADMIN','EDITOR') AND u.status = 'ACTIVE'))) $$;

DROP POLICY offers_select ON contribution_offers;
CREATE POLICY offers_select ON contribution_offers FOR SELECT TO ics_app
  USING (ics.can_view_offer(county_id) OR ics.can_view_directed_offer(organization_id));

DROP POLICY offer_events_select ON contribution_offer_events;
CREATE POLICY offer_events_select ON contribution_offer_events FOR SELECT TO ics_app USING (
  EXISTS (SELECT 1 FROM contribution_offers o WHERE o.id = offer_id
             AND (ics.can_view_offer(o.county_id) OR ics.can_view_directed_offer(o.organization_id))));

CREATE OR REPLACE FUNCTION ics.offers_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  actor uuid := nullif(current_setting('ics.actor_id', true), '')::uuid;
  actor_role text := nullif(current_setting('ics.actor_role', true), '');
  note text := nullif(current_setting('ics.event_note', true), '');
BEGIN
  IF NEW.email <> OLD.email OR NEW.zip <> OLD.zip OR NEW.contribution_type <> OLD.contribution_type
     OR NEW.created_at <> OLD.created_at OR NEW.reference <> OLD.reference THEN
    RAISE EXCEPTION 'submitted details cannot be changed' USING ERRCODE = '42501';
  END IF;
  -- A county can be filled in once (executive triage); it is never silently re-pointed.
  IF OLD.county_id IS NOT NULL AND NEW.county_id IS DISTINCT FROM OLD.county_id THEN
    RAISE EXCEPTION 'county cannot be changed once assigned' USING ERRCODE = '42501';
  END IF;
  -- The receiving organization is fixed at submission. The one exception: an administrator returns a matched
  -- offer to central triage, which detaches it from the organization.
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    IF NOT (OLD.organization_id IS NOT NULL AND NEW.organization_id IS NULL
            AND OLD.status = 'MATCHED' AND NEW.status = 'REVIEWED'
            AND actor_role IN ('COUNTY_ADMIN','EXECUTIVE') AND actor IS NOT NULL) THEN
      RAISE EXCEPTION 'the receiving organization cannot be changed' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  IF actor_role = 'ORG' AND NEW.status = 'REVIEWED' THEN
    RAISE EXCEPTION 'an organization cannot send an offer back to central triage' USING ERRCODE = '42501';
  END IF;
  IF NOT ics.offer_transition_ok(OLD.status, NEW.status) THEN
    RAISE EXCEPTION 'illegal status change % -> %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  IF actor_role IS NULL OR (actor IS NULL AND actor_role <> 'SYSTEM') THEN
    RAISE EXCEPTION 'status changes must identify the actor' USING ERRCODE = '42501';
  END IF;
  NEW.status_changed_at := now();
  INSERT INTO contribution_offer_events (offer_id, actor_user_id, actor_role, event_type, from_status, to_status, note)
  VALUES (NEW.id, actor, actor_role, 'STATUS_CHANGED', OLD.status, NEW.status, note);
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- Public read model: 0008's view plus the approved donation link and accepted types.
-- ---------------------------------------------------------------------------
DROP VIEW public_contacts;
CREATE VIEW public_contacts AS
SELECT o.id, o.display_name, o.org_type, o.description, o.website, o.public_phone, o.public_email,
       o.public_postal_code,
       o.primary_service_type AS service_type, st.label AS service_label, st.short_label AS service_short,
       st.color AS service_color,
       coalesce((SELECT array_agg(ost.service_type ORDER BY t.sort_order)
                   FROM organization_service_types ost JOIN service_types t ON t.code = ost.service_type
                  WHERE ost.org_id = o.id AND ost.service_type <> o.primary_service_type), '{}') AS additional_service_types,
       coalesce((SELECT string_agg(t.label, ' ') FROM organization_service_types ost JOIN service_types t ON t.code = ost.service_type
                  WHERE ost.org_id = o.id), '') || ' ' || st.label AS service_text,
       (SELECT count(*)::int FROM public_sites ps WHERE ps.org_id = o.id) AS public_site_count,
       o.approved_at, o.updated_at, o.directory_consent_at, o.is_synthetic,
       o.social_links,
       o.logo_storage_key, o.logo_alt,
       coalesce((SELECT array_agg(c.name || ', ' || c.state ORDER BY c.state, c.name)
                   FROM organization_counties oc JOIN counties c ON c.id = oc.county_id
                  WHERE oc.org_id = o.id), '{}') AS counties_served,
       CASE WHEN o.donation_url_status = 'APPROVED' THEN o.donation_url END AS donation_url,
       coalesce((SELECT array_agg(a.offer_type ORDER BY a.offer_type)
                   FROM organization_accepted_offer_types a WHERE a.org_id = o.id), '{}') AS accepted_offer_types
  FROM organizations o JOIN service_types st ON st.code = o.primary_service_type
 WHERE o.status = 'APPROVED' AND NOT o.publication_suspended AND o.directory_consent_at IS NOT NULL
   AND o.profile_status = 'APPROVED';

GRANT SELECT ON public_contacts TO ics_anon, ics_app;
