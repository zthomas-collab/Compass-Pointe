# Give to Organizations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a giver send an in-kind offer straight to a chosen organization, which works it from a new dashboard Offers tab. Organizations can also publish an administrator-approved "Give money" link to their own donation page.

**Architecture:** One additive migration (`0017_org_giving.sql`) adds the donation link with its own approval status, accepted offer types, and `contribution_offers.organization_id`, with guard and RLS rules enforced in PostgreSQL. Services: `directory.ts` (profile and link review), `offers.ts` (intake and staff side), new `org-offers.ts` (organization side), new `listEventHelpers` in `events.ts`. Pages reuse existing components and patterns.

**Tech Stack:** Next.js 16 (read `node_modules/next/dist/docs/` first, per `AGENTS.md`), PostgreSQL 18 + PostGIS via PGlite in tests, zod 4, Vitest 3.

**Spec:** `docs/superpowers/specs/2026-11-18-give-to-organizations-design.md`

## Global Constraints

- Visibility is enforced in PostgreSQL (RLS, public views, triggers) **and** in services.
- Offer status changes go through `ics.offers_guard()` and `ics.offer_transition_ok`, and every one is recorded in append-only `contribution_offer_events`.
- Never put a giver's name, email or phone in an email to staff or organizations, an audit `details`, or a log line.
- Client components never import `src/server/**`; shared constants go in `src/lib/`.
- Accessibility: keyboard reachable, labelled landmarks (`aria-labelledby` sections as on the event page), no color-only meaning, external links `target="_blank" rel="noopener noreferrer nofollow"` with "(opens in a new tab)" in `sr-only`.
- Seeded records are labelled `[SYNTHETIC]`; test records `[TEST]` via `tests/helpers/fixtures.ts`.
- "Eligible organization" = `status = 'APPROVED' AND NOT publication_suspended AND profile_status = 'APPROVED' AND directory_consent_at IS NOT NULL`.
- Per-email limit stays **3 offers per 24 hours**, counted across all destinations.
- Run `npm run check` (lint + typecheck + tests) before every commit; all 303 existing tests stay green.

## Review Focus

1. **A donation link edited after approval:** the old approved URL must disappear publicly at once; nothing shows until it is re-approved. *(Task 1 test `link change resets approval even by direct SQL`)*
2. **A `?org=` link whose organization doesn't accept the `?type=` in the address:** show that organization's chooser of accepted types, never the form with an unaccepted type, never an error. *(Task 2 test `giveTarget filters types`; Task 6 page check)*
3. **An organization that becomes ineligible while it has open offers:** its editors can no longer list, open or move them (NOT_FOUND), while county administrators still can. *(Task 4 test `ineligible org loses access`)*
4. **A county administrator rescuing an offer for an organization that serves none of their counties:** refused as NOT_FOUND. *(Task 3 test `rescue scope`)*
5. **A `javascript:`, `data:` or bare-domain donation link:** rejected with a field error. *(Task 2 test `donation url validation`)*

---

### Task 1: Migration 0017 — schema, guard, RLS, public view

**Files:**
- Create: `db/migrations/0017_org_giving.sql`
- Test: `tests/giving-db.test.ts`

