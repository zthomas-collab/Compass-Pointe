# Crisis Compass Carolinas Brand & Color System

Crisis Compass Carolinas (formerly HopeGrid; repository: ICS-LAS) is operated by Hiraeth Ventures. Every value below
comes from `src/config/brand.ts`, the only source of brand settings. Each can be overridden with a `BRAND_*`
environment variable, and the app checks overrides for contrast before using them.

- **Name and tagline:** Crisis Compass Carolinas · *Direction When It Matters Most* (`BRAND_NAME`, `BRAND_TAGLINE`)
- **Logo:** the official horizontal lockup `/brand/logo-horizontal.png` (compass, name, region and tagline), shown on a
  white plate in the header. Never recolored or redrawn; originals are in `/public/brand/originals`.
- **Home page heading:** "Find help near you" with one line under it: free help from verified organizations, no
  account needed. It sits right above the search box.
- **Primary call to action:** Find Help Near Me. A gold button beside the map search (full width on phones). It uses
  the device's location and shows the nearest help first.
- **Giving calls to action:** "Give money" (opens an organization's administrator-approved donation page in a new tab)
  and "Offer supplies". They appear on the Volunteer & donate hub, the Donate page, organization pages and map listings.
- **Organization call to action:** Register Your Organization. A gold button in the desktop header for signed-out
  visitors. On phones it sits inside the Menu, so the help actions stay at the top of the screen.
- **Navigation order:** Find help · Request help · Volunteer & donate · Events · Organizations · Safety. Help comes first,
  then giving. On phones these live in one "Menu" button.

## Brand palette

| Token | Name | Hex | Used for | Contrast (WCAG AA) |
|---|---|---|---|---|
| `primary` | Deep Heritage Olive | `#41491D` | Header/navigation, headings, primary buttons, map cluster circles | White text 9.6:1 |
| `interactive` | Muted Sage | `#6B7352` | Map graphics, focus rings | 5.0:1 on white |
| `link` | Deep Heritage Olive | `#41491D` | Text links | 8.8:1 on Warm Ivory |
| `soft` | Soft Champagne | `#E7DDBD` | Soft highlights, supportive backgrounds | Charcoal 11.7:1 |
| `accent` | Refined Antique Gold | `#B5A04D` | Attention buttons (Find Help Near Me, Register Your Organization), header rule | Background only; Charcoal text 6.1:1 |
| `background` | Warm Ivory | `#F8F5EE` | Page background | — |
| `text` | Executive Charcoal | `#20231C` | Body text | 14.6:1 on Warm Ivory |
| — | Pure White | `#FFFFFF` | Cards, forms, logo plate | — |
| — | Muted text | `#5B5F4F` | Secondary text | 6.0:1 on Warm Ivory |

Tokens live in `src/app/globals.css` as `--cc-*` variables. The older `--hope-*` names there are aliases kept so
existing components work; new code should use the `--cc-*` names or the semantic names (`--brand`, `--link`, …).
The hex values are provisional digital tokens taken from the official logo files, not verified official specifications.

Headings use Cormorant Garamond and body text uses Inter.

## Resource status colors (semantic — reserved)

Status colors are **never** used for organization types (a database CHECK, `service_types_not_status_color`, rejects them). Every status always shows **color + icon + text**.

| Status | Badge (list/detail) | Map pin badge | Icon |
|---|---|---|---|
| Available | green tint, `#1B5E20` text | `#2E7D32` circle, white **A** | check in circle |
| Limited | amber tint, `#6B4300` text | `#F0B84B` circle, charcoal **L** | warning triangle |
| Depleted | red tint, `#A61B1B` text | `#C62828` circle, white **D** | × in circle |
| Temporarily closed | gray, explicit label | `#B0BEC5` circle, charcoal **C** | pause square |
| Unknown / Unconfirmed (expired verification) | gray, dashed border | `#ECEFF1` circle, charcoal **?** | ? in dashed circle |

## Organization type colors

Each organization's admin-confirmed type colors its map pins, with a short code (e.g. **H2O**, **MED**, **CM**) printed on the pin. The palette avoids status hues (no green, amber, red or mid-gray). Every type color gives white text at least 4.5:1 (database CHECK `service_types_color_contrast`).

## Map key

The map key is a column on the **left side of the map running from its top to its bottom** (scrolls inside; always shown on screens 768 px and wider). On phones it is a “Map key” button that opens the same full-height panel over the left of the map. It explains every color and mark used:
1. **Availability** — the lettered badge on each pin (A / L / D / C / ?) with the matching status pill.
2. **Organization type** — pin color + code; tapping a type filters the map.
3. **Other marks** — numbered forest-green circles (groups of locations) and the thick dark outline (restricted, signed-in only).

## Verification

axe-core (WCAG 2.0/2.1/2.2 A + AA + best practice): 0 violations on Home/Map, Contacts, Sign in/Register, Safety, Dashboard and Site editor (2026-11-10, local dev). Phone width 375 px: no horizontal scroll; hero buttons 44 px tall.
