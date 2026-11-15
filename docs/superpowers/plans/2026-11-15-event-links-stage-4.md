# Event–Project Links (Stage 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A nonprofit can attach its project to a disaster event whose area contains it; the public event page then shows a real **Needs** list (open projects and their volunteer roles with spots left) next to the existing **Help** list, and a project page shows which events it belongs to.

**Architecture:** One forward-only migration (`0016_event_links.sql`) adds `project_event_links` (states `SUGGESTED`, `CONFIRMED`, `DISMISSED`; this stage only creates `CONFIRMED` and `DISMISSED`) and a `public_event_links` view that re-checks everything at read time. A new service module `src/server/modules/eventlinks.ts` follows `projects.ts` / `volunteers.ts` (system context, role checks re-derived inside the transaction, `writeAudit` with ids only, anon reads through public views). Existing public helpers in `projects.ts` are exported and reused. The suggestion list and confirm/dismiss-a-suggestion UI are **Stage 5** and are not built here.

**Tech Stack:** Next.js (breaking-change version, see constraints), React 19, PostgreSQL/PostGIS via PGlite in tests, zod, vitest.

**Branch:** `event-links-stage-4`, created from `main` (PRs #4, #5 and #6 are merged; migration `0016` follows `0015`).

**Spec:** `docs/superpowers/specs/2026-11-15-events-and-projects-design.md` (Stage 4 of its six delivery stages).

## Global Constraints

- Follow existing patterns: RLS and SECURITY DEFINER helpers, `public_*` read-model views, services in `src/server/modules/`, `writeAudit`, `runIn` contexts, role checks re-derived inside the transaction (never from the client or session cache).
- Forward-only, expand/contract migrations. This stage's migration is `0016`.
- `AGENTS.md`: this Next.js has breaking changes. Read the relevant guide in `node_modules/next/dist/docs/` before writing page or server-action code.
- Client components must not import server modules for runtime values; shared constants go in `src/lib/`.
- Accessibility parity with the map: status shown by icon + text + color; axe clean.
- Tests run on real PostGIS (PGlite) via `freshDb()`; each stage ships authorization, county-isolation and privacy tests.
- **A project can link to several events** (overlapping disasters are allowed). A link is only valid if the project lies **inside the event's area**: when the event has ZIPs, the project's ZIP must be one of them; otherwise the project's county must be one of the event's counties (the same rule the Help list uses).
- New links may only target events whose status is `ACTIVE` or `RECOVERY` (never `DRAFT` or `CLOSED`) and projects that are not `COMPLETED` or `CANCELLED`.
- **Who may link or unlink:** an `ORG_ADMIN` or `EDITOR` of the project's owning, approved, non-suspended organization (decision recorded as `ORG`), or an administrator of the project's county or an executive (recorded as `ADMIN`). A user who is both an org editor of the project's org and a county administrator is treated as `ORG`. A link that an `ADMIN` dismissed cannot be re-attached by an `ORG` decision; an `ADMIN` can restore it.
- **Public reads re-check at read time:** the public Needs list shows a link only when the link is `CONFIRMED`, the event is not `DRAFT`, the project is `OPEN` with an approved, non-suspended org, and the project is still inside the event's area *now*. Editing a project's county/ZIP or an event's area therefore takes effect immediately without rewriting links.
- A closed event stays public as an archive and shows no Needs list. Public counts come only from real rows (spots left from sign-ups). Public pages never expose a volunteer's data, private location notes, or instructions.
- Audit rows hold ids and states only.

## Review Focus

1. A link is refused when the project is outside the event's area (county-only event, ZIP-narrowed event, wrong state's same-named county), when the event is `DRAFT` or `CLOSED`, or when the project is `COMPLETED` or `CANCELLED`. (Task 1)
2. Another org's editor, an org `VIEWER`, a county administrator of a *different* county, and a plain user cannot link or unlink; an `ADMIN`-dismissed link cannot be re-attached by the org. (Task 1)
3. The public event Needs list never includes a draft, pending, paused or completed project, a suspended org's project, a dismissed link, or a project that is now outside the event's area (after the project's ZIP/county changed, or the event's area was edited), and never any private field. (Task 3)
4. A closed event shows no Needs list but its links survive; spots left on the event page match the sign-up counts exactly. (Tasks 3, 4)
5. Editor-side reads never reveal links or events to people who cannot see the project, and a public project page never lists a draft event. (Tasks 2, 3)

