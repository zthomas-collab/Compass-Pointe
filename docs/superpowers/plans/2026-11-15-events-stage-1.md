# Events (Stage 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Platform admins can create and run disaster **events** (named areas made of counties, optionally narrowed to ZIPs), and the public can browse them at `/events` and `/events/<slug>`, where each event page shows the **Help** available in its area.

**Architecture:** One forward-only migration (`0013_events.sql`) adds `events`, `event_counties`, `event_zips` and a `public_events` view. A new service module `src/server/modules/events.ts` follows the `counties.ts` pattern (zod input, `runIn` with `system` context + `assertExecutive` for writes, `writeAudit`, anon reads through public views). Admin pages and server actions mirror `/admin/counties`; public pages are server components. The event **Needs** list, projects and links are later stages and are *not* built here.

**Tech Stack:** Next.js (breaking-change version, see constraints), React 19, PostgreSQL/PostGIS via PGlite in tests, zod, vitest.

**Spec:** `docs/superpowers/specs/2026-11-15-events-and-projects-design.md` (Stage 1 of its six delivery stages).

## Global Constraints

- Follow existing patterns: RLS and SECURITY DEFINER helpers, `public_*` read-model views, services in `src/server/modules/`, audit events via `writeAudit`, `runIn` contexts.
- Forward-only, expand/contract migrations. This stage's migration is `0013`.
- `AGENTS.md`: this Next.js has breaking changes. Read the relevant guide in `node_modules/next/dist/docs/` before writing page or server-action code.
- Accessibility parity with the map: status shown by icon + text + color; axe clean.
- Tests run on real PostGIS (PGlite) via `freshDb()`; each stage ships authorization, county-isolation and privacy tests.
- Only platform admins create events. Closed events stay public and read-only as an archive.
- Public pages never expose a person's name, home address or request. No public count may be computed from anything but real rows.
- Event statuses are exactly `DRAFT`, `ACTIVE`, `RECOVERY`, `CLOSED`.

## Review Focus

1. A site whose free-text `county` is `"Buncombe County"` (with suffix) or odd casing must still match the event county `Buncombe, NC`; a same-named county in another state must not. (Task 3)
2. An event with zero counties, duplicate county ids, or an unknown ZIP is rejected with a clear message; nothing is half-created. (Task 1)
3. A `DRAFT` event must be invisible to the public by every route: the view, `getPublicEvent(slug)`, and a direct anon query of the table. (Tasks 1, 3)
4. A name that yields an empty slug (e.g. only symbols) or the reserved slug `new` must be rejected, not silently stored. (Task 1)
5. A `CLOSED` event cannot be reopened to `ACTIVE`, and `closed_on` is set exactly when it closes. (Task 2)

---

### Task 1: Schema, create, and admin reads

**Files:**
- Create: `db/migrations/0013_events.sql`
- Create: `src/server/modules/events.ts`
- Test: `tests/events.test.ts`

**Interfaces:**
- Produces (`events.ts`):
  - `export const HAZARD_TYPES = ["HURRICANE","FLOOD","WILDFIRE","TORNADO","WINTER_STORM","EARTHQUAKE","OTHER"] as const`
  - `export type EventStatus = "DRAFT" | "ACTIVE" | "RECOVERY" | "CLOSED"`
  - `export type EventRow = { id: string; name: string; slug: string; hazardType: string; status: EventStatus; summary: string | null; startsOn: string; closedOn: string | null; counties: { id: string; name: string; state: string }[]; zips: string[] }` (dates as `YYYY-MM-DD` strings)
  - `export function slugify(name: string): string`
  - `export const eventSchema` (zod: `name` 3–120, optional `slug`, `hazardType` in `HAZARD_TYPES`, `summary` ≤2000 optional, `startsOn` date, `countyIds` uuid array min 1 de-duplicated, `zips` optional array of 5-digit strings de-duplicated)
  - `export async function createEvent(driver: Driver, actorId: string, raw: unknown): Promise<string>` (returns id; new events are `DRAFT`)
  - `export async function listEventsAdmin(driver: Driver, actorId: string): Promise<EventRow[]>`
  - `export async function getEventAdmin(driver: Driver, actorId: string, id: string): Promise<EventRow | null>`
- Consumes: `assertExecutive` (`access.ts`), `parseOrThrow` (`identity.ts`), `writeAudit` (`shared.ts`), `fromDbError` (`errors.ts`), `runIn`.

