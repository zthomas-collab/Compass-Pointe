-- 0019: a project starts at one of its organization's sites.
--
-- The site gives the project its place on the map, and the project's county and ZIP are taken from the site (0018
-- derives a site's county from its ZIP), so the map pin, the volunteer search and the event area always agree.
-- site_id stays NULL for projects created before this migration; the service requires a site before such a project
-- can be submitted again. Additive: DROP the triggers, functions and column to reverse.

ALTER TABLE projects ADD COLUMN site_id uuid REFERENCES staging_sites(id);
CREATE INDEX projects_site_idx ON projects (site_id);

-- A project may only be pinned to a site of its own organization, whoever writes the row.
CREATE FUNCTION ics.project_site_same_org() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, ics AS $$
BEGIN
  IF NEW.site_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM staging_sites s WHERE s.id = NEW.site_id AND s.org_id = NEW.org_id) THEN
    RAISE EXCEPTION 'A project can only be placed at a site of its own organization' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER projects_site_same_org BEFORE INSERT OR UPDATE OF site_id, org_id ON projects
  FOR EACH ROW EXECUTE FUNCTION ics.project_site_same_org();

-- When a site moves to a ZIP in a covered county, its unfinished projects follow it. An open or paused project goes
-- back to review, exactly as when its editor changes the area. A move to an uncovered ZIP leaves projects as they are.
CREATE FUNCTION ics.site_moves_projects() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, ics AS $$
BEGIN
  IF NEW.county_id IS NOT NULL AND NEW.postal_code IS NOT NULL
     AND (NEW.county_id IS DISTINCT FROM OLD.county_id OR left(NEW.postal_code, 5) IS DISTINCT FROM left(OLD.postal_code, 5)) THEN
    UPDATE projects
       SET zip = left(NEW.postal_code, 5), county_id = NEW.county_id,
           status = CASE WHEN status IN ('OPEN','PAUSED') THEN 'PENDING_REVIEW' ELSE status END
     WHERE site_id = NEW.id AND status NOT IN ('COMPLETED','CANCELLED');
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER staging_sites_move_projects AFTER UPDATE OF postal_code, county_id ON staging_sites
  FOR EACH ROW EXECUTE FUNCTION ics.site_moves_projects();

-- 0014's definition with site_id appended.
CREATE OR REPLACE VIEW public_projects AS
SELECT p.id, p.org_id, o.display_name AS org_name, p.title, p.description,
       p.county_id, c.name AS county_name, c.state, p.zip, p.audience,
       p.reviewed_at AS opened_at,
       coalesce((SELECT sum(n.slots_needed) FROM project_needs n WHERE n.project_id = p.id), 0)::int AS total_slots,
       EXISTS (SELECT 1 FROM project_needs n WHERE n.project_id = p.id AND n.urgency = 'URGENT') AS has_urgent,
       p.site_id
  FROM projects p
  JOIN organizations o ON o.id = p.org_id
  JOIN counties c ON c.id = p.county_id
 WHERE p.status = 'OPEN' AND o.status = 'APPROVED' AND NOT o.publication_suspended;
