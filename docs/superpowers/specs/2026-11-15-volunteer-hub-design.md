# Volunteer & donate hub — design

Status: **draft for approval** · 2026-11-15 · Size: small-to-medium (pages and navigation only; no new data)

## Intent and why

Today the site has two separate doors for generosity: a **Projects** tab (real volunteer shifts people can sign up for) and a **Volunteer & donate** tab (one long form for offering supplies, equipment, space or skills). Someone who wants to volunteer lands on the generic form instead of the shifts, and the best path (sign up for a real shift) is hidden behind a different tab. The aim is **one professional front door** that asks "How do you want to help?" and walks each person to the end of the right path: a **confirmed shift** or a **reviewed donation offer**.

## Goals

1. `/volunteer` becomes a hub with a clear first choice: volunteer my time, or donate supplies / equipment / space.
2. The **Projects tab leaves the main navigation**. The shift list and shift pages live under `/volunteer`, with a section sub-navigation (Overview · Find a shift · Donate) and breadcrumbs on every page.
3. Old `/projects` links keep working (permanent redirects, query string preserved).
4. `/volunteer/donate` opens with a **chooser** of what you are giving; choosing one opens a shorter form with that type already selected. The type travels in the address, so it works without JavaScript and can be linked to.
5. For "volunteer labor" and "professional skills" the main button points to real shifts; the general offer form stays available as a smaller option.
6. The thank-you pages say what happens next and offer the natural next step.
7. Mobile first, keyboard and screen-reader friendly, using the existing brand tokens.

## Non-goals

- Taking money. **"Donate" means in-kind** (food, water, supplies, equipment, transportation, space, skills). No payment link, no payment code. (Chosen by you.)
- New tables, migrations, services or permissions. Existing sign-up, offer and search behavior is unchanged.
- Changing what event pages show (only where their project links point).
- Email provider setup, accounts for volunteers, a donor dashboard.

## Anti-goals (a failure even if it technically works)

- A broken or looping old `/projects` link, or one that drops the search the person had typed.
- Losing the ability to submit any of the ten offer types.
- A hub that shows invented numbers, or hides urgent shifts behind clicks.
- A dead end: any page that does not say what to do next.
- Keyboard or screen-reader regressions (focus order, landmarks, color-only meaning).

## Constraints

- `AGENTS.md`: this Next.js has breaking changes. Read the relevant guide in `node_modules/next/dist/docs/` before writing page code. Redirects go in `next.config.ts` (`redirects()` already exists for `/black-book`).
- Accessibility parity with the map (axe clean); client components must not import server modules for runtime values; shared constants go in `src/lib/`.
- Public pages show only real data: counts and the "urgent now" list come from `searchProjects` over the public views.
- No change to who can see what: private location notes, instructions and volunteer data stay out of every new page.

## Approaches considered

**Where the pages live:** (A) move them under `/volunteer` with permanent redirects from `/projects`; (B) keep `/projects` and only regroup the navigation. **Chosen: A.** The address bar, breadcrumbs and sub-navigation tell one story, and redirects keep every old link alive.

**The donate form:** (A) one long form, restyled; (B) a guided chooser first, then a short form with the type preselected. **Chosen: B.** Fewer fields per screen, and volunteer-type offers are steered toward real shifts.

## Design

### Routes

| Route | What |
|---|---|
| `/volunteer` | Hub (new) |
| `/volunteer/projects` | The shift list (moved from `/projects`) |
| `/volunteer/projects/[id]` | One project with sign-up (moved from `/projects/[id]`) |
| `/volunteer/donate` | Chooser, or the form when `?type=<OFFER_TYPE>` is valid |
| `/volunteer/thanks` | Existing; richer next steps |
| `/volunteer/commitments` | Existing private link page, unchanged |

Redirects (permanent): `/projects` → `/volunteer/projects`, `/projects/:id` → `/volunteer/projects/:id`, query string preserved. Anything linking to the old paths is updated anyway: the nav, event pages, the sign-up pages, the commitment page's "sign up again" link, and the cancellation notice email.

### Navigation

Remove `Projects` from the main nav. Keep one `Volunteer & donate` item, marked as the current page on every `/volunteer/*` route. A section sub-navigation (a labelled `nav` landmark with `aria-current="page"`) shows **Overview · Find a shift · Donate** on every page in the section, with a breadcrumb above the page title.

### Hub (`/volunteer`)

```
 Volunteer & donate        [ Overview | Find a shift | Donate ]
 ┌─ How do you want to help? ────────────────────────────────┐
 │ ┌ Volunteer my time ───────┐  ┌ Donate supplies or space ─┐ │
 │ │ ZIP [_____] Find shifts  │  │ Food · Water · Supplies   │ │
 │ │ Urgent now:              │  │ Equipment · Transport     │ │
 │ │  Debris crew · 2 spots   │  │ Space · Something else    │ │
 │ └──────────────────────────┘  └───────────────────────────┘ │
 │ Skilled professional? Offer your skills →                    │
 └──────────────────────────────────────────────────────────────┘
 How it works: 1 Choose  2 Confirm by email  3 Show up or drop off
 No account needed · Your details are shared only with the organization · Cancel any time
 Helping with a specific disaster? See current events →
```

- The ZIP box is a plain `GET` form to `/volunteer/projects?zip=…`, so it works without JavaScript.
- "Urgent now" lists up to three open shifts, urgent ones first, with real spots left. With none open it says so and points to the donate page's volunteer-labor offer (never a blank gap).
- Counts and names come from the existing public search; nothing is invented.

### Donate (`/volunteer/donate`)

With no valid `?type=`, a grid of cards, one per offer type, each with a one-line description ("What counts as building supplies?"). Choosing a card goes to `?type=<CODE>`. With a valid type, the existing offer form with that type preselected, a "Change what I'm giving" link, and type-specific hints for quantity and unit. For `VOLUNTEER_LABOR` and `PROFESSIONAL_SKILLS` the page leads with a callout, "The fastest way to help is a real shift", linking to `/volunteer/projects`, and the form follows under "Or tell us about your skills". An unknown `type` falls back to the chooser. The form's fields, validation, spam guards and the `submitOffer` service are unchanged.

### Thank-you pages

The offer thank-you keeps the reference number and adds "What happens next" (a coordinator reviews it; they may contact you; nothing is promised) and two next steps (find a shift, see events). The volunteer sign-up success message links to "See other shifts".

## Calls I made (not yet agreed with you)

- The list is called **Find a shift** in navigation and headings; the code and docs keep the word "projects".
- The hub shows up to **three** urgent shifts, not a full list.
- Offer-type card descriptions and the "How it works" copy are mine to write; you can edit the wording afterwards.
- The commitment emails need no change (they never linked to `/projects`); only the cancellation notice's link changes.

## Left to the builder

Exact copy, icons or glyphs, spacing and card styling within the existing brand tokens; the order of the cards; whether the sub-navigation collapses on very narrow screens.