- [ ] **Step 1: Write failing tests** in `tests/events.test.ts` (setup like `tests/zip-county.test.ts`: `freshDb`, an executive via `makeUser` + `grantRole(..., "PLATFORM_ADMIN")`, a plain user, and counties via `createCounty`). Tests:
  - `it("lets only a platform admin create an event")`: exec succeeds and returns a uuid; a plain user and a county admin each throw `AppError` with code `FORBIDDEN`.
  - `it("creates a DRAFT event with counties and ZIPs and audits it")`: `getEventAdmin` returns `status: "DRAFT"`, the two counties, `zips: ["28801"]`; an `audit_logs` row with `action = 'EVENT_CREATED'` exists.
  - `it("derives a slug from the name and rejects duplicates")`: `"Hurricane X – Carteret"` → slug `"hurricane-x-carteret"`; creating the same name again throws a validation/conflict `AppError`.
  - `it("rejects zero counties, duplicate counties, and unknown ZIPs")` (Review Focus 2): zero counties throws; duplicate `countyIds` are collapsed to one; ZIP `"00000"` (not in `zip_county`) throws; after each failed call `SELECT count(*) FROM events` is unchanged.
  - `it("rejects an empty slug and the reserved slug 'new'")` (Review Focus 4): name `"!!!"` with no slug throws; explicit slug `"new"` throws.
  - `it("hides DRAFT events from anon at the database")` (Review Focus 3): `runIn(db, {kind:"anon"}, tx => tx.query("SELECT * FROM events"))` throws a permission error; `SELECT * FROM public_events` returns zero rows for the draft.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/events.test.ts`
Expected: FAIL (module `@/server/modules/events` not found).

- [ ] **Step 3: Write `db/migrations/0013_events.sql`.** Tables: `events` (`id`, `name` 3–120, `slug` unique with `CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) BETWEEN 3 AND 80 AND slug <> 'new')`, `hazard_type` CHECK against the seven values, `status` CHECK against the four values default `'DRAFT'`, `summary` ≤2000, `starts_on date NOT NULL`, `closed_on date` with `CHECK (closed_on IS NULL OR closed_on >= starts_on)` and `CHECK ((status = 'CLOSED') = (closed_on IS NOT NULL))`, `created_by`, `created_at`, `updated_at` with the existing `ics.touch_updated_at()` trigger), `event_counties (event_id, county_id)` PK, `event_zips (event_id, zip)` PK with the 5-digit CHECK. Enable RLS on all three and grant the tables to no request role. Create `public_events` (whitelisted columns, `counties` as an array of `"Name, ST"`, `zips` as an array) `WHERE status <> 'DRAFT'`, and `GRANT SELECT ON public_events TO ics_anon, ics_app`. Follow the comment style of `0008`.

- [ ] **Step 4: Implement `slugify`, `eventSchema`, `createEvent`, `listEventsAdmin`, `getEventAdmin` in `events.ts`.** `createEvent` runs in one `system` transaction: `assertExecutive`, validate each ZIP exists in `zip_county`, insert the event and its county/ZIP rows, `writeAudit({ action: "EVENT_CREATED", subjectType: "event", subjectId, details: { name, slug } })`, wrapped with `fromDbError` so a unique-slug violation becomes an `AppError`. Admin reads run in `system` after `assertExecutive`.

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run tests/events.test.ts tests/migrations.test.ts`
Expected: PASS (migration test still applies cleanly and is idempotent).

- [ ] **Step 6: Commit**

```bash
git add db/migrations/0013_events.sql src/server/modules/events.ts tests/events.test.ts
git commit -m "feat(events): events schema, creation, and admin reads"
```

---

### Task 2: Edit and status transitions

**Files:**
- Modify: `src/server/modules/events.ts`
- Test: `tests/events.test.ts`

**Interfaces:**
- Consumes: Task 1 exports.
- Produces:
  - `export async function updateEvent(driver: Driver, actorId: string, id: string, raw: unknown): Promise<void>` (same schema as create; replaces counties and ZIPs; slug is **not** changeable once the event has left `DRAFT`)
  - `export async function setEventStatus(driver: Driver, actorId: string, id: string, to: EventStatus): Promise<void>`
  - `export const ALLOWED_TRANSITIONS: Record<EventStatus, EventStatus[]>` = `DRAFT→[ACTIVE]`, `ACTIVE→[RECOVERY, CLOSED]`, `RECOVERY→[ACTIVE, CLOSED]`, `CLOSED→[]`

