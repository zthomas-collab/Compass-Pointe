# Projects on the Map, Event Suggestions and Organization Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An organization starts a project at one of its sites, so the project appears on the map. The app suggests the disaster events whose counties (or ZIPs) cover it, a person confirms, and the public profile lays out the organization's projects, locations and events.

**Architecture:** Two forward-only migrations: `0018_site_counties.sql` gives sites a derived `county_id`, and `0019_project_sites.sql` pins projects to a site and keeps their county/ZIP in sync with it. Service changes follow the existing module patterns: `sites.ts`, `projects.ts`, `map.ts`, `eventlinks.ts`, `events.ts` and `directory.ts` all use system context, re-derive roles inside the transaction, call `writeAudit` with ids only, and read anonymously through `public_*` views. UI changes touch the project form, the map's site panel, the dashboard project page, the admin event page and `/orgs/<id>`.

**Tech Stack:** Next.js (breaking-change version, see `AGENTS.md`), React 19, PostgreSQL 18 + PostGIS via PGlite in tests, zod, vitest.

**Spec:** `docs/superpowers/specs/2026-11-18-projects-on-map-and-event-suggestions-design.md` (and its parent `2026-11-15-events-and-projects-design.md`, Stage 5).

**Branch:** new branch from `main` (PR #10 is merged; the uncommitted header-spacing change in `src/app/layout.tsx` and `src/components/mobile-menu.tsx` is separate work and is not part of this plan).

## Global Constraints

- Follow existing patterns: RLS, `public_*` read-model views, services in `src/server/modules/`, `runIn` contexts, `writeAudit` with ids/states only, role checks re-derived inside the transaction.
- Forward-only migrations numbered `0018`, `0019`. `tests/migrations.test.ts` must still pass (apply cleanly and idempotently).
- Views can only be extended with `CREATE OR REPLACE VIEW` by **appending** columns at the end (`public_resources` depends on `public_sites`).
- `AGENTS.md`: read the relevant guide in `node_modules/next/dist/docs/` before writing page or server-action code.
- Client components must not import server modules for runtime values. Shared constants go in `src/lib/`.
- Event area rule (unchanged): if the event has ZIPs, the project's ZIP must be one of them; otherwise the project's county must be one of the event's counties.
- Suggestions are never public. `public_event_links` keeps reading `CONFIRMED` only.
- A site's derived county is the `zip_county` row with the largest `land_share` (ties: lowest `county_fips`), joined to an **active** `counties` row by `fips`. No match means `county_id` is `NULL`.
- Project county/ZIP come from its site: `zip = left(site.postal_code, 5)`, `county_id = site.county_id`. A site without a derived county, or in a county the org does not serve, cannot host a project.
- Copy: the map panel heading is "Volunteers needed here". The profile back link is "← Organizations". The section headings are "How to help", "Volunteer projects", "Where we work", "Responding to" and "Contact".

## Review Focus

1. **Site moves:** an editor changes a site's ZIP to one in another county. Linked open projects should follow it (new county/ZIP, back to `PENDING_REVIEW` if open, same as editing a project's area), and confirmed links that no longer fit drop off the public event page at read time. (Task 2)
2. **Site archived or made private:** the project must disappear from the public map but stay in the volunteer search, and submitting it again requires picking an active site. (Tasks 2, 3)
3. **ZIP+4 postal codes** (`28778-1234`) on sites must derive the county and project ZIP from the first five digits. (Tasks 1, 2)
4. **Duplicate suggestions:** re-approving a project or re-saving an event's area must not duplicate rows or resurrect a dismissed link. (Task 4)
5. **Cross-org pinning:** an editor must not be able to pin a project to another organization's site by posting its id. (Task 2)

---

### Task 1: Sites get a derived county

