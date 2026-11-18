# Projects on the Map, Event Suggestions and Organization Profiles — Design

Date: 2026-11-18. Builds on `2026-11-15-events-and-projects-design.md` (this is its Stage 5, "Suggest, then confirm",
plus map placement and a fuller public profile).

## Problem (audit of the current code)

1. **Projects never reach the map.** A volunteer project stores a county and a ZIP (`projects.county_id`, `projects.zip`)
   but no location. The map only draws resource sites (`staging_sites`), and nothing ties a project to a site.
2. **Event allocation is manual.** An organization editor or county administrator must open each project and pick an
   event. `project_event_links` already has a `SUGGESTED` state, but nothing creates suggestions.
3. **Sites and projects match events differently.** Projects use `county_id` (validated against the ZIP→county table).
   Sites store county as free text and match events by comparing names (`SITE_IN_EVENT_AREA` in `events.ts`), so a
   misspelled or missing county silently drops a site from an event's Help list.
4. **The public profile is thin.** `/orgs/<id>` shows contact details, giving, counties served and a *count* of map
   locations. It does not list the locations, the organization's open projects, or the events it is responding to,
   and its back link still says "Contacts" while the menu says "Organizations".

## Decisions (confirmed with the product owner, 2026-11-18)

- **A project is pinned to one of its organization's sites.** When starting a project, the editor picks one of the
  organization's sites (or adds one first). The project's county and ZIP are taken from that site, so the map pin,
  the volunteer search and the event area always agree. Existing projects without a site keep working but must pick
  a site before they can be submitted for review again.
- **Projects show on the map through their site.** A public site's detail panel lists the open volunteer projects
  pinned to it ("Volunteers needed here"), and its list card says so. A project pinned to a non-public site still
  appears in the volunteer search and on its event page, but not on the public map. A project page links to its
  pin on the map.
- **Events: auto-suggest, a person confirms.** When a project becomes `OPEN`, when an open project's area changes, and
  when an event becomes `ACTIVE`/`RECOVERY` or its area changes, the app creates `SUGGESTED` links for every
  matching (project, event) pair that has no link row yet. Suggestions are never public. The owning organization's
  editors or the county administrator confirm (existing `CONFIRMED` path) or dismiss them. Nothing is attached without
  a person. Area rule unchanged: event ZIPs when it has any, else event counties.
- **Sites get a real county.** `staging_sites.county_id` is derived from the site's ZIP (the ZIP→county row with the
  largest land share, for a county the platform has). The free-text county stays for display. Event Help matching
  uses `county_id`, falling back to the old name match only for sites whose county could not be derived.
- **Profile layout.** Sections in this order: header (logo, name, verified, service types) · How to help (giving) ·
  Volunteer projects (open projects, urgent first) · Where we work (counties served and the public sites, each linking
  to its map pin) · Responding to (open events this organization's projects are confirmed on) · Contact and links.
  Back link reads "Organizations".

## Out of scope

Pledges (Stage 6), notifications about new suggestions, map pins styled differently for project sites, merging the
filter and map-key category lists.