- [ ] **Step 1: Write failing tests:**
  - `it("walks DRAFT to ACTIVE to RECOVERY to CLOSED and audits each step")`: each `setEventStatus` succeeds; `EVENT_STATUS_CHANGED` audit rows record `from` and `to`.
  - `it("sets closed_on exactly when closing and never reopens")` (Review Focus 5): after `CLOSED`, `getEventAdmin(...).closedOn` equals today's date string; `setEventStatus(..., "ACTIVE")` throws; `closedOn` is unchanged afterward.
  - `it("rejects illegal jumps")`: `DRAFT → CLOSED` and `DRAFT → RECOVERY` throw.
  - `it("updates fields and areas, audits, and locks the slug after activation")`: update name and counties on a draft; after `ACTIVE`, changing the slug throws while changing the summary succeeds; non-executives get `FORBIDDEN`.

- [ ] **Step 2: Run to verify failure.** Run: `npx vitest run tests/events.test.ts -t "walks|closed_on|illegal|updates fields"`. Expected: FAIL (functions not exported).

- [ ] **Step 3: Implement `updateEvent` and `setEventStatus`.** Both take a row lock (`SELECT ... FOR UPDATE`) on the event inside the transaction, `assertExecutive`, then validate. `setEventStatus` sets `closed_on = current_date` when `to = 'CLOSED'`. Audit actions `EVENT_UPDATED` and `EVENT_STATUS_CHANGED` (details include `from`, `to`).

- [ ] **Step 4: Run to verify pass.** Run: `npx vitest run tests/events.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/modules/events.ts tests/events.test.ts
git commit -m "feat(events): edit events and status transitions"
```

---

### Task 3: Public reads and the Help list

**Files:**
- Modify: `src/server/modules/events.ts`
- Test: `tests/events.test.ts`

**Interfaces:**
- Consumes: `EventRow`; `public_events`, `public_sites`, `public_resources` views.
- Produces:
  - `export async function listPublicEvents(driver: Driver): Promise<EventRow[]>` (anon; `ACTIVE` and `RECOVERY` first by `starts_on` desc, then `CLOSED` by `closed_on` desc)
  - `export async function getPublicEvent(driver: Driver, slug: string): Promise<EventRow | null>` (anon; `null` for unknown or `DRAFT`)
  - `export type EventHelpSite = { siteId: string; siteName: string; orgName: string; city: string | null; postalCode: string | null; hoursText: string | null; resources: { name: string; categoryLabel: string; reportedStatus: string; freshness: string }[] }`
  - `export async function getEventHelp(driver: Driver, eventId: string): Promise<EventHelpSite[]>` (anon). Area rule: if the event has ZIPs, a site matches when its `postal_code` is in them; otherwise a site matches when its state equals a county's state and its `county` text, with a trailing `" County"` removed and compared case-insensitively, equals the county name.

- [ ] **Step 1: Write failing tests** (create a public site for an approved org via the fixtures, as `tests/visibility.test.ts` does; extend the helper only if one is missing):
  - `it("lists public events with active ones first and never drafts")`.
  - `it("returns null from getPublicEvent for a draft and for an unknown slug")` (Review Focus 3).
  - `it("keeps a closed event public")`.
  - `it("matches help sites by county, tolerating a 'County' suffix and casing")` (Review Focus 1): sites with county `"Buncombe"`, `"buncombe county"` and `"Buncombe County"` all appear for an event on Buncombe, NC; a site with county `"Buncombe"` and state `"SC"` does not; a site in another county does not.
  - `it("narrows help to the event's ZIPs when ZIPs are set")`: an event with ZIP `28801` returns only the `28801` site, not the `28804` site in the same county.
  - `it("excludes hidden and suspended sources and private sites")`: a `PRIVATE` site and a site of a suspended org never appear.
  - `it("returns each site's resources with status and freshness")`.

- [ ] **Step 2: Run to verify failure.** Run: `npx vitest run tests/events.test.ts -t "public events|getPublicEvent|closed event|matches help|narrows help|excludes hidden|resources with status"`. Expected: FAIL.

- [ ] **Step 3: Implement the four functions.** Reads run as `{ kind: "anon" }` through `public_events`, `public_sites` and `public_resources` only. Never query the `events` table from anon. Build the area predicate once as a shared SQL fragment constant.

- [ ] **Step 4: Run to verify pass.** Run: `npx vitest run tests/events.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/modules/events.ts tests/events.test.ts
git commit -m "feat(events): public event reads and area help list"
```

