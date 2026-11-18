# Give to organizations — design

Status: **draft for approval** · 2026-11-18 · Size: a project (one migration, service changes, four pages touched, one new dashboard tab)

## Intent and why

Crisis Compass is being pitched to nonprofits and FEMA / emergency-management organizations as a pipeline with two paths through a disaster:

1. **"I need help"**: a survivor finds what is open near them (already built: map, events, Help list).
2. **"I want to help"**: someone outside the area finds **who is working the disaster and gives to them**.

Today the second path stops short. Every in-kind offer from `/volunteer/donate` lands in **one central Crisis Compass inbox** (`platform_settings.offers_notification_email`, reviewed at `/admin/offers`). A giver can't choose an organization, and an organization never sees offers made for it. The owner chose (2026-11-18) to **route giving straight to the organization doing the work**, with an optional link to the organization's own money-donation page. The platform still never handles money.

This is the first of five items being built for the pitch (then: a resource library, projects on the map, browser + accessibility tests, a retention job). It should demo as a live click-through.

## Goals

1. A giver can pick a specific organization and send it an in-kind offer. The offer goes to that organization and is worked by that organization.
2. Organization editors get an **Offers** tab in their dashboard (`/dashboard/orgs/<id>/offers`) where they accept, schedule, complete or decline offers made to them.
3. An organization can publish a **"Give money"** link to its own donation page. It is shown publicly **only after an administrator approves it**, and any change to it goes back for approval.
4. An organization says **which kinds of in-kind giving it accepts** (from the existing ten offer types), so givers see "Accepts: water · food · cleaning supplies" and the form only offers those.
5. Givers can reach an organization's give options from: the **event page** (a new "Who's helping" section), the **public organization page** (`/orgs/<id>`), and a **project page** (`/volunteer/projects/<id>`).
6. The central inbox stays as the fallback for "I don't know who to give to." Its behavior is unchanged.

## Non-goals

- Taking, processing or tracking money. The money link goes off-site; we record nothing about what happens there.
- Goods needs with quantities and pledges (stage 6 of the events-and-projects design). "Accepts" here is a list of types, not "we need 400 cases of water."
- Offer matching or suggestions, donor accounts or a donor dashboard, real email delivery (still M4; mail queues at `/dev/outbox`).
- Changing who can see the central-inbox offers.

## Anti-goals (a failure even if it technically works)

- An unapproved or changed money link ever showing publicly, even briefly.
- A giver's name, email or phone reaching anyone other than the receiving organization's editors (while it is eligible), administrators of the counties it serves, and executives.
- An organization seeing offers made to a different organization, or to the central inbox.
- Offers to an organization that is suspended, unapproved or has a hidden profile.
- A giver hitting a dead end: every page says what happens next.
- Breaking any existing offer, sign-up or admin flow, or the 303 existing tests.

## Constraints

- `AGENTS.md`: this Next.js has breaking changes; read `node_modules/next/dist/docs/` before writing page code.
- Visibility is enforced in PostgreSQL (RLS, public views) **and** in services, as everywhere else in the project.
- Offer status changes go through `ics.offers_guard()`, are validated by `ics.offer_transition_ok`, and are recorded in the append-only `contribution_offer_events`.
- Never log or audit a giver's name, email or phone (runbook rule for personal data).
- Client components must not import server modules; shared constants live in `src/lib/`.
- Accessibility parity with the rest of the site: keyboard, landmarks, no color-only meaning, axe clean.
- Seeded data stays labelled **[SYNTHETIC]**.

## Approaches considered