**Files:**
- Create: `db/migrations/0018_site_counties.sql`
- Modify: `src/server/modules/sites.ts` (`createSite`, `updateSite`; `SiteRow`/editor reads gain `countyId`)
- Modify: `src/server/modules/events.ts:274-279` (`SITE_IN_EVENT_AREA`)
- Test: `tests/site-county.test.ts`

**Interfaces:**
- Produces: column `staging_sites.county_id uuid NULL REFERENCES counties(id)`; `public_sites.county_id` appended; SQL function `ics.county_for_zip(p_zip text) RETURNS uuid` (STABLE; uses the rule in Global Constraints; accepts ZIP+4).

- [ ] **Step 1: Write the failing tests** in `tests/site-county.test.ts` (fixtures: `freshDb`, `makeOrg`, `makeUser`, `site`; Buncombe NC county created with its FIPS `37021`, as `tests/projects.test.ts` does):
  - `derives county_id from the ZIP on create`: `createSite(... site({ postalCode: "28778" }))` → row's `county_id` equals the Buncombe id.
  - `uses the first five digits of a ZIP+4`: `postalCode: "28778-1234"` → Buncombe id.
  - `leaves county_id null for a ZIP the platform has no county for`: `postalCode: "29801"` with no Aiken county → `null`.
  - `re-derives on update`: update to a ZIP in another created county → new id.
  - `event Help matches by county_id even when the typed county name is wrong`: site with `county: "Bunkum"`, ZIP `28778`, event on Buncombe → `getEventHelp` includes it.
  - `falls back to the name match when county_id is null`: same as today's behavior for a site with no derivable county.
- [ ] **Step 2: Run them to see them fail.** Run: `npx vitest run tests/site-county.test.ts`. Expected: FAIL (column missing).
- [ ] **Step 3: Write `0018_site_counties.sql`.** Add the column and index `staging_sites_county_idx`, then `ics.county_for_zip`. Backfill `UPDATE staging_sites SET county_id = ics.county_for_zip(postal_code) WHERE postal_code IS NOT NULL`. Append `county_id` to `public_sites` with `CREATE OR REPLACE VIEW` (copy the current definition from `0004`, add `s.county_id` last) and re-grant as `0004` does.
- [ ] **Step 4: Set `county_id = ics.county_for_zip($postalCode)` in the INSERT/UPDATE of `createSite` and `updateSite`.**
- [ ] **Step 5: Change `SITE_IN_EVENT_AREA`'s county branch** to `CASE WHEN ps.county_id IS NOT NULL THEN EXISTS (SELECT 1 FROM event_counties ec WHERE ec.event_id = pe.id AND ec.county_id = ps.county_id) ELSE <existing name match> END`.
- [ ] **Step 6: Run** `npx vitest run tests/site-county.test.ts tests/events.test.ts tests/migrations.test.ts`. Expected: PASS.
- [ ] **Step 7: Commit** `feat(sites): derive county from ZIP; event Help matches by county`.

### Task 2: Projects are pinned to a site

**Files:**
- Create: `db/migrations/0019_project_sites.sql`
- Modify: `src/server/modules/projects.ts` (`projectSchema`, `assertProjectArea`, `createProject`, `updateProject`, `submitProject`, `PROJECT_SELECT`, `ProjectRow`, `DbPublicProject`/`PublicProject`, `toPublicProject`)
- Modify: `src/components/project-forms.tsx`, `src/app/dashboard/orgs/[orgId]/projects/new/page.tsx`, the project edit form on `src/app/dashboard/projects/[id]/page.tsx`
- Test: `tests/project-site.test.ts`

**Interfaces:**
- Consumes: `staging_sites.county_id` (Task 1).
- Produces: column `projects.site_id uuid NULL REFERENCES staging_sites(id)`; `public_projects.site_id` appended; `projectSchema` becomes `{ title, description, siteId: uuid, audience, privateLocationNotes }` (`countyId`/`zip` removed from input); `ProjectRow.siteId: string | null`; `PublicProject.siteId: string | null` and `PublicProject.sitePublic: boolean`; `listProjectSites(driver, userId, orgId): Promise<{ id: string; name: string; city: string | null; zip: string | null; countyName: string | null; usable: boolean; reason: string | null }[]>` in `projects.ts`.