---

### Task 4: Admin screens

**Files:**
- Create: `src/app/admin/events/page.tsx`, `src/app/admin/events/[id]/page.tsx`, `src/app/admin/events/actions.ts`
- Create: `src/components/event-forms.tsx`
- Modify: `src/app/admin/page.tsx` (add a link, platform admins only, next to "Counties and administrators")

**Interfaces:**
- Consumes: `createEvent`, `updateEvent`, `setEventStatus`, `listEventsAdmin`, `getEventAdmin`, `listCounties`, `ALLOWED_TRANSITIONS`; `FormState`, `toState`, `fields`, `requireUser`, `Field`, `FormMessage`, `SubmitButton` as used by `/admin/counties` and `src/app/dashboard/actions.ts`.
- Produces: server actions `createEventAction(prev: FormState, form: FormData): Promise<FormState>`, `updateEventAction(id: string, prev: FormState, form: FormData): Promise<FormState>`, `setEventStatusAction(id: string, to: EventStatus): Promise<FormState>`; components `CreateEventForm`, `EditEventForm`, `StatusButtons`.

- [ ] **Step 1: Read the Next.js guides** in `node_modules/next/dist/docs/` for dynamic route params and server actions, and the existing `/admin/counties` page, `county-forms.tsx` and `dashboard/actions.ts`, then match them.
- [ ] **Step 2: Build `/admin/events`**: a list (status badge with icon and text, hazard, counties, start date) and a "New event" form (name, optional slug, hazard select, start date, county checkboxes from `listCounties`, ZIPs as a comma-separated field, summary). Non-executives get `notFound()` as in `/admin/counties`.
- [ ] **Step 3: Build `/admin/events/[id]`**: the same form for editing (slug read-only after activation) plus status buttons showing only the transitions in `ALLOWED_TRANSITIONS[current]`. Actions call `revalidatePath("/admin/events")`, `/events` and the event's own path.
- [ ] **Step 4: Verify.** Run: `npm run typecheck && npm run lint`. Expected: no errors. Then `npm run db:seed`, grant yourself `PLATFORM_ADMIN` (see the README quick start), `npm run dev`, and create, edit and activate an event in the browser. Expected: the event appears in the list with the new status after each step.
- [ ] **Step 5: Commit**

```bash
git add src/app/admin src/components/event-forms.tsx
git commit -m "feat(events): admin screens for events"
```

---

### Task 5: Public pages, navigation, docs, full check

**Files:**
- Create: `src/app/events/page.tsx`, `src/app/events/[slug]/page.tsx`
- Modify: `src/app/layout.tsx` (add an "Events" nav link beside Contacts), `README.md`, `docs/09-crisis-compass-upgrade-plan.md`, `docs/10-gap-analysis.md`, `docs/04-journeys-sitemap.md`

**Interfaces:**
- Consumes: `listPublicEvents`, `getPublicEvent`, `getEventHelp`, `EventRow`, `EventHelpSite`; the status components in `src/components/status.tsx` and `status-icons.tsx`.

- [ ] **Step 1: Build `/events`**: active and recovery events first, an "Archive" section for closed ones, each linking to `/events/<slug>`. An empty state says no events are currently open.
- [ ] **Step 2: Build `/events/[slug]`**: header (name, hazard, status, dates, counties/ZIPs, summary), a **Help in this area** section listing `EventHelpSite` rows with their resources, status and freshness using the existing status components, and a **Needs** section that says volunteer needs for this event will appear here once projects are linked (a clearly labelled placeholder, no fake data). `notFound()` for a draft or unknown slug. Set `dynamic = "force-dynamic"` like the other public pages.
- [ ] **Step 3: Update docs**: README (new Events section, correct the stale phase and test counts), `docs/09` and `docs/10` (events now mean disaster areas; the old task board is superseded), `docs/04` (new routes, marked built or pending).
- [ ] **Step 4: Run the full check.** Run: `npm run check && npm run build`. Expected: lint, typecheck and all tests pass (186 existing plus the new events tests), and the build succeeds.
- [ ] **Step 5: Manual check in the browser** with `npm run dev`: a draft event returns 404 at `/events/<slug>`; after activation it lists and shows seeded Buncombe sites under Help; after closing it moves to the Archive. Expected: all three behave as described.
- [ ] **Step 6: Commit**

```bash
git add src/app/events src/app/layout.tsx README.md docs
git commit -m "feat(events): public events pages, navigation, and docs"
```