**Interfaces:**
- Produces (SQL):
  - `organizations.donation_url text`, `donation_url_status text NOT NULL DEFAULT 'NONE' CHECK (IN ('NONE','PENDING','APPROVED','REJECTED'))`, `donation_url_reviewed_by uuid REFERENCES users(id)`, `donation_url_reviewed_at timestamptz`, `donation_url_review_note text CHECK (length <= 2000)`
  - trigger `organizations_donation_url_reset` (BEFORE UPDATE): when `donation_url IS DISTINCT FROM OLD.donation_url`, set status `PENDING` (or `NONE` if NULL) and null the three reviewer fields
  - table `organization_accepted_offer_types (org_id uuid REFERENCES organizations(id) ON DELETE CASCADE, offer_type text CHECK (IN the ten contribution types), PRIMARY KEY (org_id, offer_type))`
  - `contribution_offers.organization_id uuid REFERENCES organizations(id)`; `CHECK (organization_id IS NULL OR consent_share)`; index `(organization_id, status, created_at DESC)`
  - `contribution_offer_events.actor_role` CHECK gains `'ORG'` (drop and re-add the constraint)
  - `ics.org_is_eligible(p_org uuid) RETURNS boolean` (SECURITY DEFINER; the Global Constraints definition)
  - `ics.can_view_directed_offer(p_org uuid) RETURNS boolean`: false when `p_org IS NULL`; otherwise `ics.is_platform_admin()` OR the viewer administers a county in `organization_counties` for `p_org` (`= ANY (ics.viewer_county_ids())`) OR (active `ORG_ADMIN`/`EDITOR` membership of an active user AND `ics.org_is_eligible(p_org)`)
  - policies `offers_select` and `offer_events_select` replaced to OR in `ics.can_view_directed_offer(organization_id)`
  - `ics.offers_guard()` replaced, adding: `organization_id` may change only when `OLD.organization_id IS NOT NULL AND NEW.organization_id IS NULL AND OLD.status = 'MATCHED' AND NEW.status = 'REVIEWED' AND actor_role IN ('COUNTY_ADMIN','EXECUTIVE')`; any `actor_role = 'ORG'` move to `REVIEWED` raises `42501`
  - `public_contacts` dropped and recreated exactly as in `0008`, plus `CASE WHEN o.donation_url_status = 'APPROVED' THEN o.donation_url END AS donation_url` and `coalesce((SELECT array_agg(offer_type ORDER BY offer_type) FROM organization_accepted_offer_types WHERE org_id = o.id), '{}') AS accepted_offer_types`; re-`GRANT SELECT ... TO ics_anon, ics_app`
  - `GRANT SELECT ON organization_accepted_offer_types TO ics_app`

