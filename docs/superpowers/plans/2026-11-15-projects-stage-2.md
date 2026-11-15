# Projects with People Needs (Stage 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verified nonprofits can post local, need-based **projects** made of **people needs** (volunteer roles and shifts); a county administrator or executive approves them; the public can browse and search them at `/projects`.

**Architecture:** One forward-only migration (`0014_projects.sql`) adds `projects`, `project_needs` and two public views. A service module `src/server/modules/projects.ts` follows the `directory.ts` / `events.ts` pattern (zod input, `runIn` with `system` context, role checks re-derived inside the transaction, `writeAudit`, anon reads through public views only). Org editors work in the dashboard, reviewers in `/admin/projects`, the public in `/projects`. Volunteer sign-up, filled-slot counts, event links and goods needs are **later stages** and are not built here.

**Tech Stack:** Next.js (breaking-change version, see constraints), React 19, PostgreSQL/PostGIS via PGlite in tests, zod, vitest.

**Branch:** create `projects-stage-2` from `events-stage-1` (migration `0014` follows `0013`). If PR #4 has merged, branch from `main` instead.

**Spec:** `docs/superpowers/specs/2026-11-15-events-and-projects-design.md` (Stage 2 of its six delivery stages).

## Global Constraints

- Follow existing patterns: RLS and SECURITY DEFINER helpers, `public_*` read-model views, services in `src/server/modules/`, audit events via `writeAudit`, `runIn` contexts, role checks re-derived inside the transaction (never from the client or session cache).
- Forward-only, expand/contract migrations. This stage's migration is `0014`.
- `AGENTS.md`: this Next.js has breaking changes. Read the relevant guide in `node_modules/next/dist/docs/` before writing page or server-action code.
- Client components must not import server modules for runtime values; put shared constants in `src/lib/`.
- Accessibility parity with the map: status shown by icon + text + color; axe clean.
- Tests run on real PostGIS (PGlite) via `freshDb()`; each stage ships authorization, county-isolation and privacy tests.
- Public pages never expose a person's name, home address or request. A project's public location is **ZIP and county only**; the exact address is stored privately and never appears in any public view or query.
- Projects never store citizen identity and never link to `assistance_applications`.
- A project needs county-administrator or platform-admin approval before it is public. A project's public counts come only from real rows; Stage 2 shows slots **needed**, never "filled".
- Project statuses are exactly `DRAFT`, `PENDING_REVIEW`, `OPEN`, `PAUSED`, `COMPLETED`, `CANCELLED`. Audiences: `COMMUNITY`, `ORG_FACILITY`, `HOUSEHOLD_GENERALIZED`.

## Review Focus

1. Editing an `OPEN` or `PAUSED` project's content (fields or needs) returns it to `PENDING_REVIEW` and it disappears from the public until re-approved; status-only changes do not. (Tasks 2, 3)
2. `private_location_notes` never appears in any public view, search, or detail result. (Task 4)
3. An org `VIEWER`, a member of another org, and a county administrator of a *different* county each cannot edit or review the project. (Tasks 1, 3)
4. Submitting a project with zero needs, `slots_needed` of 0, negative or above 500, or a shift whose end is before its start is rejected. (Tasks 2, 3)
5. A county the org does not serve, a ZIP outside the project's county, or an unknown ZIP is rejected; and a suspended organization's open projects vanish from the public. (Tasks 1, 4)

---

### Task 1: Schema, create, edit, and editor reads

**Files:**
- Create: `db/migrations/0014_projects.sql`
- Create: `src/server/modules/projects.ts`
- Create: `src/lib/projects.ts`
- Test: `tests/projects.test.ts`