- [ ] **Step 1: Write the failing tests** in `tests/project-site.test.ts`:
  - `takes county and ZIP from the chosen site`: create with `siteId` of a site at ZIP `28778` → project `zip = "28778"`, `county_id` = Buncombe.
  - `refuses another organization's site`: `createProject(..., { siteId: otherOrgSite })` rejects with `VALIDATION` and field `siteId` (Review Focus 5).
  - `refuses a site without a derived county or in an unserved county`: `VALIDATION` on `siteId`, messages "This location's ZIP is not in a county we cover" / "Your organization's profile does not list this location's county as served".
  - `refuses an archived site`.
  - `follows its site when the site moves`: `updateSite` to a ZIP in another served county → project's `zip`/`county_id` updated, and an `OPEN` project becomes `PENDING_REVIEW` (Review Focus 1).
  - `keeps the first five digits of a ZIP+4 site` (Review Focus 3).
  - `submitProject requires a site for legacy projects`: a project inserted with `site_id NULL` → `submitProject` rejects with `VALIDATION` "Choose a location for this project".
  - `listProjectSites marks unusable sites with a reason`.
- [ ] **Step 2: Run** `npx vitest run tests/project-site.test.ts`. Expected: FAIL.
- [ ] **Step 3: Write `0019_project_sites.sql`.**
  - Add `site_id` and index `projects_site_idx`.
  - A `BEFORE INSERT OR UPDATE OF site_id` trigger on `projects` raises `check_violation` if the site's `org_id` differs from the project's.
  - An `AFTER UPDATE OF postal_code, county_id` trigger on `staging_sites` sets `zip = left(NEW.postal_code, 5)` and `county_id = NEW.county_id` on linked projects not in `COMPLETED`/`CANCELLED`, and moves `OPEN`/`PAUSED` ones to `PENDING_REVIEW`. It only acts when the new county is non-null; otherwise it leaves projects as they are.
  - Append `p.site_id` to `public_projects`.
- [ ] **Step 4: Implement the service changes.**
  - Replace `assertProjectArea(tx, orgId, countyId, zip)` with `resolveProjectSite(tx, orgId, siteId): Promise<{ countyId: string; zip: string }>`. It reads the site and enforces same org, `ACTIVE`, non-null `county_id` and `postal_code`, and a served county, with the messages above.
  - `createProject`/`updateProject` write the resolved values.
  - `submitProject` refuses a null `site_id`.
  - `toPublicProject` exposes `siteId` and `sitePublic`, computed from `EXISTS (SELECT 1 FROM public_sites ps WHERE ps.id = p.site_id)`.
- [ ] **Step 5: Update the UI.**
  - The project form swaps the County select and ZIP field for a "Location" select fed by `listProjectSites`. Unusable sites are disabled, with their reason shown as help text.
  - Below the select, a link reads "Add a new location" and goes to `/dashboard/orgs/<orgId>/sites/new`.
  - If the org has no usable site, show only that link and the sentence "Projects start at one of your locations. Add one first."
- [ ] **Step 6: Update the demo seed** (`scripts/cli.ts:175`, the `createProject` call): pass `siteId` of the pantry's seeded public site instead of `countyId`/`zip`. Then run `npm run db:seed` on a fresh `.data` directory. Expected: no errors.
- [ ] **Step 7: Run** `npx vitest run tests/project-site.test.ts tests/projects.test.ts tests/eventlinks.test.ts tests/volunteers.test.ts`. Update existing fixtures that pass `countyId`/`zip` so they create a site and pass `siteId`. Expected: PASS.
- [ ] **Step 8: Commit** `feat(projects): pin projects to a site; county and ZIP follow the site`.

### Task 3: Projects show on the map

