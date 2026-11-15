# Volunteer Sign-up (Stage 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A member of the public can sign up for a project's volunteer slot with no account, confirm by email, see and cancel their sign-up from a private link; slot counts on public pages come from real rows and can never be overbooked; the project's organization sees a roster and marks attendance.

**Architecture:** One forward-only migration (`0015_volunteer_signup.sql`) adds `volunteer_commitments` and an append-only `volunteer_commitment_events`, and replaces `public_project_needs` to add a slots-taken count. A new service module `src/server/modules/volunteers.ts` follows `offers.ts` (public, anon-safe intake in `system` context, rate limits and a hidden trap field in the action layer, queued email through `enqueueEmail`). Each sign-up carries a random token whose **hash** is stored; the emailed link is a capability for that one commitment. Capacity is enforced under a row lock on the need. Roster and attendance live on the existing org project editor.

**Tech Stack:** Next.js (breaking-change version, see constraints), React 19, PostgreSQL/PostGIS via PGlite in tests, zod, vitest.

**Branch:** create `volunteer-signup-stage-3` from `projects-stage-2` (migration `0015` follows `0014`). If PR #5 has merged, branch from `main` instead.

**Spec:** `docs/superpowers/specs/2026-11-15-events-and-projects-design.md` (Stage 3 of its six delivery stages).

## Global Constraints

- Follow existing patterns: RLS and SECURITY DEFINER helpers, `public_*` read-model views, services in `src/server/modules/`, `writeAudit`, `runIn` contexts, role checks re-derived inside the transaction.
- Forward-only, expand/contract migrations. This stage's migration is `0015`.
- `AGENTS.md`: this Next.js has breaking changes. Read the relevant guide in `node_modules/next/dist/docs/` before writing page or server-action code.
- Client components must not import server modules for runtime values; shared constants go in `src/lib/`.
- Accessibility parity with the map: status shown by icon + text + color; axe clean.
- Tests run on real PostGIS (PGlite) via `freshDb()`; each stage ships authorization, county-isolation and privacy tests.
- **Volunteers sign up with email confirmation and no account.** Capacity is `project_needs.slots_needed`; a slot is taken by a `CONFIRMED` or `ATTENDED` commitment, or by a `PENDING_EMAIL` one whose hold has not expired. `CANCELLED` and `NO_SHOW` free the slot.
- A pending hold lasts **24 hours** (`HOLD_HOURS = 24`).
- Public pages never expose a volunteer's name, email or phone, and never the project's private location notes or a need's instructions. Those two are shown only on a valid token page to a `CONFIRMED` volunteer.
- Email links that carry a token must never change state on `GET`: viewing is read-only; confirming and cancelling are explicit form posts (email scanners prefetch links).
- Emails carrying a token use `kind` values that the notification worker redacts after sending: add them to `SECRET_KINDS` in `src/server/modules/notifications.ts`.
- Audit rows and logs never contain a volunteer's name, email, phone or token: ids and statuses only.
- A public count comes only from real rows. The volunteer must consent to share their contact details with the organization to sign up.

## Review Focus

1. Concurrent sign-ups for the last slots never exceed `slots_needed`; pending holds count; an expired hold frees its slot. (Tasks 1, 2)
2. Viewing a token page never changes a commitment; confirm and cancel need an explicit call; a wrong, expired-hold or already-cancelled token reveals nothing about anyone. (Task 2)
3. After the confirmation email is sent, its stored body is redacted; no public view, search, or detail result contains a volunteer's name, email, phone, the private location notes, or need instructions. (Tasks 2, 3)
4. The same email cannot hold two slots of one need; a per-email daily limit applies; sign-up is refused for a project that is not `OPEN`, or a need whose shift has ended. (Task 1)
5. Cancelling, a no-show, or an expired hold frees the slot; an org viewer, another org's member, and a county administrator of a different county cannot see the roster or mark attendance. (Tasks 2, 3)

---

### Task 1: Schema and sign-up

**Files:**
- Create: `db/migrations/0015_volunteer_signup.sql`
- Create: `src/server/modules/volunteers.ts`
- Create: `src/lib/volunteers.ts`
- Test: `tests/volunteers.test.ts`