---

### Task 1: Schema, link, and unlink

**Files:**
- Create: `db/migrations/0016_event_links.sql`
- Create: `src/server/modules/eventlinks.ts`
- Test: `tests/eventlinks.test.ts`

**Interfaces:**
- Produces (SQL): `project_event_links (project_id FK projects, event_id FK events, state text CHECK IN ('SUGGESTED','CONFIRMED','DISMISSED'), suggested_by uuid FK users NULL, decided_by uuid FK users NULL, decided_by_role text NULL CHECK IN ('ORG','ADMIN'), decided_at timestamptz NULL, created_at, updated_at (with `ics.touch_updated_at()`), PRIMARY KEY (project_id, event_id))`, `CHECK (state = 'SUGGESTED' OR (decided_by IS NOT NULL AND decided_by_role IS NOT NULL AND decided_at IS NOT NULL))`, an index on `(event_id, state)`; RLS enabled and no grants to request roles.
- Produces (`eventlinks.ts`):
  - `export async function linkProjectToEvent(driver: Driver, userId: string, projectId: string, eventId: string): Promise<void>` (idempotent when already `CONFIRMED`)
  - `export async function unlinkProjectFromEvent(driver: Driver, userId: string, projectId: string, eventId: string): Promise<void>` (`CONFIRMED` → `DISMISSED`; idempotent when already `DISMISSED`; `NOT_FOUND` when there is no link)
- Consumes: `loadAccess`, `canManageCounty` (`access.ts`); `membershipRole` (`directory.ts`); `writeAudit` (`shared.ts`); `parseOrThrow` (`identity.ts`); `fromDbError`; `runIn`. Tests reuse the setup style of `tests/projects.test.ts` and `tests/events.test.ts`: executive, counties Buncombe NC (fips 37021) and Henderson NC (fips 37089), an approved org serving Buncombe with an `ORG_ADMIN`, an `EDITOR`, a `VIEWER`, a second org, county administrators for each county, events created and activated through `createEvent`/`setEventStatus`, projects created through `createProject` (a small local helper is fine; do not refactor existing tests).

- [ ] **Step 1: Write failing tests** in `tests/eventlinks.test.ts`:
  - `it("links an org's project to an active event covering its county, records who decided, and audits it")`: after `linkProjectToEvent` by the `EDITOR`, the row is `CONFIRMED` with `decided_by_role = 'ORG'` and `decided_by` = the editor; an `audit_logs` row `EVENT_PROJECT_LINKED` exists whose `details` JSON contains no name or email; calling it again succeeds without a second row.
  - `it("allows a recovery event and several events per project, and rejects draft and closed events")` (Review Focus 1): one project linked to two active events and one `RECOVERY` event; a `DRAFT` and a `CLOSED` event each throw `VALIDATION`; no row is created by the failures.
  - `it("only links a project that lies inside the event's area")` (Review Focus 1): a Henderson project cannot link to a Buncombe-only event (`VALIDATION`); with an event whose ZIPs are set to `28801`, a Buncombe project in ZIP `28806` is refused and one in `28801` is accepted; an event listing Buncombe SC (create county `Buncombe`/`SC`) does not accept a Buncombe NC project.
  - `it("refuses completed and cancelled projects")` (Review Focus 1): `VALIDATION` for each; `DRAFT`, `PENDING_REVIEW`, `OPEN` and `PAUSED` projects can be linked.
  - `it("refuses other orgs, viewers, other counties' administrators, and the public")` (Review Focus 2): the second org's admin, the org `VIEWER`, the Henderson county administrator and a plain user each get `FORBIDDEN` from both `linkProjectToEvent` and `unlinkProjectFromEvent`; unknown project or event ids give `NOT_FOUND`.
  - `it("lets the county's administrator and an executive link and unlink with an ADMIN decision")`: the Buncombe administrator links; the row records `decided_by_role = 'ADMIN'`; the executive unlinks it; a user who is both an org editor of the project's org and a Buncombe administrator is recorded as `ORG`.
  - `it("unlinks to DISMISSED, is idempotent, and lets the org re-attach its own dismissal")`: after unlink the row is `DISMISSED`; unlinking again succeeds; the editor can link again (`CONFIRMED`).
  - `it("does not let the org re-attach a link an administrator dismissed")` (Review Focus 2): the county administrator unlinks; the org editor's `linkProjectToEvent` throws `FORBIDDEN` and the row stays `DISMISSED`; the county administrator can restore it.
  - `it("unlinking something that was never linked is NOT_FOUND")`.
  - `it("hides links from request roles at the database")`: `runIn(db, {kind:"anon"}, tx => tx.query("SELECT * FROM project_event_links"))` rejects with code `42501`.