**Where giving goes (owner's choice):** (A) directly to the chosen organization, which works the offer, plus an approved link to its own money page; (B) keep one central inbox that staff sort and forward. **Chosen: A.** It answers "who do I give to" for the pitch, and a central team would be a bottleneck in a real disaster.

**How the money link is approved:** (1) a link column on `organizations` with its **own** approval status (`PENDING` / `APPROVED` / `REJECTED`), reset to `PENDING` on any change; (2) reuse the existing profile approval and send the whole profile back to `PENDING` when the link changes. **Chosen: 1.** Option 2 would hide an organization's whole public profile, contacts listing and logo every time it edits one link.

**What an organization "accepts":** (1) a list of accepted offer types on the organization; (2) full goods needs with quantities (stage 6). **Chosen: 1** for now. It is small and makes the cards honest; stage 6 can add quantities later without undoing it.

## Design

### Data (migration `0017_org_giving.sql`)

On `organizations`:
- `donation_url text` (nullable, `http(s)` only, max 300, validated with the existing `parseWebUrl`).
- `donation_url_status text NOT NULL DEFAULT 'NONE' CHECK IN ('NONE','PENDING','APPROVED','REJECTED')`, plus `donation_url_reviewed_by uuid`, `donation_url_reviewed_at timestamptz`.
- A trigger: whenever `donation_url` changes, status becomes `PENDING` (or `NONE` when cleared) and the reviewer fields are cleared. The service does the same; the trigger makes it impossible to skip.

New table `organization_accepted_offer_types (org_id, offer_type)`, with `offer_type` checked against the same ten values as `contribution_offers.contribution_type`.

On `contribution_offers`:
- `organization_id uuid REFERENCES organizations(id)` (nullable; NULL = central inbox, exactly as today). Set at insert time. The only allowed change is an **administrator rescue** (below), which sets it back to NULL; `offers_guard` rejects every other change.
- RLS: `offers_select` widens to `ics.can_view_offer(county_id) OR ics.can_view_directed_offer(organization_id)`. The new function is true when the viewer is:
  - an active `ORG_ADMIN` or `EDITOR` of that organization **while the organization is still eligible** (`APPROVED`, not `publication_suspended`, `profile_status = 'APPROVED'`, directory consent present), or
  - an administrator of **any county that organization serves** (`organization_counties`), or an executive.

  *(My call: the giver's ZIP is usually outside the disaster area, so the giver's county would hide these offers from the administrators who know the organization.)* `VIEWER` members get no access, so contact details stay with editors. Offer events follow the same rule. `actorFor`, `listOffers` and `addOfferNote` use the same county rule for directed offers.
- `contribution_offer_events.actor_role` gains `'ORG'`.
- `consent_share` must be true when `organization_id` is set (CHECK constraint).

Public view `public_contacts` (used by `/orgs/<id>` and Contacts) gains `donation_url` **only when `donation_url_status = 'APPROVED'`** (otherwise NULL) and `accepted_offer_types`. The view is dropped and recreated in the migration with grants re-applied, as `0008` did.

### Offer status for offers sent to an organization

A directed offer is created as **`MATCHED`**: the giver has already chosen who it's for. From there the existing moves apply:

```
MATCHED → ACCEPTED → SCHEDULED → COMPLETED
MATCHED → DECLINED (reason required)     ACCEPTED/SCHEDULED → CANCELED (reason required)
```

**Rescue.** `MATCHED → REVIEWED` is allowed **only for administrators**, never for the organization. It sends the offer back to central triage, so an administrator can rescue an offer the organization can't use. The rescue clears `organization_id` in the same update, so the organization stops seeing the offer and its contact details. It also writes an event recording which organization it came from (the organization's id and name in the note). From there it is an ordinary central offer. *(My call.)*

The organization acts with `actor_role = 'ORG'`. Only `ORG_ADMIN` and `EDITOR` can see offers, move their status or add notes. Every organization action re-checks eligibility.

**When an organization stops being eligible** (suspended, profile hidden or pending, consent withdrawn), its members lose access to its offers right away, because the visibility function checks eligibility. The offers stay visible to that county's administrators, who can rescue them. The giver isn't emailed automatically. A removed member loses access the same way, because membership is checked on every read. *(My call.)*

**MFA:** organization editors don't need MFA to open offers. This matches volunteer rosters, which already show organization editors volunteers' names, emails and phones without MFA. Staff keep their existing MFA gate at `/admin/offers`. *(My call; revisit together with managed authentication, M-series.)*

