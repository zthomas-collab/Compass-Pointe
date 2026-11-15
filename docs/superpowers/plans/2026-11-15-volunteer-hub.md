# Volunteer & Donate Hub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One professional front door at `/volunteer` that asks "How do you want to help?", with the shift list and donate flow inside the same section, and every old `/projects` link still working.

**Architecture:** Pages and navigation only; no migrations, services or permission changes. The shift pages move from `src/app/projects` to `src/app/volunteer/projects`; `/volunteer` becomes a hub; the offer form moves to `/volunteer/donate` behind a type chooser; permanent redirects in `next.config.ts` keep old links alive. Shared constants (offer types and their descriptions, section paths) move to client-safe `src/lib/` files so pages, forms and tests share one source.

**Tech Stack:** Next.js (breaking-change version, see constraints), React 19, vitest.

**Branch:** `volunteer-hub`, stacked on `event-links-stage-4` (PR #7), because the event page's project links change here too.

**Spec:** `docs/superpowers/specs/2026-11-15-volunteer-hub-design.md`

## Global Constraints

- `AGENTS.md`: this Next.js has breaking changes. Read the relevant guide in `node_modules/next/dist/docs/` before writing page or redirect code. Redirects go in `next.config.ts` (`redirects()` already holds `/black-book`).
- Client components must not import server modules for runtime values; shared constants go in `src/lib/`.
- Accessibility parity with the map (axe clean): landmarks are labelled, the current page is marked `aria-current="page"`, color is never the only signal, and keyboard order follows reading order. Mobile first, brand tokens only.
- **"Donate" means in-kind only.** No money, no payment link, no payment code.
- Public pages show only real data: the hub's counts and "urgent now" list come from `searchProjects`; nothing is invented, and an empty state never leaves a blank gap.
- No change to who can see what: private location notes, instructions and volunteer data appear on no new page.
- The offer form's fields, validation, spam guards (rate limit and trap field) and the `submitOffer` service are unchanged; all ten offer types stay submittable.
- Use `Link` (not `<a>`) for internal navigation.

## Review Focus

1. Old links keep working: `/projects` and `/projects/<id>` redirect permanently to the new paths, with the query string preserved (for example `/projects?zip=28801&radius=25`). (Task 1)
2. All ten offer types remain reachable at `/volunteer/donate?type=<CODE>`; an unknown, repeated or empty `type` shows the chooser instead of an error or a wrong preselection. (Task 1)
3. No stale `/projects` link or `revalidatePath` is left in `src`, so no page links to a redirect and no cache refresh targets a dead path. (Task 2)
4. The cancellation notice email links to the new shifts page. (Task 2)
5. The hub shows only real public data, never leaves a blank section when nothing is open, and no page in the section is a dead end. (Tasks 3, 4)

---

### Task 1: Shared constants, section navigation, and redirects

**Files:**
- Create: `src/lib/offers.ts`, `src/lib/volunteer-paths.ts`
- Create: `src/components/volunteer-nav.tsx`
- Modify: `src/server/modules/offers.ts` (import and re-export the constants), `next.config.ts`, `src/app/layout.tsx`
- Test: `tests/volunteer-hub.test.ts`

**Interfaces:**
- Produces (`src/lib/offers.ts`, client-safe): `export const OFFER_TYPES` (the same ten codes, same order, `as const`), `export type OfferType`, `export const OFFER_TYPE_LABELS: Record<OfferType, string>` (unchanged wording), `export type OfferTypeInfo = { description: string; quantityHint: string; unitHint: string; steerToShifts: boolean; glyph: string }`, `export const OFFER_TYPE_INFO: Record<OfferType, OfferTypeInfo>` (a plain one-sentence description per type, for example for `BUILDING_SUPPLIES`: "Lumber, tarps, tools, drywall, roofing and similar materials"; `steerToShifts` is true only for `VOLUNTEER_LABOR` and `PROFESSIONAL_SKILLS`), `export function parseOfferType(value: unknown): OfferType | null` (a string that exactly equals a code; anything else, including arrays, empty strings, lowercase and `undefined`, is `null`).
- Produces (`src/lib/volunteer-paths.ts`): `export const VOLUNTEER_PATHS = { hub: "/volunteer", shifts: "/volunteer/projects", donate: "/volunteer/donate", thanks: "/volunteer/thanks" } as const`; `export function shiftPath(projectId: string): string` (`/volunteer/projects/<id>`); `export function donatePath(type?: OfferType): string` (`/volunteer/donate`, or `/volunteer/donate?type=<CODE>`).
- Produces (`volunteer-nav.tsx`): `export function VolunteerSectionNav({ current }: { current: "overview" | "shifts" | "donate" })` (a `nav` with `aria-label="Volunteer and donate"` and links Overview · Find a shift · Donate, `aria-current="page"` on the current one); `export function Breadcrumb({ items }: { items: { label: string; href?: string }[] })` (a `nav` with `aria-label="Breadcrumb"` and an ordered list; the last item is plain text with `aria-current="page"`).
- Consumes: the existing `OFFER_TYPES`/`OFFER_TYPE_LABELS` in `src/server/modules/offers.ts` (moved, not changed).

- [ ] **Step 1: Write failing tests** in `tests/volunteer-hub.test.ts`:
  - `it("keeps all ten offer types, in order, with labels and info")`: `OFFER_TYPES` equals the ten codes `VOLUNTEER_LABOR, PROFESSIONAL_SKILLS, EQUIPMENT, TRANSPORTATION, DRINKING_WATER, FOOD, BUILDING_SUPPLIES, CLEANING_SUPPLIES, STORAGE_SPACE, OTHER`; every code has a non-empty label and a description of at least 20 characters; `steerToShifts` is true for exactly `VOLUNTEER_LABOR` and `PROFESSIONAL_SKILLS`; the server module still exports the same `OFFER_TYPES` (import from `@/server/modules/offers` and compare).
  - `it("parses an offer type only when it exactly matches a code")` (Review Focus 2): every code parses to itself; `"food"`, `""`, `" FOOD"`, `"FOOD,FOOD"`, `["FOOD"]`, `["FOOD","FOOD"]`, `undefined`, `null`, `42` and `"NOPE"` give `null`.
  - `it("builds section paths")`: `shiftPath("abc")` is `/volunteer/projects/abc`; `donatePath()` is `/volunteer/donate`; `donatePath("FOOD")` is `/volunteer/donate?type=FOOD`; `VOLUNTEER_PATHS` values are exactly the four paths.
  - `it("redirects the old project URLs permanently")` (Review Focus 1): import the default config from `../next.config` and `await config.redirects!()`; it contains `{ source: "/projects", destination: "/volunteer/projects", permanent: true }` and `{ source: "/projects/:id", destination: "/volunteer/projects/:id", permanent: true }`, and still contains the existing `/black-book` rule.

- [ ] **Step 2: Run to verify failure.** Run: `npx vitest run tests/volunteer-hub.test.ts`. Expected: FAIL (modules not found).

- [ ] **Step 3: Implement.** Move `OFFER_TYPES`, `OfferType` and `OFFER_TYPE_LABELS` into `src/lib/offers.ts` and add `OFFER_TYPE_INFO`, `parseOfferType`; make `src/server/modules/offers.ts` import them and `export { OFFER_TYPES, OFFER_TYPE_LABELS, type OfferType }` so no other importer changes. Add `volunteer-paths.ts`. Build the two navigation components with the existing brand classes (`navLink`-style links, `card`, `badge`). In `next.config.ts` add the two redirects beside `/black-book` (Next preserves the query string). In `layout.tsx` remove the `Projects` link and keep `Volunteer & donate` (it stays highlighted on every `/volunteer/*` route if the layout can know the path; otherwise leave the section nav to carry the current-page marking).

- [ ] **Step 4: Run to verify pass.** Run: `npx vitest run tests/volunteer-hub.test.ts tests/offers.test.ts`. Expected: PASS (the offers tests still pass).

- [ ] **Step 5: Commit**

```bash
git add src/lib src/components/volunteer-nav.tsx src/server/modules/offers.ts next.config.ts src/app/layout.tsx tests/volunteer-hub.test.ts
git commit -m "feat(volunteer-hub): shared offer constants, section navigation, and project redirects"
```

---

### Task 2: Move the shift pages and fix every link

**Files:**
- Move: `src/app/projects/page.tsx` → `src/app/volunteer/projects/page.tsx`, `src/app/projects/[id]/page.tsx` → `src/app/volunteer/projects/[id]/page.tsx`, `src/app/projects/signup-actions.ts` → `src/app/volunteer/projects/signup-actions.ts` (use `git mv`)
- Modify: `src/app/events/[slug]/page.tsx`, `src/app/volunteer/commitments/page.tsx`, `src/app/dashboard/projects/actions.ts`, `src/app/admin/projects/actions.ts`, `src/server/modules/volunteers.ts` (the notice email link)
- Test: `tests/volunteer-hub.test.ts`, `tests/volunteers.test.ts`

**Interfaces:**
- Consumes: `VOLUNTEER_PATHS`, `shiftPath`, `VolunteerSectionNav`, `Breadcrumb` (Task 1).
- Produces: the shift list at `/volunteer/projects` and a shift at `/volunteer/projects/<id>`, each with the sub-navigation (`current="shifts"`) and a breadcrumb (Volunteer & donate › Find a shift [› the project title]); no behavior change otherwise.

- [ ] **Step 1: Write failing tests:**
  - In `tests/volunteer-hub.test.ts`, `it("leaves no link to the old project paths in the source")` (Review Focus 3): recursively read every `.ts` and `.tsx` file under `src` (use `node:fs`), and assert none contains `"/projects"` or `` `/projects/ `` as a string that starts with a slash-projects path **unless** it begins `/volunteer/projects`, `/dashboard/projects`, `/dashboard/orgs/` or `/admin/projects`, and that no `revalidatePath("/projects` remains; list offending `file:line` in the assertion message. (Implement with a regex over each line that finds `["'\`]/projects` and rejects it, so `/volunteer/projects` and the dashboard paths, which do not start with `/projects`, are untouched.)
  - In `tests/volunteers.test.ts`, extend the existing "emails confirmed and pending volunteers when a project is cancelled" test (or add `it("points the cancellation notice at the new shifts page")`): the notice body contains `/volunteer/projects` and does not contain a bare `/projects` link (Review Focus 4).

- [ ] **Step 2: Run to verify failure.** Run: `npx vitest run tests/volunteer-hub.test.ts tests/volunteers.test.ts -t "old project paths|new shifts page"`. Expected: FAIL.

- [ ] **Step 3: Move and update.** `git mv` the three files, then fix every reference: the list page's own links (`Clear`, each card) and the detail page's back link use `VOLUNTEER_PATHS.shifts` / `shiftPath(id)`; add the sub-navigation and breadcrumb to both pages and retitle the list "Find a volunteer shift" (keep the search form and behavior); the event page's project links use `shiftPath(p.id)`; the commitment page's three links (`/projects` twice, `/projects/${id}` once) use the new paths; both `revalidatePath("/projects")` / `("/projects/${id}")` pairs in the two actions files become the new paths; the cancellation notice in `volunteers.ts` links to `${appBaseUrl()}${VOLUNTEER_PATHS.shifts}`. The `signUpAction` import path in the detail page changes with the move.

- [ ] **Step 4: Verify.** Run: `npm run typecheck && npm run lint && npx vitest run tests/volunteer-hub.test.ts tests/volunteers.test.ts`. Expected: PASS and no new lint errors.

- [ ] **Step 5: Commit**

```bash
git add -A src tests
git commit -m "feat(volunteer-hub): move the shift pages under /volunteer and update every link"
```

---

### Task 3: Donate chooser and guided form

**Files:**
- Create: `src/app/volunteer/donate/page.tsx`, `src/components/donate-chooser.tsx`
- Modify: `src/components/offer-forms.tsx` (`OfferForm` takes `defaultType` and type hints), `src/app/volunteer/page.tsx` (temporarily re-exports nothing; the hub replaces it in Task 4)
- Test: `tests/volunteer-hub.test.ts`

**Interfaces:**
- Consumes: `OFFER_TYPES`, `OFFER_TYPE_LABELS`, `OFFER_TYPE_INFO`, `parseOfferType`, `donatePath`, `VOLUNTEER_PATHS` (Task 1); `OfferForm`, `submitOfferAction`, `listCounties`.
- Produces: `/volunteer/donate` (server component reading `searchParams`): with no valid type it renders `DonateChooser`; with a valid type it renders the offer form with that type preselected. `DonateChooser({ types })` renders one link card per type (`href={donatePath(code)}`, glyph `aria-hidden`, label, description). `OfferForm` gains the optional props `defaultType?: OfferType` (preselects the select) and `typeHints?: { quantityHint: string; unitHint: string }` (replace the quantity and unit hints).

- [ ] **Step 1: Write failing tests** (pure logic only; the screens are checked live in Task 5):
  - `it("gives every offer type a distinct chooser link")`: build the list the chooser renders from `OFFER_TYPES` and assert the ten `donatePath(code)` values are distinct and each contains `type=<code>`; assert `OFFER_TYPE_INFO[code].quantityHint` and `unitHint` are non-empty for every code.
  - `it("steers volunteer-type offers to shifts and nobody else")` (Review Focus 2): `steerToShifts` is true only for the two volunteer-type codes, and `donatePath` for those two still returns the form path (the form stays reachable).

- [ ] **Step 2: Run to verify failure.** Run: `npx vitest run tests/volunteer-hub.test.ts -t "chooser link|steers volunteer"`. Expected: FAIL if `OFFER_TYPE_INFO` hints are missing; if Task 1 already satisfies them, record that these tests passed immediately and add the assertion that fails first: no `quantityHint` may be identical across more than three types (hints must be specific), then make it pass.

- [ ] **Step 3: Implement.** The donate page: read `searchParams.type` (a string or array), call `parseOfferType` on it only when it is a single string; render the page header, the sub-navigation (`current="donate"`) and a breadcrumb. Chooser: a responsive grid of cards. Form view: heading "Donate: <label>", a "Change what I'm giving" link back to `VOLUNTEER_PATHS.donate`, the callout for `steerToShifts` types ("The fastest way to help is a real shift" with a button to `VOLUNTEER_PATHS.shifts`, then "Or tell us about your skills" above the form), and `OfferForm` with `defaultType` and the type's hints. The form's server action, fields and validation are untouched.

- [ ] **Step 4: Verify.** Run: `npm run typecheck && npm run lint && npx vitest run tests/volunteer-hub.test.ts tests/offers.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src tests
git commit -m "feat(volunteer-hub): donate chooser and guided offer form"
```

---

### Task 4: The hub and the thank-you pages

**Files:**
- Modify: `src/app/volunteer/page.tsx` (becomes the hub), `src/app/volunteer/thanks/page.tsx`, the sign-up success message in `src/app/volunteer/projects/signup-actions.ts`
- Create: `src/components/volunteer-hub-cards.tsx` (presentational pieces if useful)

**Interfaces:**
- Consumes: `searchProjects` (existing, anon), `VOLUNTEER_PATHS`, `shiftPath`, `donatePath`, `OFFER_TYPE_INFO`, `VolunteerSectionNav`.
- Produces: the hub described in the spec. Data: `const { projects } = await searchProjects({})` then `projects.slice(0, 3)` for "Urgent now" (the search already orders urgent projects first); the headline count is `projects.length` open projects (omit the count if zero). The ZIP box is a `GET` form whose action is `VOLUNTEER_PATHS.shifts` with `name="zip"`. A "Donate" card shows the three most common types (food, drinking water, building supplies) as links plus "See everything you can give". A "Skilled professional?" link goes to `donatePath("PROFESSIONAL_SKILLS")`. A "How it works" strip and a trust line ("No account needed · Your details are shared only with the organization · Cancel any time"). A link to `/events`.

- [ ] **Step 1: Read the Next.js guides** for `searchParams` and server components, then the existing `/events` page and the old `/volunteer` page for tone; match the brand classes.
- [ ] **Step 2: Build the hub** with no invented numbers: with zero open projects the Volunteer card says "No shifts are open right now" and offers the volunteer-labor donate link instead; with some, it lists up to three with title, organization, county, an urgent badge when `hasUrgent`, and "N of M spots left"; each links to `shiftPath(id)`. Use headings in order (one `h1`, `h2` per card) and labelled form controls.
- [ ] **Step 3: Thank-you pages.** The offer thank-you keeps the reference number and adds "What happens next" (a coordinator reviews it, may contact you, nothing is promised) and two buttons: Find a shift (`VOLUNTEER_PATHS.shifts`) and See current events (`/events`). The volunteer sign-up success message gains a "See other shifts" link to `VOLUNTEER_PATHS.shifts`. Both stay `noindex`.
- [ ] **Step 4: Verify.** Run: `npm run typecheck && npm run lint`. Expected: no new errors.
- [ ] **Step 5: Commit**

```bash
git add src
git commit -m "feat(volunteer-hub): the hub and clearer thank-you pages"
```

---

### Task 5: Docs, full check, live check

**Files:**
- Modify: `README.md`, `docs/04-journeys-sitemap.md`

- [ ] **Step 1: Update docs:** README (a short Volunteer & donate hub bullet; correct the test count from the real run), `docs/04` (the new routes, the redirects, and the removal of `/projects` from the nav).
- [ ] **Step 2: Run the full check.** Run: `npm run check && npm run build`. Expected: lint, typecheck and every test pass and the build succeeds.
- [ ] **Step 3: Live check** against the local server on port 3000 (it serves this working directory, so no restart is needed unless a migration is pending; none is): `/volunteer` returns 200 and contains the choice cards and the ZIP form; `/volunteer/projects` and `/volunteer/donate` return 200; `/volunteer/donate?type=FOOD` shows the form with Food chosen and `/volunteer/donate?type=nope` shows the chooser; `curl -I /projects` and `curl -I "/projects?zip=28801"` and `/projects/<any id>` return a 308 whose `Location` is the new path with the query kept; the main navigation no longer contains a Projects link. If a signed-in browser is available, walk the funnel; otherwise state that this was not verified.
- [ ] **Step 4: Commit**

```bash
git add README.md docs
git commit -m "docs: volunteer and donate hub"
```
