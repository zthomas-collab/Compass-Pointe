# Events and Projects redesign — design

Status: **draft for approval** · 2026-11-15 · Size: project (several stages)

## Intent and why

Crisis Compass needs two different public surfaces that today do not exist in code:

- **Events** are *disaster areas* ("Hurricane X, Carteret County"). An event page names the area and gathers, in one place, the **needs** and the **help** available there, so a resident, volunteer or donor can see what is happening in that area right now.
- **Projects** are *local, need-based work* posted by specific nonprofits, for the community and for citizens. They are built for people who want to volunteer: "here is what is needed, I will help."

This **supersedes** the old plan's meaning of events (a logistics board with `event_tasks` and `event_assignments`, Phase 4) and refines the old Phase 3 projects (ZIP needs with quantities). Those docs (`09`, `10`) must be updated when stage 1 lands.

## Goals

1. Admins can open, run and close an **event** covering named counties (and optionally specific ZIPs).
2. Verified nonprofits can post **projects** made of **needs**: people needs (volunteer roles and shifts) and goods needs (items with quantities).
3. Volunteers can **sign up for a slot** and get an email confirmation; the project shows slots filled versus needed, and slots cannot be overbooked.
4. An event page shows **Needs** (from confirmed linked projects) and **Help** (public resource sites inside the area).
5. Projects reach events by **suggest, then confirm**: geography suggests, a person confirms. Nothing is attached automatically.
6. Projects work on their own with no event (everyday local needs).

## Non-goals

- Showing individual citizen requests for help on any public page. (A later, generalized layer, see Approaches.)
- Auto-assigning or dispatching volunteers, background checks, volunteer-hour certificates, payments.
- The old event task board, assignments, calendar.
- Linking projects to `assistance_applications`. No citizen identity is stored on a project in this design.

## Anti-goals (a failure even if it technically works)

- Any public page that exposes a person's name, home address or request.
- A slot that two people both hold when only one existed.
- An ordinary local project appearing under a disaster it has nothing to do with.
- Matching that commits without a human confirming.
- Counts on public pages that are not computed from real rows.

## Constraints

- Follow the existing patterns: PostgreSQL + PostGIS, RLS and SECURITY DEFINER helpers, `public_*` read-model views, services in `src/server/modules/`, append-only history, audit events, `runIn` contexts. Reuse `counties`, `zip_county`, `zip_codes`/`ics.zip_point`, `organizations`, `organization_counties`, `county_admin_assignments`, the notification queue, and the public resource views.
- Forward-only, expand/contract migrations. Next numbers: `0013`, `0014`, `0015`...
- `AGENTS.md`: this Next.js has breaking changes. Read the relevant guide in `node_modules/next/dist/docs/` before writing page code.
- Accessibility parity with the map: status shown by icon + text + color, axe clean.
- Tests run on real PostGIS (PGlite). Each stage ships authorization, county-isolation, privacy and no-overbooking tests.
- Volunteer sign-up sends email. Real delivery depends on the email provider (M4); until then confirmations queue and show at `/dev/outbox`.

## Approaches considered

**What feeds an event's needs list** (decided by you): (1) projects only; (2) projects plus generalized citizen requests; (3) projects plus an admin-written list. **Chosen: 1.** Simplest, and the privacy rules stay trivial. Option 2 can be added later as a separate, blurred layer.

**How a project reaches an event:** (A) explicit link only; (B) automatic by geography; (C) suggest then confirm. **Chosen: C**, built in two steps: the explicit link first (A), then the suggestion list on top.

**What a "need" is:** (1) people only; (2) goods only; (3) both. **Chosen: 3**, sequenced so people needs ship first and goods needs follow. Goods add pledged / delivered / verified tracking that people needs do not.

## Design

### Data model (proposed)