**Interfaces:**
- Produces (`src/lib/volunteers.ts`, client-safe): `export const COMMITMENT_STATUSES = ["PENDING_EMAIL","CONFIRMED","CANCELLED","ATTENDED","NO_SHOW"] as const`; `export type CommitmentStatus = (typeof COMMITMENT_STATUSES)[number]`; `export const HOLD_HOURS = 24`.
- Produces (`volunteers.ts`):
  - `export const signupSchema` (zod: `needId` uuid; `name` 2-120; `email` lowercased, valid, ≤254; `phone` optional 7-40; `consentShare` must be true, accepting `true`, `"true"` or `"on"`)
  - `export async function signUpForNeed(driver: Driver, raw: unknown): Promise<{ commitmentId: string }>` (anon-safe; never returns the token)
- Consumes: `newToken`, `hashToken`, `enqueueEmail`, `appBaseUrl`, `brandName`, `writeAudit` (`shared.ts`); `parseOrThrow` (`identity.ts`); `fromDbError`; `runIn`. Test setup reuses the projects fixtures: copy the minimal org/county/project/need setup from `tests/projects.test.ts` into a shared helper `tests/helpers/projects.ts` exposing `openProjectWithNeed(db, { slots, startsAt, endsAt }): Promise<{ projectId; needId; ... }>` that creates, submits and approves a project, and use it in both files only if the move is mechanical; otherwise duplicate the small setup in the new test file.

- [ ] **Step 1: Write failing tests** in `tests/volunteers.test.ts`:
  - `it("holds a slot as PENDING_EMAIL and queues one confirmation email with a link")`: `signUpForNeed` returns an id; the commitment is `PENDING_EMAIL` with a hold about 24 hours ahead; exactly one `notification_jobs` row of kind `VOLUNTEER_CONFIRM` exists for that email whose body contains `/volunteer/commitments?token=` followed by a token of at least 40 characters; the commitment row stores a 64-character hash and never the token (`SELECT` the table and assert no column value equals the token).
  - `it("refuses a project that is not OPEN and a need whose shift has ended")` (Review Focus 4): `DRAFT`, `PENDING_REVIEW`, `PAUSED` and `COMPLETED` projects each throw `VALIDATION`; a need with `endsAt` in the past throws `VALIDATION`; an unknown need id throws `NOT_FOUND`; no rows are created by any failure.
  - `it("requires name, a valid email, and consent to share contact details")`: missing name, `"not-an-email"`, and `consentShare` false each throw `VALIDATION`.
  - `it("stops one email taking two slots of a need, and applies a per-email daily limit")` (Review Focus 4): a second sign-up with the same email (different letter case) for the same need throws `CONFLICT`; the same email on 5 different needs succeeds and a 6th throws `RATE_LIMITED`.
  - `it("never overbooks under concurrent sign-ups")` (Review Focus 1): a need with 3 slots and 8 simultaneous `Promise.all` sign-ups from 8 different emails ends with exactly 3 fulfilled and 5 rejected with code `CONFLICT` (message says the shift is full), and `count(*)` of holding commitments for the need is 3.
  - `it("frees a slot whose hold has expired")` (Review Focus 1): fill a 1-slot need, force that commitment's `hold_expires_at` into the past with a `system` UPDATE, and a new sign-up from another email succeeds; the old commitment is marked `CANCELLED`.
  - `it("does not expose commitments to request roles")`: `runIn(db, {kind:"anon"}, tx => tx.query("SELECT * FROM volunteer_commitments"))` rejects with code `42501`.
  - `it("audits sign-ups without personal data")`: the `VOLUNTEER_SIGNED_UP` audit row's `details` JSON contains neither the name, the email nor the phone.

- [ ] **Step 2: Run to verify failure.** Run: `npx vitest run tests/volunteers.test.ts`. Expected: FAIL (module `@/server/modules/volunteers` not found).