**Files:**
- Modify: `src/server/modules/map.ts` (`MapSite`, both queries, `toSite`)
- Modify: `src/components/ResourceMap.tsx` (`SiteDetail`, list card, initial site from props)
- Modify: `src/app/page.tsx` (read `?site=<id>`)
- Modify: `src/app/volunteer/projects/[id]/page.tsx` (link to the pin)
- Test: extend `tests/give-money.test.ts`'s map block into new `tests/map-projects.test.ts`

**Interfaces:**
- Consumes: `public_projects.site_id` (Task 2).
- Produces: `MapSite.projects: { id: string; title: string; hasUrgent: boolean; spotsLeft: number }[]`, read from `public_projects`/`public_project_needs` for both public and signed-in queries; `ResourceMap` prop `initialSite?: { id: string; lat: number; lng: number } | null`; `getPublicSitePin(driver, siteId): Promise<{ id: string; lat: number; lng: number } | null>` in `map.ts`.

- [ ] **Step 1: Write the failing tests.**
  - `a public site lists its open projects, urgent first`.
  - `draft, pending, paused and suspended-org projects are not listed`.
  - `a project at a private site is absent from the public map but present in searchProjects` (Review Focus 2).
  - `getPublicSitePin returns null for a private or archived site`.
- [ ] **Step 2: Run** `npx vitest run tests/map-projects.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the map query changes** with one extra query per map request, keyed by site ids (no per-site N+1). Implement `getPublicSitePin`.
- [ ] **Step 4: Update the UI.**
  - `SiteDetail` shows a "Volunteers needed here" section when `projects.length > 0`. Each entry links to `/volunteer/projects/<id>`, shows an Urgent badge, and shows "N spots left" or "Full".
  - The list card gets a "Volunteers needed" badge.
  - `page.tsx` passes `initialSite` from `getPublicSitePin(searchParams.site)`, and the map centers there and opens that site.
  - The project page shows "See it on the map" (`/?site=<siteId>`) when `sitePublic`.
- [ ] **Step 5: Run** `npx vitest run tests/map-projects.test.ts tests/give-money.test.ts`, then check in the browser at 375px and desktop width. Expected: PASS; the panel shows the project and the deep link opens it.
- [ ] **Step 6: Commit** `feat(map): show open volunteer projects on their site`.

### Task 4: Suggest events, a person confirms

**Files:**
- Modify: `src/server/modules/eventlinks.ts` (new functions below)
- Modify: `src/server/modules/projects.ts` (call after approve and after an area change while `OPEN`)
- Modify: `src/server/modules/events.ts` (call after create/update/status change to `ACTIVE`/`RECOVERY`)
- Modify: `src/app/dashboard/projects/[id]/page.tsx`, `src/app/admin/events/[id]/page.tsx`, `src/components/event-link-forms.tsx`, and their actions
- Test: `tests/event-suggestions.test.ts`

**Interfaces:**
- Produces:
  - `suggestForProject(tx: Tx, projectId: string): Promise<number>` and `suggestForEvent(tx: Tx, eventId: string): Promise<number>`. Both insert `SUGGESTED` rows (`suggested_by NULL`) with `ON CONFLICT DO NOTHING`, only for `OPEN` projects and `ACTIVE`/`RECOVERY` events inside the area, and return the number inserted.
  - `listSuggestions(driver, userId, scope: { projectId: string } | { eventId: string }): Promise<{ projectId: string; projectTitle: string; orgName: string; eventId: string; eventName: string; eventSlug: string }[]>`. It shows only pairs the user may decide (same `decisionRole` rule) that are still inside the area.
  - `dismissSuggestion(driver, userId, projectId, eventId): Promise<void>`. It moves `SUGGESTED` to `DISMISSED` with the decision recorded.
  - Confirming reuses `linkProjectToEvent`, which already upserts.

- [ ] **Step 1: Write the failing tests.**
  - `approving a project suggests every active or recovery event covering its county`.
  - `a ZIP-narrowed event suggests only projects in its ZIPs`.
  - `activating a draft event suggests existing open projects`.
  - `re-running never duplicates and never revives a dismissed link` (Review Focus 4).
  - `suggestions are not public`: `listEventProjects` excludes them.
  - `the org editor and the county admin see and confirm; another org's editor and another county's admin do not`.
  - `confirm makes it public; dismiss hides it from listSuggestions`.
  - `a suggestion for a project that moved out of the area is not listed`.
- [ ] **Step 2: Run** `npx vitest run tests/event-suggestions.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the four functions** and call them inside the same transactions as `reviewProject` (on `APPROVE`), `updateProject`/the site-move path (when the project ends `OPEN`), `createEvent`, `updateEvent` and `setEventStatus` (to `ACTIVE`/`RECOVERY`). Audit `EVENT_LINKS_SUGGESTED` with `{ count }` and `EVENT_SUGGESTION_DISMISSED`.
- [ ] **Step 4: Update the UI.**
  - The dashboard project page gets a "Suggested events" list above the existing link picker, with **Add to event** and **Not this one** buttons.
  - The admin event page gets "Suggested projects" with the same two buttons.
  - Both show nothing when the list is empty.