- `events`: name, slug, hazard_type, status (`DRAFT` | `ACTIVE` | `RECOVERY` | `CLOSED`), starts_on, closed_on, summary. Closed events stay public and read-only as an archive.
- `event_counties` (event, county) and optional `event_zips` (event, zip) to narrow an area.
- `projects`: owning org, title, description, county, ZIP, status (`DRAFT` | `PENDING_REVIEW` | `OPEN` | `PAUSED` | `COMPLETED` | `CANCELLED`), audience (`COMMUNITY` | `ORG_FACILITY` | `HOUSEHOLD_GENERALIZED`). Public location is ZIP and county only. Exact address is stored privately and shown only to confirmed volunteers.
- `project_needs`: project, `need_type` (`PEOPLE` | `GOODS`), title, details, urgency. People: slots_needed, optional start/end, skills, instructions. Goods: item, unit, quantity_needed.
- `volunteer_commitments` (stage 3): need, volunteer name/email/phone, status (`PENDING_EMAIL` | `CONFIRMED` | `CANCELLED` | `ATTENDED` | `NO_SHOW`), append-only history. Capacity is enforced under a row lock on the need, so confirmed + pending never exceeds slots.
- `need_pledges` (stage 6): need, donor, quantity pledged / delivered / verified.
- `project_event_links`: project, event, state (`SUGGESTED` | `CONFIRMED` | `DISMISSED`), who suggested, who confirmed. Many-to-many: overlapping disasters are allowed. A link can only be created if the project's county or ZIP lies inside the event area.

### Who can do what (proposed)

| Action | Org member (own org) | County admin (own counties) | Platform admin | Public |
|---|---|---|---|---|
| Create/edit events | | | ✅ | |
| Draft and submit a project | ✅ | | | |
| Approve a project to go `OPEN` | | ✅ (project's county) | ✅ | |
| Confirm/dismiss an event link | ✅ (own project) | ✅ | ✅ | |
| See suggestions for an event | own projects only | ✅ | ✅ | |
| See volunteer roster | ✅ (own project) | ✅ | ✅ | |
| Browse events, projects, sign up | | | | ✅ |

### Public pages

- `/events` lists events (active first, archive below). `/events/<slug>` shows the area, **Needs** (open needs of confirmed, open linked projects, most unfilled first, with slots filled/needed) and **Help** (public resource sites inside the area that are available, linking to the existing map).
- `/projects` browses by ZIP/county/radius and need type. `/projects/<id>` shows the needs and a sign-up.
- Admin: `/admin/events`, `/admin/projects` (review queue), and a project/needs editor in the org dashboard.

### Suggest, then confirm

Step one gives the explicit link. Step two adds a suggestion list: open projects inside an event's area with no link row or a non-dismissed one. It is visible only to admins and the owning org's dashboard, never public. A person clicks confirm or dismiss; the event page reads confirmed links only.

### Delivery stages

1. **Events:** migration 0013, admin CRUD, public `/events` pages with the Help side only.
2. **Projects with people needs:** migration 0014, org editor, review queue, public `/projects`.
3. **Sign-up:** migration 0015, volunteer commitments, email confirmation, no-overbooking tests, org roster.
4. **Event ↔ project links:** explicit link, event Needs list.
5. **Suggestions:** the suggestion list and confirm/dismiss UI.
6. **Goods needs and pledges:** pledged / delivered / verified, no over-pledging.

## Calls I made (not yet agreed with you)

- Projects can stand alone with no event.
- Platform admins create events; county admins and org members cannot.
- A project needs county/platform-admin approval before it is public (same pattern as profile approval).
- Volunteers sign up with email confirmation and **no account**.
- Projects never store citizen identity or link to assistance applications.
- A project can link to several events.
- Public location is ZIP and county only; exact address only to confirmed volunteers.

## Left to the builder

Slug rules, exact enums and column constraints, urgency ordering, event-area precision (county versus ZIP overlap rules), retention periods for volunteer data, pagination, copy, and the exact wording of emails.
