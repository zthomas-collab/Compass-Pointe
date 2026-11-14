-- 0016: expose which event a public project belongs to, so a public event page can list the current needs in its area.
-- Additive: the view keeps every existing column and adds event_id at the end. Only projects the coordinators already chose to
-- publish appear here; an event link alone never publishes anything.

CREATE OR REPLACE VIEW public_projects AS
  SELECT p.id, p.reference, p.title, p.public_summary AS summary, c.name AS county_name, c.state, p.category, p.priority, p.status,
         p.start_date, p.target_date,
         coalesce((SELECT array_agg(z.zip ORDER BY z.zip) FROM project_zips z WHERE z.project_id = p.id), '{}') AS zips,
         coalesce((SELECT jsonb_agg(jsonb_build_object(
                     'label', n.label, 'unit', n.unit, 'requested', n.quantity_requested,
                     'verified', coalesce((SELECT sum(k.qty_verified) FROM project_commitments k
                                             WHERE k.need_id = n.id AND k.status NOT IN ('DECLINED','CANCELED')), 0)) ORDER BY n.created_at)
                    FROM project_needs n WHERE n.project_id = p.id), '[]'::jsonb) AS needs,
         p.event_id
    FROM community_projects p JOIN counties c ON c.id = p.county_id
   WHERE p.visibility = 'PUBLIC' AND p.status IN ('ACTIVE','COMPLETED');