Administrators of the counties the organization serves, and executives, still see directed offers at `/admin/offers` (shown with the organization's name) and can add notes. They can cancel spam, but accepting or declining is the organization's job.

### Emails (queued through the existing notification worker)

- **To the organization** on a new offer: sent to the organization's private `contact_email`. Same rule as today: no giver contact details in the email, only the reference, the type, the ZIP and a sign-in link to the Offers tab.
- **To the giver**: the existing receipt, reworded to name the organization. *(Proposal)* plus a short email when the organization **accepts** or **declines** (with "other organizations working this disaster" linking to the event, or `/volunteer`).

### Pages

**Who's helping** (new section on `/events/<slug>`, between Help and Needs): organizations with an approved public profile that either have a linked open project in the event, or a public site inside the area. Each card:

```
┌ Coastal Relief Network ─────────────── Serving: Lee, Collier ┐
│ Accepts: drinking water · food · cleaning supplies           │
│ Volunteer: 6 driver spots open                               │
│ [Offer supplies]  [Give money ↗]  [Volunteer]                │
└──────────────────────────────────────────────────────────────┘
```

Buttons show only when they apply: Offer supplies if it accepts at least one type, Give money if a link is approved, Volunteer if it has open spots.

**Public organization page** `/orgs/<id>`: the same three actions near the top, plus "Accepts: …".

**Project page** `/volunteer/projects/<id>`: below the roles, "Can't make a shift? Offer supplies to <organization>" when it accepts any type.

**Donate form** `/volunteer/donate?org=<id>&type=<TYPE>`: with `org`, the heading says "Give to <organization>", the type chooser lists only the types that organization accepts. The share-details checkbox becomes **required** and names the organization ("Share my name, email and phone with <organization> so they can arrange this"). It is stored as `consent_share = true`. *(My call: explicit consent beats a notice for personal data.)* An unknown, hidden, suspended or non-accepting organization falls back to the normal chooser with a short notice (never a 404 that reveals anything). Without `org`, nothing changes: central inbox.

**Thank-you page**: names the organization and says it will contact you. The central version is unchanged.

**Organization dashboard**:
- **Profile** gets a "Give money link" field with its status shown ("Waiting for approval", "Approved", "Not approved: <reason>") and an "Offers we accept" checklist.
- New **Offers** tab: list (newest first, open ones on top, filter by status) and detail (description, quantity, dates, delivery notes, contact details, history, the allowed next moves, notes). Opening the detail is audited, as `getOffer` is today.

**Administration**: `/admin/profiles` gains the pending money links (link shown in full, plus its domain) with Approve / Reject + reason. Executives can approve any; a county administrator can approve organizations serving their counties (same rule as profile review).

### Abuse limits

The existing per-email limit (3 offers in 24 hours) applies across all destinations. An organization can't receive offers unless it is `APPROVED`, not suspended, has `profile_status = 'APPROVED'` and has directory consent.

### Demo data

The seed gains, labelled [SYNTHETIC], at least two organizations in the seeded event's counties: one that accepts several types and has an approved money link, and one that accepts goods only. It also gains a few offers in different states, so the Offers tab is not empty on stage.

### Testing

Vitest against real PostGIS (PGlite), like the rest of the suite:
- directed offer insert → `MATCHED`, visible to that organization's members, invisible to other organizations and to anonymous users; `organization_id` can't be changed;
- organization moves and their limits (`MATCHED → REVIEWED` refused for the organization, reasons required);
- money link: change resets to `PENDING` even by direct SQL; only `APPROVED` reaches `public_contacts`; county-admin scope for approval;
- donate form fallback for ineligible organizations; type filtered by accepted types;
- no giver contact data in any email, audit row or log.

Browser-level tests for these pages come with item 4 (browser + accessibility tests).

## Left to the builder

Exact copy, card layout within the existing brand tokens, the list's page size (reuse `OFFER_PAGE_SIZE`), the "Who's helping" ordering (suggest: organizations with urgent open roles first, then by name), and the migration's exact SQL.