- [ ] **Step 5: Run** `npx vitest run tests/event-suggestions.test.ts tests/eventlinks.test.ts tests/events.test.ts tests/projects.test.ts`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(events): suggest events for projects in their area; confirm or dismiss`.

### Task 5: Organization profile layout

**Files:**
- Modify: `src/server/modules/directory.ts` (new function)
- Modify: `src/app/orgs/[orgId]/page.tsx`
- Test: `tests/org-profile.test.ts`

**Interfaces:**
- Consumes: `PublicProject` (Tasks 2–3), `public_event_links`.
- Produces: `getPublicOrganizationActivity(driver: Driver, orgId: string): Promise<{ sites: { id: string; name: string; city: string | null; state: string | null }[]; projects: PublicProject[]; events: { name: string; slug: string; status: "ACTIVE" | "RECOVERY" }[] }>`. Anonymous reads through public views only. Projects are ordered urgent first, then by title. Events are distinct open events with at least one confirmed, public link to this org's projects.

- [ ] **Step 1: Write the failing tests.**
  - `lists only public sites, open projects and open events with confirmed links`.
  - `excludes a closed event, a dismissed or suggested link, and a private site`.
  - `returns empty lists for an unknown or non-public organization`.
- [ ] **Step 2: Run** `npx vitest run tests/org-profile.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `getPublicOrganizationActivity`.**
- [ ] **Step 4: Rework `/orgs/[orgId]/page.tsx`** into the spec's section order and headings (Global Constraints copy), widen it to `max-w-5xl` with a two-column grid at `lg`, and make each section render only when it has content.
  - Sites link to `/?site=<id>`.
  - Projects link to `/volunteer/projects/<id>` and show spots left.
  - Events link to `/events/<slug>`.
  - The back link becomes "← Organizations".
- [ ] **Step 5: Run** `npx vitest run tests/org-profile.test.ts tests/giving-pages.test.ts`, then check the page in the browser at 375px and desktop width. Expected: PASS; no horizontal scroll.
- [ ] **Step 6: Commit** `feat(orgs): profile shows projects, locations and events`.

### Final check

- [ ] Run `npm run check` (lint, typecheck, all tests). Expected: no errors; all tests pass.
- [ ] Re-seed locally (`npm run db:seed`) and walk the flow in the browser:
  1. An org editor adds a site, starts a project there and submits it.
  2. An admin approves it, and a suggestion appears for the demo event.
  3. The org confirms the suggestion.
  4. The project shows on the map panel, on the event page and on the org profile.
- [ ] Update `docs/04-journeys-sitemap.md` with the new org journey (site → project → suggestion → confirm).
