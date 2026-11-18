# E. User Journeys and Sitemap

## Journeys

### J1 — Public visitor finds water (no account) ✅ implemented
1. Opens `/` on a phone → map centered on the deployment's default area, list available via **List** toggle.
2. Searches "28801" or taps **Near me** (browser asks for consent; location stays on the device and only moves the map).
3. Filters: **Water**, **Only confirmed availability**.
4. Taps a pin or list card → sees operator, address, hours, status ("Available" / "Limited" / **"Unconfirmed — last reported Available"**), last-confirmed time, quantity basis.
5. Taps **Call** (tel: link) or **Directions** (offered only for public locations).
6. Offline/poor signal: banner "Couldn't refresh — showing data from 11:24 AM, availability may have changed"; list is dimmed; auto-retries when back online.

### J2 — Nonprofit onboarding ✅ implemented
1. `/register` → org details + verification notes → "check your email".
2. Email link → `/auth/confirm` → **Confirm email** button (POST, so link scanners can't consume it) → signed in → dashboard shows **PENDING VERIFICATION**; SOP-001 opened with 48 h due date.
3. Platform admin `/admin/organizations` → reviews evidence → **Approve** with evidence summary → org notified (queued email).
4. Rep returns, signs in via magic link → dashboard shows **New site**.

### J3 — Approved org publishes and updates a site from a phone ✅ implemented
1. **New site** → name, visibility (warning shown for Public), **Use my current location**, address fields → **Create site** → immediately on the public map if PUBLIC.
2. **Add a resource** → category, status, quantity + unit + basis, visibility (only equal or stricter than the site).
3. Later: one-tap **Still accurate** / **Limited** / **Depleted** buttons; **record correction** with note (SOP-004). Each writes an append-only event visible under **Recent changes**.
4. **Archive site** → removed from all maps immediately; history preserved.

### J4 — Authorized responder sees restricted logistics ✅ data path implemented (role grant via CLI/SQL for now)
Signed-in responder sees AUTHORIZED_RESPONDERS sites only within their scope polygon, labelled **Restricted — do not share**, with no directions link.

### J5 — Admin suspends a compromised org (SOP-012) ✅ implemented
`/admin/organizations` → **Suspend publication** with reason → all that org's listings disappear from public and network views at once; editing disabled; **Reinstate** reverses.

### J6 — Anyone looks up an organization in Contacts ✅ implemented
`/contacts` (no sign-in; formerly "Black Book") → search by name, description or service type, and/or a ZIP code with a 5–100 mile radius (nearest first, distance shown) → **Call** / **Email** / **Website**. Only approved organizations that opted in are listed, with only the contact details they chose to publish.

### J7 — Account types and the map legend ✅ implemented
Registrant picks a main service type (plus other services) → admin confirms or changes it when approving (required) → every location of that account is drawn in the type's color with a short code (e.g. **MED**, **H2O**, **CM**) → the map legend explains colors and filters by type. Admins can change the type later with a recorded reason.

### J8 — Location photo ✅ implemented
Org editor opens a site → **Add a photo** (phone camera or file) + description → photo is re-encoded with location metadata removed → shown on the map/list to exactly the people who can see the site.

### J9 — Org starts a project at a location, it reaches the map and the event ✅ implemented
Org editor adds a **location** (site) whose ZIP is in a county the org serves → **New project** → picks that location (county and ZIP come from it) → adds volunteer roles → sends for review → a county administrator approves → the app **suggests** every active disaster event whose counties (or ZIPs) cover it → the org editor or county administrator clicks **Add to event** (or **Not this one**) → the project shows on the map at its location ("Volunteers needed here"), on the event page, and on the org's public profile (Volunteer projects · Where we work · Responding to). If the location moves to another covered county, its open projects follow it and go back for review.

### Planned journeys
Road report submission/verification (Phase 5) · restricted (authorized-only) contacts (Phase 4) · stale-record reminder emails (Phase 6) · J9 public "report incorrect info" (Phase 6) · J10 staff invite/revoke (Phase 4).

## Sitemap

Legend: ✅ live in this slice · ⏳ planned (not linked in the UI until it works — acceptance criterion 11)

```
Public
├── /                         ✅ Home / Map + List + Search + Filters; ?site=<id> opens that location (its open projects listed)
├── /safety                   ✅ About / Safety / corrections guidance
├── /register                 ↪ redirects to /signin?tab=register
├── /signin                   ✅ For organizations: Sign in + Register tabs on one page
├── /auth/confirm             ✅ Email confirmation (POST)
├── /auth/callback            ✅ Sign-in link (POST)
├── /resources                ⏳ Find Resources (category landing pages)
├── /roads                    ⏳ Road Conditions
├── /directory                ⏳ Nonprofit Directory (merged into Contacts for now)
├── /contacts                 ✅ Contacts (the spec's public Black Book) — name/description/type/ZIP + radius search
├── /orgs/:id                 ✅ Public organization profile: how to help, volunteer projects, where we work (locations), events it is responding to, contact
├── /events                   ✅ Events: open disaster areas, closed archive
├── /events/:slug             ✅ Event: area, help available there, and the volunteer Needs of projects attached to it
├── /volunteer                ✅ Volunteer & donate hub: "How do you want to help?", ZIP search, shifts needed now, quick gifts, how it works
├── /volunteer/projects       ✅ Find a shift: search by text, ZIP + radius, county (moved from /projects)
├── /volunteer/projects/:id   ✅ Project: volunteer roles, shifts, real spots left, and sign-up (no account)
├── /volunteer/donate         ✅ Donate: choose what you are giving, then a short form with it preselected (?type=FOOD …); ?org=<id> sends it to that organization, limited to what it accepts
├── /volunteer/thanks         ✅ Thank-you after an offer: what happens next, next steps
├── /projects, /projects/:id  ↪ permanent redirects to /volunteer/projects (query string kept); no longer in the main navigation
├── /volunteer/commitments    ✅ Private emailed link: confirm or cancel a sign-up; confirmed volunteers see where to go
└── /black-book               ↪ redirects to /contacts

Authenticated
├── /dashboard                ✅ Organization Dashboard + My Staging Locations
├── /dashboard/orgs/:id/sites/new  ✅ New staging site
├── /dashboard/orgs/:id/projects   ✅ My organization's projects
├── /dashboard/orgs/:id/offers     ✅ Offers givers sent to my organization (accept, schedule, complete, decline)
├── /dashboard/projects/:id        ✅ Edit a project and its volunteer roles, send for review, pause, complete; volunteer roster and attendance; attach it to disaster events, add or dismiss suggested events
├── /dashboard/sites/:id      ✅ Site detail: inventory, Update Availability, history
├── /dashboard/roads/new      ⏳ Submit Road Report
├── /dashboard/orgs/:id/profile ✅ My Organization Profile (public contacts, office ZIP, services, Contacts consent)
├── /dashboard/contacts       ⏳ Authorized (restricted) contacts
├── /dashboard/notifications  ⏳ Notifications
└── /dashboard/team           ⏳ Team & Permissions

Administrative
├── /admin/organizations      ✅ Organizations Awaiting Approval (+ suspend/reinstate)
├── /admin/events             ✅ Events: create, edit, activate, recover, close (executives); suggested projects to add or dismiss
├── /admin/projects           ✅ Project review: approve or return pending projects (county admins, executives)
├── /admin/moderation         ⏳ Resource Moderation
├── /admin/publication        ⏳ Map Publication Controls (active-ops toggle)
├── /admin/roads              ⏳ Road Report Review
├── /admin/black-book         ⏳ Black Book Verification
├── /admin/freshness          ⏳ Operational Freshness Dashboard
├── /admin/audit              ⏳ Audit Logs
└── /admin/sops               ⏳ SOP Configuration

API
├── GET /api/map/resources    ✅ viewport query (anon: public read model; authed: RLS); `services=` filter
├── GET /api/sites/:id/image  ✅ site photo, only if the caller may see the site
└── GET /api/map/search       ✅ text search over stored address fields

Dev only (404 in production)
└── /dev/outbox               ✅ queued emails
```
