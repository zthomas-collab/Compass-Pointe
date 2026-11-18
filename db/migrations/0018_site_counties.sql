-- 0018: a site's county comes from its ZIP.
--
-- Projects already use counties(id) (validated against zip_county); sites stored county as free text and were matched
-- to event areas by name, so a typo dropped a site from an event's Help list. staging_sites.county_id is derived from
-- the site's ZIP: the zip_county row with the largest land share (ties: lowest FIPS), if that county is an ACTIVE
-- platform county.
-- No match leaves it NULL, and event matching then falls back to the old name comparison. The free-text county stays
-- for display. Additive: DROP the column and function to reverse (public_sites would need its 0004 definition back).

ALTER TABLE staging_sites ADD COLUMN county_id uuid REFERENCES counties(id);
CREATE INDEX staging_sites_county_idx ON staging_sites (county_id);

-- Accepts a 5-digit ZIP or ZIP+4; anything else yields NULL. The ZIP's main county is chosen first and used only if
-- the platform has it: a ZIP that is 98% in an uncovered county never lands in a covered neighbor's 2% sliver.
CREATE FUNCTION ics.county_for_zip(p_zip text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, ics AS $$
  SELECT c.id
    FROM (SELECT z.county_fips FROM zip_county z
           WHERE p_zip ~ '^[0-9]{5}(-[0-9]{4})?$' AND z.zip = left(p_zip, 5)
           ORDER BY z.land_share DESC, z.county_fips
           LIMIT 1) main
    JOIN counties c ON c.fips = main.county_fips AND c.active
$$;
REVOKE ALL ON FUNCTION ics.county_for_zip(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ics.county_for_zip(text) TO ics_app;

UPDATE staging_sites SET county_id = ics.county_for_zip(postal_code) WHERE postal_code IS NOT NULL;

-- Adding a county, giving it a FIPS code, or (de)activating it re-derives the sites whose ZIPs touch it, so sites created
-- before their county was on the platform pick it up (and lose it again if it is deactivated).
CREATE FUNCTION ics.county_changes_sites() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, ics AS $$
DECLARE fips_list text[];
BEGIN
  fips_list := array_remove(ARRAY[NEW.fips, CASE WHEN TG_OP = 'UPDATE' THEN OLD.fips END], NULL);
  IF cardinality(fips_list) > 0 THEN
    UPDATE staging_sites s SET county_id = ics.county_for_zip(s.postal_code)
     WHERE s.postal_code IS NOT NULL
       AND left(s.postal_code, 5) IN (SELECT z.zip FROM zip_county z WHERE z.county_fips = ANY (fips_list))
       AND s.county_id IS DISTINCT FROM ics.county_for_zip(s.postal_code);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER counties_rederive_sites AFTER INSERT OR UPDATE OF fips, active ON counties
  FOR EACH ROW EXECUTE FUNCTION ics.county_changes_sites();

-- 0004's definition with county_id appended (a view can only gain columns at the end).
CREATE OR REPLACE VIEW public_sites AS
SELECT s.id, s.org_id, o.display_name AS org_name, o.org_type,
       s.name, s.description,
       ST_Y(s.location::geometry) AS lat, ST_X(s.location::geometry) AS lng,
       s.address_line, s.city, s.county, s.state, s.postal_code, s.hours_text, s.public_phone,
       s.last_confirmed_at, s.updated_at, (s.is_synthetic OR o.is_synthetic) AS is_synthetic,
       s.location,
       o.primary_service_type AS service_type, st.label AS service_label,
       st.short_label AS service_short, st.color AS service_color,
       img.id AS image_id, img.alt_text AS image_alt,
       s.county_id
  FROM staging_sites s
  JOIN organizations o ON o.id = s.org_id
  JOIN service_types st ON st.code = o.primary_service_type
  LEFT JOIN site_images img ON img.site_id = s.id AND img.status = 'ACTIVE' AND img.scan_status IN ('NOT_SCANNED','CLEAN')
 WHERE s.visibility = 'PUBLIC' AND s.status = 'ACTIVE'
   AND o.status = 'APPROVED' AND NOT o.publication_suspended;

GRANT SELECT ON public_sites TO ics_anon, ics_app;