- [ ] **Step 1: Write the failing tests** in `tests/giving-db.test.ts`. Use the `offers.test.ts` setup (`freshDb`, `makeUser`, `makeOrg`, `createCounty`, `assignCountyAdmin`, `sys`, `code`). Create: org `G` (eligible, consent true, editor `gEd`, viewer `gView`, serves countyA), org `O` (eligible, editor `oEd`), county admins `adminA`/`adminB`, executive. Insert offers with direct SQL under `sys`.
  - `link change resets approval even by direct SQL`: set `donation_url` and status `APPROVED`, then `UPDATE organizations SET donation_url = 'https://other.example'`; expect status `PENDING`, reviewer fields null, and `SELECT donation_url FROM public_contacts WHERE id = G` (as `anon`) is `null`. Setting it to NULL gives `NONE`.
  - `only approved links reach public_contacts`: `APPROVED` → URL visible to anon; `REJECTED` → null.
  - `accepted types appear in public_contacts`: insert `FOOD`, `DRINKING_WATER` → `accepted_offer_types` equals `['DRINKING_WATER','FOOD']`; inserting `'GOLD'` fails with `23514`.
  - `directed offer needs consent_share`: insert with `organization_id = G, consent_share = false` → `23514`.
  - `directed offer visibility`: an offer for G from a ZIP in countyB is visible (`viewer` context) to `gEd`, `adminA` (G serves countyA), the executive and `adminB` (giver's county); **not** to `gView`, `oEd` or anon. A central offer (no org) stays invisible to `gEd`.
  - `ineligible org loses visibility`: set G `publication_suspended = true` → `gEd` sees 0 rows; `adminA` still sees it. Same for `profile_status = 'HIDDEN'` and `directory_consent_at = NULL`.
  - `organization_id is set-once except admin rescue`: with `ics.actor_role = 'ORG'`, changing `organization_id` raises `42501`; `ORG` moving `MATCHED → REVIEWED` raises `42501`; `COUNTY_ADMIN` moving `MATCHED → REVIEWED` with `organization_id = NULL` succeeds and writes a `STATUS_CHANGED` event; pointing it at org O raises `42501`.
  - `ORG actor_role is accepted in offer events`.

- [ ] **Step 2: Run to verify they fail**
  Run: `npx vitest run tests/giving-db.test.ts`
  Expected: FAIL (`column "donation_url" does not exist`).

- [ ] **Step 3: Write `db/migrations/0017_org_giving.sql`** with the objects above. Use a header comment in the style of `0012`: additive, reversible, with what each object enforces. `migrations.test.ts` picks the file up automatically; check it still passes.

- [ ] **Step 4: Run the tests**
  Run: `npx vitest run tests/giving-db.test.ts tests/migrations.test.ts tests/offers.test.ts tests/crisis-compass-foundation.test.ts`
  Expected: PASS.

- [ ] **Step 5: Commit**
  `git add db/migrations/0017_org_giving.sql tests/giving-db.test.ts && git commit -m "feat(giving): migration for org-directed offers, donation link approval, accepted types"`

---

### Task 2: Directory service — giving profile fields, link review, give target

**Files:**
- Modify: `src/server/modules/directory.ts` (`OrganizationProfile`, `getOrganizationProfile`, `profileSchema`, `updateOrganizationProfile`, `PublicOrganization`, `getPublicOrganization`)
- Create: `src/server/modules/giving.ts`
- Test: `tests/giving-profile.test.ts`

**Interfaces:**
- Consumes: Task 1 columns and view.
- Produces:
  - `OrganizationProfile` gains `donationUrl: string | null; donationUrlStatus: "NONE" | "PENDING" | "APPROVED" | "REJECTED"; donationUrlReviewNote: string | null; acceptedOfferTypes: OfferType[]`
  - `profileSchema` gains `donationUrl: optional(300)` refined with `parseWebUrl` (the existing message), and `acceptedOfferTypes` (same preprocess as `countyIds`, `z.array(z.enum(OFFER_TYPES)).max(10)`). `updateOrganizationProfile` writes `donation_url` (normalised URL) and replaces accepted types. The audit details add `{ donationLinkChanged: boolean, acceptedTypes: number }`, never the URL text.
  - `PublicOrganization` gains `donationUrl: string | null; acceptedOfferTypes: OfferType[]` (read from `public_contacts`)
  - in `giving.ts`:
    - `donationLinkReviewSchema = z.object({ orgId: uuid, decision: z.enum(["APPROVED","REJECTED"]), note: z.string().trim().max(2000) })`. The note is required (min 5) for `REJECTED`.
    - `reviewDonationLink(driver: Driver, actorId: string, raw: unknown): Promise<void>`. Scope is the same as `reviewOrganizationProfile` (executive, or administrator of a served county). CONFLICT if status is not `PENDING`. Audit action `ORG_DONATION_LINK_APPROVED` / `_REJECTED`.
    - `type DonationLinkReviewRow = { orgId: string; displayName: string; url: string; host: string; countiesServed: string[] }`
    - `listDonationLinksForReview(driver: Driver, actorId: string): Promise<DonationLinkReviewRow[]>`: `PENDING` only, scoped as above
    - `type GiveTarget = { orgId: string; displayName: string; acceptedOfferTypes: OfferType[]; donationUrl: string | null }`
    - `getGiveTarget(driver: Driver, orgId: unknown): Promise<GiveTarget | null>`: reads `public_contacts` as `anon`. Returns null for unknown, ineligible or invalid ids, and when `acceptedOfferTypes` is empty.

- [ ] **Step 1: Write the failing tests** in `tests/giving-profile.test.ts`:
  - `profile saves donation link as pending and accepted types`: an ORG_ADMIN saves `donationUrl: "https://give.example.org/relief"` and `acceptedOfferTypes: ["FOOD","DRINKING_WATER"]`. `getOrganizationProfile` shows `donationUrlStatus: "PENDING"` and both types. `getPublicOrganization(...).donationUrl` is `null`.
  - `donation url validation`: `"javascript:alert(1)"`, `"data:text/html,x"` and `"give.example.org"` each → `VALIDATION` with a `donationUrl` field error.
  - `review approves and rejects with scope`: an executive approves → public `donationUrl` set. A county admin of an unserved county → `FORBIDDEN`. Reject without a note → `VALIDATION`. Reviewing a non-pending link → `CONFLICT`.
  - `review list is scoped`: a county admin sees only pending links of orgs serving their counties, with `host` = `give.example.org`.
  - `giveTarget filters types`: an eligible org with types → target with those types. An org with none → `null`. A suspended org → `null`. `"not-a-uuid"` → `null`.
  - `audit never stores the URL`: `audit_logs.details::text` for the org contains no `give.example.org`.

- [ ] **Step 2: Run** `npx vitest run tests/giving-profile.test.ts` → FAIL (missing exports).
- [ ] **Step 3: Implement** the interfaces above. `getPublicOrganization` and the Contacts query need no WHERE changes; only add the columns.
- [ ] **Step 4: Run** `npx vitest run tests/giving-profile.test.ts tests/contacts-types-images.test.ts tests/crisis-compass-foundation.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat(giving): donation link and accepted types on profiles, link review, give target`

---

### Task 3: Offers service — directed intake and staff side

**Files:**
- Modify: `src/server/modules/offers.ts`
- Test: `tests/giving-offers.test.ts`

**Interfaces:**
- Consumes: `getGiveTarget` (Task 2), Task 1 schema.
- Produces:
  - `offerSchema` gains `organizationId: uuid.optional().or(z.literal("").transform(() => undefined))`
  - `submitOffer(driver, raw): Promise<{ reference: string; id: string; organizationName: string | null }>`. When `organizationId` is set:
    - re-check eligibility and that `contributionType` is accepted, inside the transaction (`VALIDATION`, field `organizationId`, message "This organization isn't taking that kind of donation right now.")
    - require `consentShare` (`VALIDATION`, field `consentShare`)
    - insert with `status = 'MATCHED'` and `organization_id`; the SUBMITTED event note is `'Offer sent to an organization.'`
    - queue `OFFER_NEW_ORG` to the org's `contact_email`: subject `"<brand>: new <type> offer <ref>"`, body with reference, type, ZIP and `<base>/dashboard/orgs/<orgId>/offers/<id>`, no giver details
    - the receipt (`OFFER_RECEIPT`) says "We sent your offer to <org display name>. They will contact you to arrange it."
    - the central `OFFER_NEW` email is **not** sent
  - `OfferSummary` gains `recipientOrgId: string | null; recipientOrgName: string | null`
  - `actorFor(tx, userId, offer: { county_id: string | null; organization_id: string | null })`: `EXECUTIVE`, or `COUNTY_ADMIN` when the user administers the giver's county **or** a county the recipient org serves; else `NOT_FOUND`. Used by `transitionOffer`, `addOfferNote`, and `assertStaff` callers.
  - `transitionOffer`: when the offer has an org and `to = 'REVIEWED'` (rescue), the same UPDATE sets `organization_id = NULL` and the event note is `"Returned from <org name> (<org id>) to central triage. <note>"`. For directed offers, staff may only move to `REVIEWED` or `CANCELED`, or add notes; other targets → `CONFLICT` ("The organization accepts or declines this offer.").
  - `listOffers` gains filter `destination: "all" | "central" | "org"` (default `"all"`).

- [ ] **Step 1: Write the failing tests** in `tests/giving-offers.test.ts` (setup as in Task 1; G accepts `DRINKING_WATER` only):
  - `directed offer is MATCHED and notifies the org, not central`: a `submitOffer` with `organizationId: G, consentShare: "on", contributorName: "SECRET-NAME-MARKER"` gives status `MATCHED` and `organization_id = G`. One `OFFER_NEW_ORG` job goes to `private-contact@example.test` without the marker. No new `OFFER_NEW` job, even with the central email set. The receipt names the org.
  - `directed offer refuses unaccepted type, ineligible org, missing consent`: `FOOD` → `VALIDATION`; suspended org → `VALIDATION`; `consentShare: ""` → `VALIDATION`.
  - `rate limit spans destinations`: 2 central + 1 directed from one email, then a 4th → `RATE_LIMITED`.
  - `staff cannot accept for the org`: `adminA` → `ACCEPTED` gives `CONFLICT`.
  - `rescue clears the org`: `adminA` → `REVIEWED` with a note. `organization_id` is null and the event note contains G's name. `gEd` can no longer see the row (`viewer` query).
  - `rescue scope`: `adminB` (giver's county only) may rescue. A county admin of a third county → `NOT_FOUND`.
  - `listOffers destination filter`: `destination: "org"` returns only directed rows, with `recipientOrgName` set.

- [ ] **Step 2: Run** `npx vitest run tests/giving-offers.test.ts` → FAIL.
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run** `npx vitest run tests/giving-offers.test.ts tests/offers.test.ts` → PASS (existing central behavior unchanged).
- [ ] **Step 5: Commit** `feat(giving): offers sent to an organization; staff rescue and scope`

---

### Task 4: Organization-side offers service

**Files:**
- Create: `src/server/modules/org-offers.ts`
- Test: `tests/org-offers.test.ts`

**Interfaces:**
- Consumes: `OfferSummary`, `OfferDetail`, `OFFER_STATUS_LABELS`, `offerTransitionSchema` from `offers.ts`; `membershipRole` from `directory.ts`.
- Produces:
  - `ORG_OFFER_MOVES: [OfferStatus, OfferStatus][] = [["MATCHED","ACCEPTED"],["MATCHED","DECLINED"],["ACCEPTED","SCHEDULED"],["ACCEPTED","CANCELED"],["SCHEDULED","COMPLETED"],["SCHEDULED","CANCELED"]]`
  - `assertOrgOfferAccess(tx: Tx, userId: string, orgId: string): Promise<void>`: `ORG_ADMIN`/`EDITOR` with an active membership **and** the org eligible; else `NOT_FOUND`
  - `listOrgOffers(driver, userId, orgId, raw?: { status?: OfferStatus; page?: number }): Promise<{ rows: OfferSummary[]; page: number; hasMore: boolean; counts: Record<string, number> }>`: open first (`MATCHED`, `ACCEPTED`, `SCHEDULED`), then newest; page size `OFFER_PAGE_SIZE`; read in `viewer` context so RLS applies
  - `getOrgOffer(driver, userId, orgId, offerId): Promise<OfferDetail & { allowedNext: OfferStatus[] }>`: `allowedNext` from `ORG_OFFER_MOVES`. Audits `OFFER_VIEWED` with `actorOrgId`. NOT_FOUND if the offer isn't this org's.
  - `transitionOrgOffer(driver, userId, orgId, raw): Promise<void>`: reason required for `DECLINED`/`CANCELED`; sets `ics.actor_role = 'ORG'`; audit `OFFER_<TO>` with `actorOrgId`. On `ACCEPTED`, queue `OFFER_ACCEPTED` to the giver: "<org> accepted your offer <ref> and will contact you to arrange it." On `DECLINED`, queue `OFFER_DECLINED`: "<org> can't use your offer <ref> right now. Other organizations working this disaster: <base>/volunteer". No reason text goes in that email.
  - `addOrgOfferNote(driver, userId, orgId, offerId, note): Promise<void>`: actor_role `ORG`

- [ ] **Step 1: Write the failing tests** in `tests/org-offers.test.ts`:
  - `editor lists and opens only own org offers`: `gEd` lists G's directed offers. `oEd` listing G → `NOT_FOUND`. `gView` → `NOT_FOUND`. Opening writes an `OFFER_VIEWED` audit.
  - `org moves through accept, schedule, complete`, with one event per move, `actor_role = 'ORG'`.
  - `decline needs a reason and emails the giver without it`: decline with no note → `VALIDATION`. With the note `"PRIVATE-REASON"`, the `OFFER_DECLINED` job exists and its body lacks `PRIVATE-REASON`.
  - `org cannot send back to triage`: `transitionOrgOffer(... to: "REVIEWED")` → `CONFLICT`.
  - `ineligible org loses access`: after `profile_status = 'HIDDEN'`, list/get/transition → `NOT_FOUND`. `adminA` can still `getOffer` it.
  - `removed member loses access`: after the membership `status = 'REVOKED'`, → `NOT_FOUND`.

- [ ] **Step 2: Run** `npx vitest run tests/org-offers.test.ts` → FAIL.
- [ ] **Step 3: Implement** `org-offers.ts`.
- [ ] **Step 4: Run** `npx vitest run tests/org-offers.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat(giving): organization offers service`

---

### Task 5: "Who's helping" for an event

**Files:**
- Modify: `src/server/modules/events.ts`
- Test: add `describe("who's helping")` to `tests/giving-offers.test.ts`, or a new `tests/event-helpers.test.ts` reusing `eventlinks.test.ts` setup patterns

**Interfaces:**
- Produces:
  - `type EventHelper = { orgId: string; displayName: string; countiesServed: string[]; acceptedOfferTypes: OfferType[]; donationUrl: string | null; openSpots: number; hasUrgent: boolean }`
  - `listEventHelpers(driver: Driver, eventId: string): Promise<EventHelper[]>`, read as `anon` from public views only. Returns [] for an invalid, draft or closed event. The orgs are `public_contacts` rows whose id appears in (a) `public_projects.org_id` for `public_event_links` of the event, or (b) `public_sites.org_id` inside the event area (same area predicate as `getEventHelp`; extract it to a shared SQL fragment rather than copying). `openSpots` = sum of spots left over that org's linked projects' `public_project_needs`. Order: `hasUrgent DESC, displayName, orgId`.

- [ ] **Step 1: Write the failing tests:**
  - `helpers include orgs with linked projects or sites in the area`: one org with a linked project, one with a public site in the area, and one with neither. Only the first two are returned, with the urgent one first.
  - `hidden or ineligible orgs are excluded` (profile HIDDEN).
  - `closed event returns []`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** with `tests/events.test.ts tests/eventlinks.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat(giving): list organizations helping in an event`

---

### Task 6: Public pages — event, organization, project, donate, thanks

**Files:**
- Create: `src/components/give-card.tsx`, a server component `GiveCard({ org }: { org: { orgId: string; displayName: string; acceptedOfferTypes: OfferType[]; donationUrl: string | null; openSpots?: number; countiesServed?: string[] } })` that renders the card from the spec. `EventHelper` fits it directly; the org page passes its `PublicOrganization` fields.
- Modify: `src/app/events/[slug]/page.tsx` (new section `id="helpers-h"` "Who's helping", between Help and Needs, hidden when empty)
- Modify: `src/app/orgs/[orgId]/page.tsx` (actions row: Offer supplies → `/volunteer/donate?org=<id>`, Give money ↗, plus "Accepts: …")
- Modify: `src/app/volunteer/projects/[id]/page.tsx` ("Can't make a shift? Offer supplies to <org>" when the org accepts any type)
- Modify: `src/app/volunteer/donate/page.tsx`, `src/components/donate-chooser.tsx`, `src/components/offer-forms.tsx`, `src/app/volunteer/actions.ts`
- Modify: `src/app/volunteer/thanks/page.tsx`

**Interfaces:**
- Consumes: `listEventHelpers` (Task 5), `getGiveTarget` and `PublicOrganization.donationUrl/acceptedOfferTypes` (Task 2), `submitOffer` returning `organizationName` (Task 3).
- Produces: `OfferForm` gains the props `organization?: { id: string; name: string }`. When set, it renders a hidden `organizationId` input, hides the "Organization (optional)" giver field's helper text about central review, and turns the `consentShare` checkbox into a **required** one labelled `Share my name, email and phone with <name> so they can arrange this`. `DonateChooser` gains `allowedTypes?: OfferType[]` and `orgId?: string` (links carry `?org=`). The thank-you page reads `?org=<name>` only to render "They will contact you"; no personal data goes in the address.

- [ ] **Step 1: Read** `node_modules/next/dist/docs/` for `searchParams` and server actions before editing.
- [ ] **Step 2: Implement the donate page rules:** `org` resolves through `getGiveTarget`.
  - null → the normal chooser with a notice: "That organization isn't taking donations through Crisis Compass right now. You can still offer to our coordinators."
  - valid org and a `type` it accepts → the form with `organization`
  - valid org and a missing or unaccepted `type` → the chooser limited to `allowedTypes`, headed "Give to <name>"
- [ ] **Step 3: Implement** the event, org, project and thanks changes, and `GiveCard`. Buttons render only when they apply (spec: Pages).
- [ ] **Step 4: Verify in the browser** (`npm run dev` after `npm run db:seed`): event page shows Who's helping; `/volunteer/donate?org=<id>&type=FOOD` for an org without FOOD shows the limited chooser; a submit lands on thanks naming the org; `/dev/outbox` shows the org email without giver details. Run axe from the devtools console (`axe.run()` via the vendored `axe-core`) on the four pages: 0 violations.
- [ ] **Step 5: Run** `npm run check` → PASS. **Commit** `feat(giving): give-to-organization actions on public pages and donate flow`

---

### Task 7: Organization dashboard and administration pages

**Files:**
- Modify: `src/app/dashboard/orgs/[orgId]/profile/page.tsx` and its form in `src/components/forms.tsx` (or wherever the profile form lives): "Give money link" field with a status line ("Waiting for approval", "Approved", "Not approved: <note>") and an "Offers we accept" checklist of `OFFER_TYPE_LABELS`
- Create: `src/app/dashboard/orgs/[orgId]/offers/page.tsx` (list with status filter and counts), `src/app/dashboard/orgs/[orgId]/offers/[id]/page.tsx` (detail, history, `OfferTransitionForm` with `allowedNext`, `OfferNoteForm`), `src/app/dashboard/orgs/[orgId]/offers/actions.ts`
- Modify: `src/app/dashboard/page.tsx` (an "Offers" button beside "Projects", with the open count)
- Modify: `src/app/admin/profiles/page.tsx` (a "Give money links waiting" section: full URL, host in bold, Approve / Reject with note)
- Modify: `src/app/admin/offers/page.tsx` and `[id]/page.tsx` (destination filter; "Sent to <org>" badge; directed offers offer only "Return to central triage" and Cancel)

**Interfaces:**
- Consumes: `listOrgOffers`, `getOrgOffer`, `transitionOrgOffer`, `addOrgOfferNote` (Task 4); `reviewDonationLink`, `listDonationLinksForReview` (Task 2); `listOffers` `destination` and `recipientOrgName` (Task 3).

- [ ] **Step 1: Implement** the pages, reusing `OfferTransitionForm` and `OfferNoteForm` with the org actions. Labels come from `OFFER_STATUS_LABELS`.
- [ ] **Step 2: Verify in the browser:** as the seeded org editor, accept → schedule → complete an offer, and see the giver's emails in `/dev/outbox`. As the executive, approve a pending link, then confirm it appears on `/orgs/<id>`. Edit the link as the org and confirm it disappears publicly. axe: 0 violations on the new pages.
- [ ] **Step 3: Run** `npm run check` → PASS. **Commit** `feat(giving): organization Offers tab, donation link review, admin offer destination`

---

### Task 8: Demo disaster seed and docs

**Files:**
- Modify: `scripts/cli.ts` (`seed()`)
- Modify: `README.md`, `docs/10-gap-analysis.md`, `docs/03-access-matrix.md`, `docs/04-journeys-sitemap.md`, `docs/runbook.md`

- [ ] **Step 1: Extend `seed()`**, inside the same transaction and `[SYNTHETIC]`-labelled. Add a county record for Buncombe, NC if none exists, and link the existing orgs to it in `organization_counties`. Create an `ACTIVE` event `[SYNTHETIC] Hurricane demo` over Buncombe. Set accepted types and an `APPROVED` donation link (`https://example.org/donate`) on "Mountain Response Network". Set goods-only types on "Blue Ridge Community Pantry". Add one linked project with an urgent role. Add three directed offers in `MATCHED`, `ACCEPTED` and `COMPLETED` (synthetic givers, `@example.invalid`, `is_synthetic = true`). Use the existing services where they exist (`createCounty`, `createEvent`, `setEventStatus`) and direct SQL elsewhere, as the seed already does.
- [ ] **Step 2: Verify:** delete the local PGlite folder (`PGLITE_DATA_DIR`, default `./.data/pglite`), then `npm run db:seed && npm run dev`. The event page shows Who's helping with both orgs, and the org editor's Offers tab shows three offers.
- [ ] **Step 3: Update the docs:**
  - README: a "Give to organizations" bullet under the upgrade list, and the test count from the real run
  - gap analysis: the community-projects row notes giving is routed to orgs
  - access matrix: directed offers (rows for org editors, viewers, county admins of served counties, executives)
  - sitemap: the new routes
  - runbook: givers' details are now held by the receiving organization, and retention (item 5) must cover `contribution_offers`
- [ ] **Step 4: Run** `npm run check` → PASS. **Commit** `feat(giving): demo disaster seed; docs`