**Interfaces:**
- Produces (`src/lib/projects.ts`, client-safe): `export const PROJECT_AUDIENCES = ["COMMUNITY","ORG_FACILITY","HOUSEHOLD_GENERALIZED"] as const`; `export const PROJECT_STATUSES = ["DRAFT","PENDING_REVIEW","OPEN","PAUSED","COMPLETED","CANCELLED"] as const`; `export type ProjectStatus = (typeof PROJECT_STATUSES)[number]`.
- Produces (`projects.ts`):
  - `export type ProjectRow = { id: string; orgId: string; orgName: string; title: string; description: string; countyId: string; countyName: string; state: string; zip: string; audience: string; status: ProjectStatus; privateLocationNotes: string | null; reviewNote: string | null; needs: NeedRow[] }` and `export type NeedRow = { id: string; title: string; details: string | null; urgency: "NORMAL" | "URGENT"; slotsNeeded: number; startsAt: string | null; endsAt: string | null; skills: string | null; instructions: string | null }` (timestamps as ISO strings)
  - `export const projectSchema` (zod: `title` 5–140, `description` 10–4000, `countyId` uuid, `zip` 5 digits, `audience` in `PROJECT_AUDIENCES`, optional `privateLocationNotes` ≤1000)
  - `export async function createProject(driver: Driver, userId: string, orgId: string, raw: unknown): Promise<string>` (new projects are `DRAFT`)
  - `export async function updateProject(driver: Driver, userId: string, id: string, raw: unknown): Promise<void>` (only allowed while `DRAFT`, `OPEN` or `PAUSED`; content edits of `OPEN`/`PAUSED` move it to `PENDING_REVIEW`; the next task adds needs to this rule)
  - `export async function getProjectForEditor(driver: Driver, userId: string, id: string): Promise<ProjectRow | null>` (org editors/admins of the owning org, county admins of the project's county, executives)
  - `export async function listOrgProjects(driver: Driver, userId: string, orgId: string): Promise<ProjectRow[]>` (org members only; needs omitted, `needs: []`)
- Consumes: `membershipRole` logic from `directory.ts` (its SQL, re-implemented or exported: export it from `directory.ts` rather than duplicating), `loadAccess`/`canManageCounty` (`access.ts`), `parseOrThrow` (`identity.ts`), `writeAudit` (`shared.ts`), `fromDbError`, `runIn`.

- [ ] **Step 1: Write failing tests** in `tests/projects.test.ts` (setup like `tests/events.test.ts`: `freshDb`, an executive, counties Buncombe NC (fips 37021) and Henderson NC (fips 37089), an approved org with an `ORG_ADMIN`, an `EDITOR`, a `VIEWER`, and a second org; link the org to Buncombe via `organization_counties`; a county admin for Buncombe and one for Henderson via `assignCountyAdmin`). Tests:
  - `it("lets org admins and editors create a DRAFT project, and audits it")`: both succeed; `getProjectForEditor` shows `status: "DRAFT"`, `needs: []`; an `audit_logs` row `PROJECT_CREATED` exists.
  - `it("refuses viewers, other orgs, and unapproved or suspended orgs")` (Review Focus 3): the `VIEWER`, a member of the second org, and a member of a `SUSPENDED` org each get `FORBIDDEN` from `createProject`.
  - `it("requires the org to serve the county and the ZIP to belong to it")` (Review Focus 5): a Henderson project from an org that serves only Buncombe throws `VALIDATION`; ZIP `28801` is accepted for Buncombe; ZIP `28730` (Henderson) for a Buncombe project throws `VALIDATION`; ZIP `00000` throws `VALIDATION`; `SELECT count(*) FROM projects` is unchanged after the failures.
  - `it("lets editors edit a draft and refuses other users")`: update title; the `VIEWER`, the other org, and the Henderson county admin get `FORBIDDEN`.
  - `it("scopes editor reads: owner org, the county's admin, executives only")` (Review Focus 3): the project's `getProjectForEditor` returns it for the owner `EDITOR`, the Buncombe county admin and the executive; it returns `null` (never throws, so existence does not leak) for the Henderson county admin, the other org, and a plain user.
  - `it("hides projects from request roles at the database")`: `runIn(db, {kind:"anon"}, tx => tx.query("SELECT * FROM projects"))` rejects with code `42501`.

- [ ] **Step 2: Run to verify failure.** Run: `npx vitest run tests/projects.test.ts`. Expected: FAIL (module `@/server/modules/projects` not found).

- [ ] **Step 3: Write `db/migrations/0014_projects.sql`.** `projects` (`id`, `org_id` FK, `title`, `description`, `county_id` FK `counties` NOT NULL, `zip` 5-digit CHECK, `audience` and `status` CHECK against the exact lists above with `status` defaulting to `'DRAFT'`, `private_location_notes` ≤1000, `review_note` ≤2000, `reviewed_by` FK users, `reviewed_at`, `created_by` FK users, `created_at`, `updated_at` with `ics.touch_updated_at()`); indexes on `(org_id)`, `(county_id, status)`, `(zip)`. `project_needs` (`id`, `project_id` FK ON DELETE CASCADE, `need_type text NOT NULL DEFAULT 'PEOPLE' CHECK (need_type = 'PEOPLE')` (relaxed to include `GOODS` in Stage 6), `title` 3–120, `details` ≤1000, `urgency` in (`NORMAL`,`URGENT`) default `NORMAL`, `slots_needed int NOT NULL CHECK (slots_needed BETWEEN 1 AND 500)`, `starts_at`, `ends_at` with `CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at)`, `skills` ≤200, `instructions` ≤1000, `created_at`, `updated_at` with the touch trigger). Enable RLS on both tables and grant them to no request role. Do **not** create the public views here (Task 4). Follow the comment style of `0013`.

- [ ] **Step 4: Implement the Task 1 exports.** All writes run in `{ kind: "system" }` and derive access inside the transaction. Create/update: the actor must hold `ORG_ADMIN` or `EDITOR` in an `APPROVED`, non-suspended org; the project's county must be in `organization_counties` for that org; the ZIP must exist in `zip_county`, and when the county has a `fips` the ZIP must map to that FIPS in `zip_county`. `updateProject` on `OPEN`/`PAUSED` sets `status = 'PENDING_REVIEW'` and clears nothing else; on `PENDING_REVIEW`, `COMPLETED`, `CANCELLED` it throws `VALIDATION`. Audit `PROJECT_CREATED` and `PROJECT_UPDATED`. Editor reads use `loadAccess` plus a membership check; `getProjectForEditor` returns `null` for anything the actor may not see, so existence does not leak.

- [ ] **Step 5: Run to verify pass.** Run: `npx vitest run tests/projects.test.ts tests/migrations.test.ts`. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add db/migrations/0014_projects.sql src/server/modules/projects.ts src/server/modules/directory.ts src/lib/projects.ts tests/projects.test.ts
git commit -m "feat(projects): projects schema, create, edit, and editor reads"
```

---

### Task 2: People needs

**Files:**
- Modify: `src/server/modules/projects.ts`
- Test: `tests/projects.test.ts`

**Interfaces:**
- Consumes: Task 1 exports.
- Produces:
  - `export const needSchema` (zod: `title` 3–120, optional `details` ≤1000, `urgency` in `NORMAL|URGENT` default `NORMAL`, `slotsNeeded` integer 1–500 (accepts numeric strings), optional `startsAt` and `endsAt` ISO datetimes, optional `skills` ≤200, optional `instructions` ≤1000; `endsAt` must be after `startsAt` when both are set)
  - `export async function addNeed(driver: Driver, userId: string, projectId: string, raw: unknown): Promise<string>`
  - `export async function updateNeed(driver: Driver, userId: string, needId: string, raw: unknown): Promise<void>`
  - `export async function removeNeed(driver: Driver, userId: string, needId: string): Promise<void>`
  - Rule shared by all three: allowed while the project is `DRAFT`, `OPEN` or `PAUSED`; on `OPEN`/`PAUSED` the project moves to `PENDING_REVIEW`. `getProjectForEditor` now returns `needs` ordered by `starts_at NULLS LAST, created_at`.

- [ ] **Step 1: Write failing tests:**
  - `it("adds, edits and removes needs on a draft, and audits each")`: after `addNeed` the project shows one need with `slotsNeeded: 6`; `updateNeed` changes the title; `removeNeed` empties the list; audit actions `PROJECT_NEED_ADDED`, `PROJECT_NEED_UPDATED`, `PROJECT_NEED_REMOVED` exist.
  - `it("rejects bad slot counts and shifts that end before they start")` (Review Focus 4): `slotsNeeded` of `0`, `-3`, `501`, `1.5` and `"abc"` each throw `VALIDATION`; `startsAt: "2026-12-06T08:00:00Z"`, `endsAt: "2026-12-06T07:00:00Z"` throws `VALIDATION`; the needs list is unchanged afterward.
  - `it("sends an OPEN project back to review when a need changes")` (Review Focus 1): force a project to `OPEN` with a direct `system` UPDATE (the review flow arrives in Task 3), call `addNeed`, and assert `status` is `PENDING_REVIEW`; repeat for `updateNeed` and `removeNeed` on a second project.
  - `it("refuses need changes by viewers, other orgs, and on closed projects")`: `FORBIDDEN` for the viewer and the other org; `VALIDATION` when the project is `COMPLETED` or `PENDING_REVIEW`.
  - `it("returns needs in shift order")`: a need with an earlier `startsAt` precedes one with a later `startsAt`, and a need with no shift comes last.

- [ ] **Step 2: Run to verify failure.** Run: `npx vitest run tests/projects.test.ts -t "needs|slot|shift|review when"`. Expected: FAIL (functions not exported).

- [ ] **Step 3: Implement `needSchema`, `addNeed`, `updateNeed`, `removeNeed`.** Each takes a row lock on the owning project (`FOR UPDATE`) and applies the same editor check and state rule as `updateProject`; factor the shared check into one helper used by Tasks 1 and 2. `updateNeed`/`removeNeed` look up the project from the need id. Audit as listed.

- [ ] **Step 4: Run to verify pass.** Run: `npx vitest run tests/projects.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/modules/projects.ts tests/projects.test.ts
git commit -m "feat(projects): people needs with review reset on change"
```

---

### Task 3: Submit, review, and status changes

**Files:**
- Modify: `src/server/modules/projects.ts`
- Test: `tests/projects.test.ts`

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces:
  - `export async function submitProject(driver: Driver, userId: string, id: string): Promise<void>` (`DRAFT` → `PENDING_REVIEW`; requires at least one need)
  - `export async function reviewProject(driver: Driver, actorId: string, id: string, raw: unknown): Promise<void>` (`raw`: `{ decision: "APPROVE" | "RETURN", note: string }`, note 5–2000; `APPROVE` moves `PENDING_REVIEW` → `OPEN`; `RETURN` moves it to `DRAFT` and stores the note as `review_note`; records `reviewed_by`/`reviewed_at`; only the executive or a county admin of the project's county)
  - `export async function setProjectStatus(driver: Driver, userId: string, id: string, to: ProjectStatus): Promise<void>` (org editors/admins; allowed: `OPEN→PAUSED`, `PAUSED→OPEN`, `OPEN|PAUSED→COMPLETED`, `DRAFT|OPEN|PAUSED→CANCELLED`; none of these change content, so none go back to review)
  - `export const PROJECT_TRANSITIONS: Record<ProjectStatus, ProjectStatus[]>` as above plus `PENDING_REVIEW: []` for org-driven moves, `COMPLETED: []`, `CANCELLED: []`
  - `export async function listProjectsForReview(driver: Driver, actorId: string): Promise<ProjectRow[]>` (`PENDING_REVIEW` only; all for executives, otherwise only the actor's counties; includes `needs`)

- [ ] **Step 1: Write failing tests:**
  - `it("walks DRAFT to PENDING_REVIEW to OPEN with a reviewer, and audits each step")`: `submitProject` then `reviewProject(... APPROVE ...)` by the Buncombe county admin; the project is `OPEN`, `reviewedBy` is set; audit actions `PROJECT_SUBMITTED`, `PROJECT_APPROVED`.
  - `it("refuses to submit a project with no needs")` (Review Focus 4): `VALIDATION`; status stays `DRAFT`.
  - `it("returns a project to draft with a note")`: `RETURN` sets `DRAFT` and `reviewNote`; a short note (under 5 characters) throws `VALIDATION`.
  - `it("limits review to the executive and the project's county administrators")` (Review Focus 3): the Henderson county admin, an org editor of the owning org, and a plain user each get `FORBIDDEN` from `reviewProject`; the executive succeeds.
  - `it("scopes the review queue by county")`: the Buncombe admin sees the Buncombe project and not a Henderson one; the executive sees both; the owning org's editor gets `FORBIDDEN`.
  - `it("pauses, resumes, completes and cancels without going back to review")` (Review Focus 1): `OPEN→PAUSED→OPEN→COMPLETED`; each stays out of `PENDING_REVIEW`; a `COMPLETED` project cannot move again (`VALIDATION`); `DRAFT→OPEN` directly by an org editor throws `VALIDATION`.
  - `it("does not let an org approve its own project")`: an org `ORG_ADMIN` calling `reviewProject` gets `FORBIDDEN`.

- [ ] **Step 2: Run to verify failure.** Run: `npx vitest run tests/projects.test.ts -t "walks|no needs|draft with a note|limits review|review queue|pauses|approve its own"`. Expected: FAIL.

- [ ] **Step 3: Implement the five functions.** All lock the project row. `reviewProject` uses `loadAccess` and `assertCountyAccess` against the project's `county_id` (executives pass); an organization editor who is also a county administrator of that county may review *other* orgs' projects but the implementation must refuse reviewing their own org's project (`FORBIDDEN`: "You cannot review your own organization's project"). Invalid transitions throw `VALIDATION` with the `from`/`to` in the message. Audit `PROJECT_SUBMITTED`, `PROJECT_APPROVED`, `PROJECT_RETURNED`, `PROJECT_STATUS_CHANGED` (details `from`, `to`).

- [ ] **Step 4: Run to verify pass.** Run: `npx vitest run tests/projects.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/modules/projects.ts tests/projects.test.ts
git commit -m "feat(projects): submit, county review, and status changes"
```

---

### Task 4: Public reads and search

**Files:**
- Modify: `db/migrations/0014_projects.sql` (add the public views; the migration is unreleased on this branch)
- Modify: `src/server/modules/projects.ts`
- Test: `tests/projects.test.ts`

**Interfaces:**
- Consumes: `zip_point` (`ics.zip_point(text)`), `METERS_PER_MILE`, `RADIUS_OPTIONS_MILES`, `DEFAULT_RADIUS_MILES` (see `directory.ts`; move them to a shared constant location only if importing from `directory.ts` is awkward).
- Produces (SQL): view `public_projects` (id, org_id, org_name, title, description, county_id, county_name, state, zip, audience, opened_at (`reviewed_at`), `total_slots`) for `status = 'OPEN'` projects of `APPROVED`, non-suspended orgs; view `public_project_needs` (id, project_id, title, details, urgency, slots_needed, starts_at, ends_at, skills) only for projects in `public_projects`. Neither view contains `private_location_notes`, `review_note`, `instructions`, `created_by` or `reviewed_by`. Grant both `SELECT` to `ics_anon, ics_app`.
- Produces (`projects.ts`):
  - `export type PublicProject = { id: string; orgId: string; orgName: string; title: string; description: string; countyName: string; state: string; zip: string; audience: string; totalSlots: number; needs: PublicNeed[]; distanceMiles: number | null }` and `export type PublicNeed = { id: string; title: string; details: string | null; urgency: "NORMAL" | "URGENT"; slotsNeeded: number; startsAt: string | null; endsAt: string | null; skills: string | null }`
  - `export const projectSearchSchema` (zod: optional `q` ≤100, optional `zip` 5 digits, optional `radius` in `RADIUS_OPTIONS_MILES` defaulting to `DEFAULT_RADIUS_MILES`, optional `countyId` uuid)
  - `export async function searchProjects(driver: Driver, raw?: unknown): Promise<{ projects: PublicProject[]; zip: string | null; radiusMiles: number }>` (anon; text matches title, description and need titles/skills; ZIP + radius uses `ics.zip_point` distance from the project's ZIP centroid, nearest first; when the ZIP's point cannot be resolved, match on exact ZIP only; with no ZIP, projects with an urgent need first, then newest `opened_at`; limit 100)
  - `export async function getPublicProject(driver: Driver, id: string): Promise<PublicProject | null>`

- [ ] **Step 1: Write failing tests** (create several projects through the Task 1–3 functions and approve them; extend the shared setup, with two approved orgs and a `SUSPENDED` third):
  - `it("shows only OPEN projects of approved orgs, with needs and no private fields")` (Review Focus 2): a `DRAFT`, a `PENDING_REVIEW`, a `PAUSED` and a `COMPLETED` project are absent from `searchProjects` and `getPublicProject` returns `null` for them; the `OPEN` project appears with its needs; `JSON.stringify` of every public result contains neither the private location notes text nor the review note text nor any `instructions` text, and a direct `SELECT * FROM public_projects` / `public_project_needs` has no such columns (assert the column names).
  - `it("hides a project the moment its org is suspended")` (Review Focus 5): suspend the org with a `system` UPDATE; the project vanishes from search and detail; unsuspend and it returns.
  - `it("hides an approved project again after its content changes")` (Review Focus 1): `updateProject` on an `OPEN` project makes it vanish from the public until `reviewProject(APPROVE)`.
  - `it("searches by text across title, description and need titles")`: a query matching only a need title still finds the project; a query matching nothing returns `[]`.
  - `it("sorts by distance for a ZIP and honors the radius")`: with ZIP `28801`, a project in ZIP `28801` precedes one in `28806`; a project in a far ZIP (use a ZIP from `zip_county` in the Charlotte area) is excluded at a 10-mile radius and included at 200.
  - `it("filters by county")`: `countyId` of Henderson returns only Henderson projects.
  - `it("rejects a malformed ZIP or radius")`: `zip: "abc"` and `radius: 7` throw `VALIDATION`.

- [ ] **Step 2: Run to verify failure.** Run: `npx vitest run tests/projects.test.ts -t "OPEN projects|suspended|content changes|searches by text|sorts by distance|filters by county|malformed"`. Expected: FAIL.

- [ ] **Step 3: Add the two views to `0014_projects.sql`, implement `projectSearchSchema`, `searchProjects`, `getPublicProject`.** Anon reads touch only the two views and `ics.zip_point`. Never query `projects` or `project_needs` as anon.

- [ ] **Step 4: Run to verify pass.** Run: `npx vitest run tests/projects.test.ts tests/migrations.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add db/migrations/0014_projects.sql src/server/modules/projects.ts tests/projects.test.ts
git commit -m "feat(projects): public project views and search"
```

---

### Task 5: Organization dashboard screens

**Files:**
- Create: `src/app/dashboard/orgs/[orgId]/projects/page.tsx`, `src/app/dashboard/orgs/[orgId]/projects/new/page.tsx`, `src/app/dashboard/projects/[id]/page.tsx`, `src/app/dashboard/projects/actions.ts`
- Create: `src/components/project-forms.tsx`, `src/components/project-status.tsx`
- Modify: `src/app/dashboard/page.tsx` (a "Projects" link beside "New site", editors/admins only)

**Interfaces:**
- Consumes: every Task 1–3 service function, `PROJECT_AUDIENCES`/`ProjectStatus` from `src/lib/projects.ts`, `listCounties`, the org's counties served (for the county select; use the same source as the organization profile), the forms helpers in `src/components/forms.tsx`, `requireUser`, and the actions pattern in `src/app/admin/events/actions.ts`.
- Produces: server actions `createProjectAction(orgId: string, prev, form)`, `updateProjectAction(id: string, prev, form)`, `addNeedAction(projectId: string, prev, form)`, `updateNeedAction(needId: string, prev, form)`, `removeNeedAction(needId: string)`, `submitProjectAction(id: string)`, `setProjectStatusAction(id: string, to: ProjectStatus)`; components `ProjectForm`, `NeedForm`, `ProjectStatusBadge` (icon + text + color for all six statuses), `PROJECT_STATUS_LABELS`.

- [ ] **Step 1: Read the Next.js guides** for dynamic route params and server actions, then the existing `src/app/admin/events/*`, `src/components/event-forms.tsx` and the org profile page, and match them.
- [ ] **Step 2: Build the org projects list** (`/dashboard/orgs/[orgId]/projects`: status badge, title, county/ZIP, link to edit, "New project") and the new-project form (title, description, county select limited to the org's counties, ZIP, audience select with a plain-language hint that `HOUSEHOLD_GENERALIZED` descriptions must not name a person or address, private location notes labelled "Only shown to confirmed volunteers; never public").
- [ ] **Step 3: Build `/dashboard/projects/[id]`:** details form; the needs list with add/edit/remove forms (slots, shift start/end, urgency, skills, instructions); status area showing only legal next steps (Submit for review; Pause/Resume/Complete/Cancel as allowed) and the reviewer's return note when present. A note explains that changes to an open project send it back for review. Non-editors get `notFound()`. Read-only view when the project is `PENDING_REVIEW`, `COMPLETED` or `CANCELLED`.
- [ ] **Step 4: Verify.** Run: `npm run typecheck && npm run lint`. Expected: no new errors (the pre-existing `orgQ` warning is not ours). Then, if a signed-in browser is available, create, add needs, submit; otherwise record that gap in the ledger.
- [ ] **Step 5: Commit**

```bash
git add src/app/dashboard src/components/project-forms.tsx src/components/project-status.tsx
git commit -m "feat(projects): organization dashboard screens for projects"
```

---

### Task 6: Review queue, public pages, navigation, docs, full check

**Files:**
- Create: `src/app/admin/projects/page.tsx`, `src/app/admin/projects/actions.ts`, `src/app/projects/page.tsx`, `src/app/projects/[id]/page.tsx`
- Create: `src/components/project-review-form.tsx`
- Modify: `src/app/admin/page.tsx` (a "Projects" card for executives and county administrators), `src/app/layout.tsx` (a "Projects" nav link), `README.md`, `docs/09-crisis-compass-upgrade-plan.md`, `docs/10-gap-analysis.md`, `docs/04-journeys-sitemap.md`

**Interfaces:**
- Consumes: `listProjectsForReview`, `reviewProject`, `searchProjects`, `getPublicProject`, `PublicProject`, the project status components, `AvailabilityBadge` is **not** used here.

- [ ] **Step 1: Build `/admin/projects`:** the review queue from `listProjectsForReview` showing org, title, county/ZIP, audience, description and each need; an approve/return form with a required note. Gate with `notFound()` for non-reviewers, matching `/admin/profiles`.
- [ ] **Step 2: Build `/projects`:** a search form (text, ZIP, radius select from the shared options, county select), result cards (org, title, county and ZIP, urgent badge, "N volunteers needed" from `totalSlots`, distance when a ZIP was given) and an empty state. **Build `/projects/[id]`:** description, org name linking to `/orgs/<id>` only when that profile is public, needs with shift times, skills and urgency, and a plain note that volunteer sign-up is coming. Never render a "filled" count. `notFound()` for anything `getPublicProject` returns `null` for.
- [ ] **Step 3: Update docs:** README (a Projects section; correct the test count), `docs/10` (community projects row becomes **Stage 2 done**: people needs, review, public search; goods needs, sign-up and event links remain), `docs/09` (`projects`/`project_needs` shipped in `0014`; note the review rule), `docs/04` (new routes).
- [ ] **Step 4: Run the full check.** Run: `npm run check && npm run build`. Expected: lint, typecheck and every test pass (the existing 205 plus the new project tests) and the build lists the new routes.
- [ ] **Step 5: Manual check** with `npm run dev` (note: another process may hold port 3000; use the port the dev server prints): an org editor creates and submits a project; a county admin approves it; `/projects` lists it with its needs and no private notes; editing it sends it back to review and it leaves `/projects`. If no signed-in browser is available, state that this was not verified.
- [ ] **Step 6: Commit**

```bash
git add src/app/admin src/app/projects src/app/layout.tsx src/components README.md docs
git commit -m "feat(projects): review queue, public projects pages, navigation, docs"
```