- [ ] **Step 3: Write `db/migrations/0015_volunteer_signup.sql`.** `volunteer_commitments` (`id`, `need_id` FK `project_needs` ON DELETE CASCADE, `volunteer_name` 2-120, `email` text lowercase check (`email = lower(email)`), `phone` ≤40, `status` CHECK against the five values default `'PENDING_EMAIL'`, `token_hash text NOT NULL UNIQUE` (64 hex), `hold_expires_at timestamptz`, `consent_share boolean NOT NULL CHECK (consent_share)`, `created_at`, `confirmed_at`, `cancelled_at`, `attendance_marked_by` FK users, `attendance_marked_at`). A unique partial index on `(need_id, email) WHERE status IN ('PENDING_EMAIL','CONFIRMED','ATTENDED')`. Index on `(need_id, status)`. `volunteer_commitment_events` (`id`, `commitment_id` FK, `event_type text`, `from_status`, `to_status`, `actor_role text` in (`VOLUNTEER`,`ORG`,`SYSTEM`), `occurred_at`) with the existing `ics.reject_mutation()` trigger making it append-only (same pattern as `audit_logs`). Enable RLS on both and grant them to no request role. Do not change the public view yet (Task 3).

- [ ] **Step 4: Implement `signupSchema` and `signUpForNeed`.** One `system` transaction: parse; load the need joined to its project and org requiring `projects.status = 'OPEN'`, the org `APPROVED` and not suspended (else `VALIDATION` for a closed project, `NOT_FOUND` for an unknown need); refuse a need whose `ends_at` is past; take `SELECT ... FROM project_needs WHERE id = $1 FOR UPDATE` first thing so sign-ups for one need serialise; apply the per-email daily limit (count of the email's commitments created in the last 24 hours across all needs ≥ 5 → `RATE_LIMITED`); mark any expired `PENDING_EMAIL` rows for this need `CANCELLED` (with an event); reject a duplicate active email for this need with `CONFLICT` ("You already signed up for this shift"); count taken slots as defined in Global Constraints and throw `CONFLICT` ("This shift is full") when `taken >= slots_needed`; insert with `hold_expires_at = now() + HOLD_HOURS`; write a `SIGNED_UP` event and a `VOLUNTEER_SIGNED_UP` audit row with ids only; enqueue the `VOLUNTEER_CONFIRM` email (subject `${brandName()}: confirm your volunteer sign-up`, body names the project and shift, links `${appBaseUrl()}/volunteer/commitments?token=<token>`, says it holds the spot for 24 hours, and says to ignore it if they did not sign up).

- [ ] **Step 5: Run to verify pass.** Run: `npx vitest run tests/volunteers.test.ts tests/migrations.test.ts`. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add db/migrations/0015_volunteer_signup.sql src/server/modules/volunteers.ts src/lib/volunteers.ts tests/volunteers.test.ts
git commit -m "feat(volunteers): commitments schema and public sign-up with capacity hold"
```

---

### Task 2: Token page, confirm, cancel, and email redaction

**Files:**
- Modify: `src/server/modules/volunteers.ts`
- Modify: `src/server/modules/notifications.ts` (add `"VOLUNTEER_CONFIRM"` to `SECRET_KINDS`)
- Test: `tests/volunteers.test.ts`, `tests/notifications.test.ts` (one added test)

**Interfaces:**
- Consumes: Task 1 exports.
- Produces:
  - `export type CommitmentView = { id: string; status: CommitmentStatus; volunteerName: string; holdExpiresAt: string | null; project: { id: string; title: string; orgName: string; countyName: string; state: string; zip: string }; need: { id: string; title: string; startsAt: string | null; endsAt: string | null; skills: string | null }; privateLocationNotes: string | null; instructions: string | null }` (the last two are non-null only when `status` is `CONFIRMED` or `ATTENDED`)
  - `export async function getCommitmentByToken(driver: Driver, token: string): Promise<CommitmentView | null>` (read-only; `null` for unknown tokens)
  - `export async function confirmCommitment(driver: Driver, token: string): Promise<void>` (`PENDING_EMAIL` with an unexpired hold → `CONFIRMED`; idempotent when already `CONFIRMED`)
  - `export async function cancelCommitment(driver: Driver, token: string): Promise<void>` (`PENDING_EMAIL` or `CONFIRMED` → `CANCELLED`; idempotent when already `CANCELLED`; refused with `VALIDATION` once the shift has ended or the status is `ATTENDED`/`NO_SHOW`)
- Tests obtain a token by capturing it from the queued `VOLUNTEER_CONFIRM` email body (parse `token=`), as a real volunteer would.

- [ ] **Step 1: Write failing tests:**
  - `it("shows a pending sign-up read-only and never changes it on view")` (Review Focus 2): `getCommitmentByToken` returns the view with `status: "PENDING_EMAIL"`, `privateLocationNotes: null`, `instructions: null`; calling it five times leaves `status`, `confirmed_at` and the event count unchanged.
  - `it("confirms with an explicit call and then reveals the private details")`: after `confirmCommitment` the view is `CONFIRMED`, `privateLocationNotes` equals the project's private notes and `instructions` equals the need's; a second `confirmCommitment` succeeds and adds no second event; events show `SIGNED_UP`, `CONFIRMED`.
  - `it("reveals nothing for a wrong or malformed token")` (Review Focus 2): `getCommitmentByToken` returns `null` for a random token, `""`, a 64-character hex hash of a real token (the stored hash must not work as a token), and `confirmCommitment`/`cancelCommitment` with those throw `NOT_FOUND` with no state change.
  - `it("refuses to confirm after the hold expires and frees the slot")` (Review Focus 1, 5): force the hold into the past; `confirmCommitment` throws `VALIDATION`; the view reports `CANCELLED` or expired consistently (pick: the call marks it `CANCELLED`); another volunteer can then take the slot.
  - `it("cancels a pending or confirmed sign-up, frees the slot, and is idempotent")` (Review Focus 5): cancel a confirmed one on a full 1-slot need; a new sign-up now succeeds; a second `cancelCommitment` on the same token succeeds without error; a cancelled commitment's view has `privateLocationNotes: null`.
  - `it("refuses to cancel once the shift has ended or attendance is recorded")`: force `ends_at` into the past (via a `system` UPDATE on the need) then `cancelCommitment` throws `VALIDATION`; same for an `ATTENDED` commitment.
  - `it("redacts the confirmation email body after the worker sends it")` in `tests/notifications.test.ts`, using the existing fake-transport pattern in that file: queue a `VOLUNTEER_CONFIRM` job, run `processNotificationJobs`, and assert the stored `body_text` equals `[redacted after sending]` while the transport received the full link.

- [ ] **Step 2: Run to verify failure.** Run: `npx vitest run tests/volunteers.test.ts tests/notifications.test.ts -t "read-only|explicit call|wrong or malformed|hold expires|cancels a pending|ended or attendance|redacts the confirmation"`. Expected: FAIL.

- [ ] **Step 3: Implement the three functions and the `SECRET_KINDS` change.** Look the commitment up by `hashToken(token)` (a token shorter than 20 characters or not base64url is `NOT_FOUND` immediately). `confirmCommitment` and `cancelCommitment` lock the need row first (same lock order as Task 1: need, then commitment), re-check status under the lock, write `CONFIRMED` / `CANCELLED` events with `actor_role = 'VOLUNTEER'` (`'SYSTEM'` when the expired-hold path cancels), and audit `VOLUNTEER_CONFIRMED` / `VOLUNTEER_CANCELLED` with ids only. `getCommitmentByToken` takes no locks and writes nothing; it returns private fields only for `CONFIRMED`/`ATTENDED`.

- [ ] **Step 4: Run to verify pass.** Run: `npx vitest run tests/volunteers.test.ts tests/notifications.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/modules/volunteers.ts src/server/modules/notifications.ts tests/volunteers.test.ts tests/notifications.test.ts
git commit -m "feat(volunteers): token page, confirm, cancel, and email redaction"
```

---

### Task 3: Public slot counts, roster, and attendance

**Files:**
- Modify: `db/migrations/0015_volunteer_signup.sql` (replace `public_project_needs`; the migration is unreleased on this branch)
- Modify: `src/server/modules/projects.ts` (`PublicNeed` and its mapping)
- Modify: `src/server/modules/volunteers.ts`
- Test: `tests/volunteers.test.ts`, `tests/projects.test.ts` (adjust only if `PublicNeed` equality assertions break)

**Interfaces:**
- Produces (SQL): `public_project_needs` gains `slots_taken int` (count of the need's commitments in `CONFIRMED`, `ATTENDED`, or `PENDING_EMAIL` with an unexpired hold). It still contains no volunteer fields.
- Produces (`projects.ts`): `PublicNeed` gains `slotsTaken: number` and `spotsLeft: number` (`slotsNeeded - slotsTaken`, never below 0). `PublicProject.totalSlots` stays the sum needed; add `spotsLeft: number` to `PublicProject` (sum of needs' `spotsLeft`).
- Produces (`volunteers.ts`):
  - `export type RosterRow = { id: string; needId: string; needTitle: string; volunteerName: string; email: string; phone: string | null; status: CommitmentStatus; createdAt: string; confirmedAt: string | null }`
  - `export async function listRoster(driver: Driver, userId: string, projectId: string): Promise<RosterRow[]>` (ORG_ADMIN or EDITOR of the owning org, administrators of the project's county, executives; anyone else gets `FORBIDDEN`; excludes `PENDING_EMAIL` rows whose hold expired)
  - `export async function markAttendance(driver: Driver, userId: string, commitmentId: string, to: "ATTENDED" | "NO_SHOW" | "CANCELLED"): Promise<void>` (org ORG_ADMIN/EDITOR only; `ATTENDED`/`NO_SHOW` only from `CONFIRMED` and only once the shift has started or has no start time; `CANCELLED` from `PENDING_EMAIL` or `CONFIRMED`; writes `ORG` events; audits with ids only)

- [ ] **Step 1: Write failing tests:**
  - `it("shows real spots left on public needs and never volunteer data")` (Review Focus 3): with 3 slots and one confirmed, one pending (unexpired) and one cancelled commitment, `getPublicProject` shows `slotsTaken: 2`, `spotsLeft: 1` for the need and the project; `JSON.stringify` of `searchProjects`, `getPublicProject` and the column list of `public_project_needs` contain none of the volunteers' names, emails, phones, the private notes, or instructions.
  - `it("shows full needs as zero spots left and an expired hold as free")`: filling the need gives `spotsLeft: 0`; forcing a hold into the past raises `spotsLeft` by one.
  - `it("lists the roster for the owning org's editors, county admins and executives")`: names, emails and phones appear for `ORG_ADMIN`, `EDITOR`, the project's county admin and the executive; expired holds are absent.
  - `it("refuses the roster to viewers, other orgs, other counties, and the public")` (Review Focus 5): the org `VIEWER`, a member of another org, the other county's admin, and a plain user each get `FORBIDDEN`.
  - `it("marks attendance and no-shows, and cancelling by the org frees the slot")` (Review Focus 5): after the shift has started (force `starts_at` into the past), `ATTENDED` and `NO_SHOW` work on confirmed volunteers; marking before the shift starts throws `VALIDATION`; `CANCELLED` by an editor frees the slot (a new sign-up succeeds); events record `actor_role = 'ORG'`.
  - `it("refuses attendance changes by viewers and other orgs")`: `FORBIDDEN`; the commitment is unchanged.

- [ ] **Step 2: Run to verify failure.** Run: `npx vitest run tests/volunteers.test.ts -t "spots left|full needs|roster|attendance"`. Expected: FAIL.

- [ ] **Step 3: Replace `public_project_needs`** (add `slots_taken` as described, same whitelist otherwise), update `PublicNeed`/`PublicProject` and their mapping in `projects.ts`, and implement `listRoster` and `markAttendance` (lock need then commitment; re-derive the actor's role inside the transaction).

- [ ] **Step 4: Run to verify pass.** Run: `npx vitest run tests/volunteers.test.ts tests/projects.test.ts tests/migrations.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add db/migrations/0015_volunteer_signup.sql src/server/modules/projects.ts src/server/modules/volunteers.ts tests
git commit -m "feat(volunteers): public spots-left counts, roster, and attendance"
```

---

### Task 4: Public sign-up screens

**Files:**
- Create: `src/app/volunteer/commitments/page.tsx`, `src/app/volunteer/commitments/actions.ts`, `src/app/projects/signup-actions.ts`
- Create: `src/components/signup-forms.tsx`
- Modify: `src/app/projects/[id]/page.tsx` (sign-up form per need; remove the "coming soon" note), `src/app/projects/page.tsx` (show spots left)

**Interfaces:**
- Consumes: `signUpForNeed`, `getCommitmentByToken`, `confirmCommitment`, `cancelCommitment`, `PublicNeed.spotsLeft`, `rateLimit` (`src/server/rate-limit.ts`), `clientKey` (`src/server/session.ts`), the honeypot pattern in `src/app/volunteer/actions.ts`, the form helpers in `src/components/forms.tsx`.
- Produces: server actions `signUpAction(needId: string, prev, form): Promise<FormState>` (rate limit `signup:<clientKey>` 6 per 15 minutes; hidden field `website` filled means pretend success and store nothing; success message tells the volunteer to check their email and that the spot is held for 24 hours), `confirmCommitmentAction(token: string): Promise<FormState>`, `cancelCommitmentAction(token: string): Promise<FormState>`; components `SignUpForm` (name, email, phone optional, required consent checkbox with plain wording, the hidden trap field) and `CommitmentActions`.

- [ ] **Step 1: Read the Next.js guides** for dynamic params, `searchParams` and server actions; read `src/app/volunteer/page.tsx` and `offer-forms.tsx` for the public form look; match them.
- [ ] **Step 2: Build the sign-up form** on `/projects/[id]` under each need: shows "N spots left" (or "Full" with the form hidden), the shift time in Eastern Time, and the consent wording ("I agree to share my name, email and phone with <organization> so they can coordinate this shift.").
- [ ] **Step 3: Build `/volunteer/commitments?token=…`:** a read-only page (`GET` never changes anything; `robots: noindex`) showing project, shift, status and the 24-hour hold; for `PENDING_EMAIL` a **Confirm my spot** button and a **Cancel** button; for `CONFIRMED` the private location notes, the need's instructions and a **Cancel my sign-up** button; for `CANCELLED` a plain "this sign-up was cancelled" message. An unknown token shows the same neutral "link not valid" page (never 404-vs-200 differences that reveal existence). Use `Link`, not `<a>`, for internal links.
- [ ] **Step 4: Verify.** Run: `npm run typecheck && npm run lint`. Expected: no new errors. If a browser is available, sign up, read the email from `/dev/outbox`, open the link, confirm, cancel; otherwise record that gap in the ledger.
- [ ] **Step 5: Commit**

```bash
git add src/app/volunteer src/app/projects src/components/signup-forms.tsx
git commit -m "feat(volunteers): public sign-up form and private commitment page"
```

---

### Task 5: Org roster screen, docs, full check

**Files:**
- Modify: `src/app/dashboard/projects/[id]/page.tsx` (roster section), `src/app/dashboard/projects/actions.ts` (`markAttendanceAction(projectId, commitmentId, to)`)
- Modify: `src/components/project-forms.tsx` (or a new `src/components/roster-forms.tsx`) for the attendance buttons
- Modify: `README.md`, `docs/09-crisis-compass-upgrade-plan.md`, `docs/10-gap-analysis.md`, `docs/04-journeys-sitemap.md`, `docs/runbook.md` (a short note that volunteer data is personal data and needs a retention policy before launch)

**Interfaces:**
- Consumes: `listRoster`, `markAttendance`, `RosterRow`, `ActionButton`.

- [ ] **Step 1: Add the roster** to the project editor page: a table per need of volunteers (name, email, phone, status icon + text, signed-up time), visible to the roles `listRoster` allows (a `FORBIDDEN` simply hides the section); for the org's editors, buttons **Attended**, **No-show** and **Remove** that appear only where legal (the same rules as `markAttendance`). Show spots taken against needed per need.
- [ ] **Step 2: Update docs:** README (a Volunteer sign-up section; correct the test count from the real run), `docs/10` (volunteer commitments row: stage 3 done; remaining: event links, suggestions, goods), `docs/09` (`volunteer_commitments` shipped in `0015`), `docs/04` (new routes), `docs/runbook.md` (retention note).
- [ ] **Step 3: Run the full check.** Run: `npm run check && npm run build`. Expected: lint, typecheck and every test pass (the existing 234 plus the new volunteer tests) and the build lists the new routes.
- [ ] **Step 4: Manual check** with `npm run dev` (use the port it prints): sign up, find the email at `/dev/outbox`, confirm from the link, see the roster as the org editor, mark attendance, cancel as the volunteer, and confirm the slot reopens on the public page. If no signed-in browser is available, state that this was not verified.
- [ ] **Step 5: Commit**

```bash
git add src/app/dashboard src/components README.md docs
git commit -m "feat(volunteers): org roster and attendance, docs"
```