- [ ] **Step 2: Run to verify failure.** Run: `npx vitest run tests/eventlinks.test.ts`. Expected: FAIL (module `@/server/modules/eventlinks` not found).

- [ ] **Step 3: Write `db/migrations/0016_event_links.sql`** as described under Interfaces, following the comment style of `0014`/`0015`. Do not create the public view yet (Task 3).

- [ ] **Step 4: Implement `linkProjectToEvent` and `unlinkProjectFromEvent`.** One `system` transaction each: load the project (`SELECT ... FOR UPDATE`) joined to its org (status, suspension) and county; load the event; derive the actor's decision role inside the transaction (org editor of the owning org → `ORG`, which also requires the org to be approved and not suspended; else `canManageCounty` for the project's county → `ADMIN`; else `FORBIDDEN`). For linking, validate event status, project status and the area rule (share one SQL helper `projectInEventArea(tx, projectId, eventId): Promise<boolean>` with Task 3's view logic in mind: ZIPs set → project ZIP in `event_zips`; otherwise project county in `event_counties`). Upsert the link: an existing `CONFIRMED` row is a no-op; an existing `DISMISSED` row with `decided_by_role = 'ADMIN'` may only be flipped by an `ADMIN` decision. Audit `EVENT_PROJECT_LINKED` / `EVENT_PROJECT_UNLINKED` with `{ projectId, eventId, role }`.

- [ ] **Step 5: Run to verify pass.** Run: `npx vitest run tests/eventlinks.test.ts tests/migrations.test.ts`. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add db/migrations/0016_event_links.sql src/server/modules/eventlinks.ts tests/eventlinks.test.ts
git commit -m "feat(event-links): project_event_links schema, link, and unlink"
```

---

### Task 2: Editor reads

**Files:**
- Modify: `src/server/modules/eventlinks.ts`
- Test: `tests/eventlinks.test.ts`

**Interfaces:**
- Consumes: Task 1 exports and `projectInEventArea`.
- Produces:
  - `export type ProjectEventLink = { eventId: string; eventName: string; eventSlug: string; eventStatus: EventStatus; state: "CONFIRMED" | "DISMISSED"; inArea: boolean; canUnlink: boolean; canRelink: boolean }`
  - `export async function listProjectEventLinks(driver: Driver, userId: string, projectId: string): Promise<ProjectEventLink[]>` (same audience as `getProjectForEditor`: members of the owning org, administrators of the project's county, executives; anyone else gets `[]`). `inArea` is evaluated now. `canUnlink` is true for a `CONFIRMED` link when the reader may decide (org editor of an approved org, county administrator, executive). `canRelink` is true for a `DISMISSED` link when the reader's decision role may flip it (an org editor only if the dismissal was `ORG`).
  - `export type LinkableEvent = { id: string; name: string; slug: string; status: EventStatus }`
  - `export async function listLinkableEvents(driver: Driver, userId: string, projectId: string): Promise<LinkableEvent[]>` (events the reader could link this project to right now: `ACTIVE`/`RECOVERY`, area contains the project, no `CONFIRMED` link yet, and the reader may decide; `[]` for anyone else or for a completed/cancelled project; newest start first)

- [ ] **Step 1: Write failing tests:**
  - `it("lists a project's links with area, status, and what the reader may do")`: after two links and one admin dismissal, `listProjectEventLinks` for the org editor shows `CONFIRMED` rows with `canUnlink: true`, the admin-dismissed row with `canRelink: false`; for the Buncombe administrator the same rows show `canRelink: true`; for an org `VIEWER` `canUnlink` is false everywhere.
  - `it("flags a link whose project has moved outside the event area")` (Review Focus 3, 5): after the project's ZIP is changed with a `system` UPDATE to one outside a ZIP-narrowed event, that link shows `inArea: false`.
  - `it("shows nothing to people who cannot see the project")` (Review Focus 5): the other org's admin, the Henderson administrator and a plain user get `[]` from both functions.
  - `it("offers only events the project can actually be linked to")`: draft, closed, out-of-area and already-linked events are absent; a recovery event is present; a completed project gets `[]`; the org `VIEWER` gets `[]`.

- [ ] **Step 2: Run to verify failure.** Run: `npx vitest run tests/eventlinks.test.ts -t "lists a project|flags a link|shows nothing|offers only"`. Expected: FAIL.

- [ ] **Step 3: Implement the two functions** (reuse the actor-role derivation from Task 1; factor it into one helper used by link, unlink and both reads).

- [ ] **Step 4: Run to verify pass.** Run: `npx vitest run tests/eventlinks.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/modules/eventlinks.ts tests/eventlinks.test.ts
git commit -m "feat(event-links): editor reads of a project's event links"
```

---

### Task 3: Public view and public reads

**Files:**
- Modify: `db/migrations/0016_event_links.sql` (add the view; the migration is unreleased on this branch)
- Modify: `src/server/modules/projects.ts` (export `publicNeeds`, `toPublicProject` and the `DbPublicProject` shape the new function needs)
- Modify: `src/server/modules/eventlinks.ts`
- Test: `tests/eventlinks.test.ts`

**Interfaces:**
- Produces (SQL): view `public_event_links (event_id, project_id)` selecting the confirmed links that pass **every** public check at read time: `state = 'CONFIRMED'`, the event is in `public_events` (not `DRAFT`), the project is in `public_projects` (OPEN, approved non-suspended org), and the project is inside the event's area now (ZIPs set → project ZIP in the event's ZIPs; otherwise project county in the event's counties). It exposes only the two ids. `GRANT SELECT ... TO ics_anon, ics_app`.
- Produces (`eventlinks.ts`):
  - `export async function listEventProjects(driver: Driver, eventId: string): Promise<PublicProject[]>` (anon; `[]` for an unknown id, a `DRAFT` event or a `CLOSED` event; each project carries its public needs with `spotsLeft`; ordered: projects with an urgent need first, then the soonest upcoming shift, then title)
  - `export async function listPublicProjectEvents(driver: Driver, projectId: string): Promise<{ id: string; name: string; slug: string; status: EventStatus }[]>` (anon; the non-draft events this project is publicly linked to; `[]` unless the project is publicly visible; closed events are included so a project page can say it was part of an archived event)
- Consumes: `PublicProject`, `PublicNeed` (`projects.ts`), `public_events`, `public_projects`.

- [ ] **Step 1: Write failing tests:**
  - `it("lists open, approved projects linked to an active event, with real spots left and no private fields")` (Review Focus 3): an `OPEN` linked project appears with its needs; after confirming one volunteer, the need's `spotsLeft` drops by one; `JSON.stringify` of the result contains none of the private location notes, instructions, or a volunteer's name or email.
  - `it("leaves out drafts, pending, paused and completed projects, suspended orgs, and dismissed links")` (Review Focus 3): each is absent; restoring (re-approving, resuming, unsuspending, re-linking) brings it back.
  - `it("drops a project the moment it is outside the event's area")` (Review Focus 3): changing the project's ZIP (via `updateProject`, then re-approving) to one outside a ZIP-narrowed event removes it; editing the event's area to exclude the project's county removes it; restoring the area brings it back, with no change to the link rows.
  - `it("returns nothing for a draft or closed event, and keeps the links when an event closes")` (Review Focus 4): closing the event empties `listEventProjects` while `project_event_links` still holds the `CONFIRMED` row.
  - `it("orders urgent projects first, then the soonest shift")`.
  - `it("lists a project's public events and never a draft event")` (Review Focus 5): `listPublicProjectEvents` shows active, recovery and closed events but not a draft one (force a link to a draft via a `system` INSERT to prove the view, not the service, hides it); returns `[]` for a project that is not publicly visible.
  - `it("exposes only ids in the public view")`: the column list of `public_event_links` is exactly `event_id, project_id`.

- [ ] **Step 2: Run to verify failure.** Run: `npx vitest run tests/eventlinks.test.ts -t "open, approved|leaves out|outside the event|draft or closed event|orders urgent|public events|only ids"`. Expected: FAIL.

- [ ] **Step 3: Add the view, export the `projects.ts` helpers, implement both functions.** Reads touch only the public views (`public_event_links`, `public_projects`, `public_project_needs`, `public_events`); never query `projects` or `project_event_links` as anon.

- [ ] **Step 4: Run to verify pass.** Run: `npx vitest run tests/eventlinks.test.ts tests/projects.test.ts tests/events.test.ts tests/migrations.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add db/migrations/0016_event_links.sql src/server/modules/projects.ts src/server/modules/eventlinks.ts tests/eventlinks.test.ts
git commit -m "feat(event-links): public event needs and a project's public events"
```

---

### Task 4: Screens

**Files:**
- Modify: `src/app/events/[slug]/page.tsx` (replace the Needs placeholder)
- Modify: `src/app/projects/[id]/page.tsx` (an "Part of these events" line)
- Modify: `src/app/dashboard/projects/[id]/page.tsx` (an Events section), `src/app/dashboard/projects/actions.ts` (`linkEventAction`, `unlinkEventAction`)
- Create: `src/components/event-link-forms.tsx`

**Interfaces:**
- Consumes: `listEventProjects`, `listPublicProjectEvents`, `listProjectEventLinks`, `listLinkableEvents`, `linkProjectToEvent`, `unlinkProjectFromEvent`, `ActionButton` (`project-forms.tsx`), `EventStatusBadge`.
- Produces: server actions `linkEventAction(projectId: string, prev, form): Promise<FormState>` (reads `eventId` from the form) and `unlinkEventAction(projectId: string, eventId: string): Promise<FormState>` (bound as `(projectId, eventId)`; ignores React's extra arguments); component `LinkEventForm`.

- [ ] **Step 1: Read the Next.js guides** for dynamic params and server actions, then the existing event page, project page and project editor, and match them.
- [ ] **Step 2: Event page.** For `ACTIVE` and `RECOVERY` events show **Needs** from `listEventProjects`: a short line ("N projects, M volunteer spots left" computed from the rows), then project cards (title linking to `/projects/<id>`, organization, county and ZIP, an urgent badge when any need is urgent, each need with its shift in Eastern Time, "X of Y spots left" or "Full"). Empty state: "No volunteer projects are linked to this event yet." For a `CLOSED` event show "This event is closed. Its volunteer projects are no longer listed." in place of Needs. Remove the placeholder text.
- [ ] **Step 3: Public project page.** Under the header, when `listPublicProjectEvents` is non-empty, show "Part of: <event links>" using `Link`.
- [ ] **Step 4: Project editor Events section.** For readers who may see the project: the linked events with status badge, an "outside this event's area now" note when `inArea` is false, and an **Remove from this event** button where `canUnlink` (and **Restore** where `canRelink`); and, where `listLinkableEvents` is non-empty, a select of events with an **Attach to event** button. A short note explains that attaching shows the project on that event's public page once it is open, and that a county administrator can remove a project that does not belong.
- [ ] **Step 5: Verify.** Run: `npm run typecheck && npm run lint`. Expected: no new errors.
- [ ] **Step 6: Commit**

```bash
git add src/app src/components/event-link-forms.tsx
git commit -m "feat(event-links): event Needs list, project events, and editor controls"
```

---

### Task 5: Docs, full check, live check

**Files:**
- Modify: `README.md`, `docs/09-crisis-compass-upgrade-plan.md`, `docs/10-gap-analysis.md`, `docs/04-journeys-sitemap.md`

- [ ] **Step 1: Update docs:** README (an Event–project links section; correct the test count from the real run), `docs/10` (events row: the Needs list is done; remaining: suggestions in stage 5; project row: event links done), `docs/09` (`project_event_links` shipped in `0016`), `docs/04` (the event page now lists Needs; the editor's Events section).
- [ ] **Step 2: Run the full check.** Run: `npm run check && npm run build`. Expected: lint, typecheck and every test pass (the existing 266 plus the new link tests) and the build succeeds.
- [ ] **Step 3: Live check** against the local server: stop the dev server first (the local database is single-process), run `npm run db:migrate` so `0016` is applied, restart the server, and confirm `/events`, `/events/<slug>` and `/projects/<id>` return 200 and the event page shows the Needs section (empty state is correct for seeded data). If a signed-in browser is available, link a project and see it appear on the event page; otherwise state that this was not verified.
- [ ] **Step 4: Commit**

```bash
git add README.md docs
git commit -m "docs: event-project links (stage 4)"
```
