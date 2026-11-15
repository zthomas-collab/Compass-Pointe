import { z } from "zod";
import { DAILY_SIGNUP_LIMIT, HOLD_HOURS, type CommitmentStatus } from "@/lib/volunteers";
import type { Driver, Tx } from "../db";
import { runIn } from "../db/context";
import { AppError, fromDbError } from "../errors";
import { canManageCounty, loadAccess } from "./access";
import { membershipRole } from "./directory";
import { parseOrThrow } from "./identity";
import { appBaseUrl, brandName, enqueueEmail, hashToken, newToken, writeAudit } from "./shared";

/** Shift times in email and pages are Eastern Time: the platform serves North and South Carolina. */
const fmtShift = (d: Date | null) =>
  d ? new Date(d).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" }) : null;

/** The form's checkbox posts "on"; API callers may send true. Anything else is a refusal. */
const consent = z
  .union([z.literal(true), z.literal("true"), z.literal("on")], { message: "Please agree to share your contact details with the organization" })
  .transform(() => true as const);

export const signupSchema = z.object({
  needId: z.string().uuid(),
  name: z.string().trim().min(2, "Enter your name").max(120),
  email: z.string().trim().toLowerCase().email("Enter a valid email address").max(254),
  phone: z
    .string()
    .trim()
    .min(7)
    .max(40)
    .optional()
    .or(z.literal("").transform(() => undefined)),
  consentShare: consent,
});

/** A slot is taken by a confirmed or attended sign-up, or by a pending one whose hold has not expired. */
export const TAKEN_SQL = `(status IN ('CONFIRMED','ATTENDED') OR (status = 'PENDING_EMAIL' AND hold_expires_at > now()))`;

export async function recordEvent(
  tx: Tx,
  commitmentId: string,
  type: string,
  from: string | null,
  to: string | null,
  actor: "VOLUNTEER" | "ORG" | "SYSTEM",
): Promise<void> {
  await tx.query(
    `INSERT INTO volunteer_commitment_events (commitment_id, event_type, from_status, to_status, actor_role) VALUES ($1, $2, $3, $4, $5)`,
    [commitmentId, type, from, to, actor],
  );
}

/**
 * Public, no account. Holds a slot of an open project's need for HOLD_HOURS and emails a private link.
 * Sign-ups for one need are serialised by a row lock on the need, so a slot can never be given out twice.
 * Never returns the token: it exists only in the email.
 */
export async function signUpForNeed(driver: Driver, raw: unknown): Promise<{ commitmentId: string }> {
  const input = parseOrThrow(signupSchema, raw);
  try {
    return await runIn(driver, { kind: "system" }, async (tx) => {
      const need = await tx.query<{
        id: string; slots_needed: number; title: string; starts_at: Date | null; ends_at: Date | null;
        project_status: string; project_title: string; org_ok: boolean; org_name: string;
      }>(
        `SELECT n.id, n.slots_needed, n.title, n.starts_at, n.ends_at, p.status AS project_status, p.title AS project_title,
                (o.status = 'APPROVED' AND NOT o.publication_suspended) AS org_ok, o.display_name AS org_name
           FROM project_needs n JOIN projects p ON p.id = n.project_id JOIN organizations o ON o.id = p.org_id
          WHERE n.id = $1 FOR UPDATE OF n`,
        [input.needId],
      );
      if (!need.length) throw new AppError("NOT_FOUND", "That volunteer role was not found.");
      const n = need[0];
      if (n.project_status !== "OPEN" || !n.org_ok) throw new AppError("VALIDATION", "This project is not open for sign-ups right now.");
      if (n.ends_at && new Date(n.ends_at).getTime() <= Date.now()) throw new AppError("VALIDATION", "This shift has already ended.");

      // Free the slots of abandoned sign-ups before counting.
      const expired = await tx.query<{ id: string }>(
        `UPDATE volunteer_commitments SET status = 'CANCELLED', cancelled_at = now()
          WHERE need_id = $1 AND status = 'PENDING_EMAIL' AND hold_expires_at <= now() RETURNING id`,
        [input.needId],
      );
      for (const e of expired) await recordEvent(tx, e.id, "HOLD_EXPIRED", "PENDING_EMAIL", "CANCELLED", "SYSTEM");

      // Fullness is judged first and answered identically for everyone, so asking "is this address already signed up?"
      // cannot be told apart from asking about any other address. (A person's own hold counts toward fullness.)
      const taken = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM volunteer_commitments WHERE need_id = $1 AND ${TAKEN_SQL}`,
        [input.needId],
      );
      if (taken[0].n >= n.slots_needed) throw new AppError("CONFLICT", "This shift is full right now. Spots open up when someone cancels.");

      // The same address twice quietly resolves to the existing sign-up: no second row, no second email, same reply.
      const mine = await tx.query<{ id: string }>(
        `SELECT id FROM volunteer_commitments WHERE need_id = $1 AND email = $2 AND status IN ('PENDING_EMAIL','CONFIRMED','ATTENDED') LIMIT 1`,
        [input.needId, input.email],
      );
      if (mine.length) return { commitmentId: mine[0].id };

      // Cancelled and lapsed sign-ups do not count, so nobody can lock another person's address out for a day.
      const recent = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM volunteer_commitments
          WHERE email = $1 AND created_at > now() - interval '24 hours'
            AND status <> 'CANCELLED' AND NOT (status = 'PENDING_EMAIL' AND hold_expires_at <= now())`,
        [input.email],
      );
      if (recent[0].n >= DAILY_SIGNUP_LIMIT) {
        throw new AppError("RATE_LIMITED", "Too many sign-ups from this address today. Please try again tomorrow.");
      }

      const token = newToken();
      const rows = await tx.query<{ id: string }>(
        `INSERT INTO volunteer_commitments (need_id, volunteer_name, email, phone, token_hash, hold_expires_at, consent_share)
         VALUES ($1, $2, $3, $4, $5, now() + make_interval(hours => $6), true) RETURNING id`,
        [input.needId, input.name, input.email, input.phone ?? null, hashToken(token), HOLD_HOURS],
      );
      const id = rows[0].id;
      await recordEvent(tx, id, "SIGNED_UP", null, "PENDING_EMAIL", "VOLUNTEER");
      // Ids only: no name, email, phone or token in the audit trail.
      await writeAudit(tx, { actorUserId: null, action: "VOLUNTEER_SIGNED_UP", subjectType: "volunteer_commitment", subjectId: id, details: { needId: input.needId } });

      const shift = n.starts_at || n.ends_at ? `\nShift: ${fmtShift(n.starts_at) ?? "?"} to ${fmtShift(n.ends_at) ?? "?"} (Eastern Time)` : "";
      await enqueueEmail(tx, {
        kind: "VOLUNTEER_CONFIRM",
        to: input.email,
        subject: `${brandName()}: confirm your volunteer sign-up`,
        body:
          `Thank you for offering to help with "${n.project_title}" (${n.org_name}).\nRole: ${n.title}${shift}\n\n` +
          `Confirm your spot, or cancel it, here:\n${appBaseUrl()}/volunteer/commitments?token=${token}\n\n` +
          `We are holding your spot for ${HOLD_HOURS} hours. Keep this email: the same link lets you see the details and cancel later. ` +
          `If you did not sign up, ignore this message and the spot will be released.`,
      });
      return { commitmentId: id };
    });
  } catch (err) {
    throw fromDbError(err);
  }
}

export type CommitmentView = {
  id: string;
  status: CommitmentStatus;
  /** True when the organization cancelled the project or is no longer approved: the meeting details are withheld. */
  withdrawn: boolean;
  holdExpiresAt: string | null;
  project: { id: string; title: string; orgName: string; countyName: string; state: string; zip: string };
  need: { id: string; title: string; startsAt: string | null; endsAt: string | null; skills: string | null };
  /** Only for a CONFIRMED or ATTENDED volunteer. */
  privateLocationNotes: string | null;
  /** Only for a CONFIRMED or ATTENDED volunteer. */
  instructions: string | null;
};

type DbCommitment = {
  id: string; need_id: string; status: CommitmentStatus; hold_expires_at: Date | null;
  project_status: string; org_ok: boolean;
  project_id: string; project_title: string; org_name: string; county_name: string; state: string; zip: string;
  need_title: string; starts_at: Date | null; ends_at: Date | null; skills: string | null;
  private_location_notes: string | null; instructions: string | null; hold_expired: boolean;
};

/** Tokens are 32 random bytes in base64url (43 chars). Anything else cannot match and is not even looked up. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{20,128}$/;

const COMMITMENT_SELECT = `
  SELECT c.id, c.need_id, c.status, c.hold_expires_at,
         (c.status = 'PENDING_EMAIL' AND c.hold_expires_at <= now()) AS hold_expired,
         p.status AS project_status, (o.status = 'APPROVED' AND NOT o.publication_suspended) AS org_ok,
         p.id AS project_id, p.title AS project_title, o.display_name AS org_name, ct.name AS county_name, ct.state, p.zip,
         n.title AS need_title, n.starts_at, n.ends_at, n.skills, p.private_location_notes, n.instructions
    FROM volunteer_commitments c
    JOIN project_needs n ON n.id = c.need_id JOIN projects p ON p.id = n.project_id
    JOIN organizations o ON o.id = p.org_id JOIN counties ct ON ct.id = p.county_id`;

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);

/** The organization cancelled the project, or is no longer approved to publish: nobody should travel on this sign-up. */
const isWithdrawn = (c: Pick<DbCommitment, "project_status" | "org_ok">) => c.project_status === "CANCELLED" || !c.org_ok;

/**
 * Read-only: the page behind the emailed link. Never changes anything, so an email scanner that prefetches the link
 * cannot confirm or cancel. An unknown token gives null (the same answer as a malformed one).
 * A pending sign-up whose hold has lapsed is shown as CANCELLED, which is what it is about to become.
 */
export async function getCommitmentByToken(driver: Driver, token: string): Promise<CommitmentView | null> {
  if (typeof token !== "string" || !TOKEN_SHAPE.test(token)) return null;
  return runIn(driver, { kind: "system" }, async (tx) => {
    const rows = await tx.query<DbCommitment>(`${COMMITMENT_SELECT} WHERE c.token_hash = $1`, [hashToken(token)]);
    if (!rows.length) return null;
    const r = rows[0];
    const status: CommitmentStatus = r.hold_expired ? "CANCELLED" : r.status;
    const withdrawn = isWithdrawn(r);
    const reveal = (status === "CONFIRMED" || status === "ATTENDED") && !withdrawn;
    return {
      id: r.id, status, withdrawn, holdExpiresAt: status === "PENDING_EMAIL" ? iso(r.hold_expires_at) : null,
      project: { id: r.project_id, title: r.project_title, orgName: r.org_name, countyName: r.county_name, state: r.state, zip: r.zip },
      need: { id: r.need_id, title: r.need_title, startsAt: iso(r.starts_at), endsAt: iso(r.ends_at), skills: r.skills },
      privateLocationNotes: reveal ? r.private_location_notes : null,
      instructions: reveal ? r.instructions : null,
    };
  });
}

/** Lock order everywhere: the need first, then the commitment. Returns null for an unknown token. */
async function lockByToken(tx: Tx, token: string): Promise<DbCommitment | null> {
  if (typeof token !== "string" || !TOKEN_SHAPE.test(token)) return null;
  const found = await tx.query<{ need_id: string }>(`SELECT need_id FROM volunteer_commitments WHERE token_hash = $1`, [hashToken(token)]);
  if (!found.length) return null;
  await tx.query(`SELECT 1 FROM project_needs WHERE id = $1 FOR UPDATE`, [found[0].need_id]);
  const rows = await tx.query<DbCommitment>(`${COMMITMENT_SELECT} WHERE c.token_hash = $1 FOR UPDATE OF c`, [hashToken(token)]);
  return rows[0] ?? null;
}

/**
 * Tell volunteers that their plans are off. These messages carry no private link and no meeting details: only that the
 * sign-up is cancelled and where to find other shifts. Queued in the caller's transaction, so they exist if and only if the
 * cancellation does.
 */
async function enqueueNotice(tx: Tx, to: string, projectTitle: string, needTitle: string, what: "project" | "removed"): Promise<void> {
  const body =
    what === "project"
      ? `The organization cancelled "${projectTitle}", so your volunteer sign-up for "${needTitle}" is cancelled too. Please do not travel for it.`
      : `The organization removed your volunteer sign-up for "${needTitle}" on "${projectTitle}". If you think this is a mistake, please contact the organization.`;
  await enqueueEmail(tx, {
    kind: "VOLUNTEER_NOTICE",
    to,
    subject: `${brandName()}: your volunteer sign-up was cancelled`,
    body: `${body}\n\nYou can find other shifts at ${appBaseUrl()}/projects`,
  });
}

/** Email every volunteer who holds a slot (confirmed, or pending with an unexpired hold) that the project was cancelled. */
export async function noticeProjectCancelled(tx: Tx, projectId: string): Promise<void> {
  const rows = await tx.query<{ email: string; project_title: string; need_title: string }>(
    `SELECT c.email, p.title AS project_title, n.title AS need_title
       FROM volunteer_commitments c JOIN project_needs n ON n.id = c.need_id JOIN projects p ON p.id = n.project_id
      WHERE p.id = $1 AND (c.status = 'CONFIRMED' OR (c.status = 'PENDING_EMAIL' AND c.hold_expires_at > now()))
      ORDER BY c.created_at, c.id`,
    [projectId],
  );
  for (const r of rows) await enqueueNotice(tx, r.email, r.project_title, r.need_title, "project");
}

const shiftEnded = (c: DbCommitment) => c.ends_at !== null && new Date(c.ends_at).getTime() <= Date.now();

/** Volunteer: confirm a sign-up (an explicit action, never a page view). Idempotent once confirmed. */
export async function confirmCommitment(driver: Driver, token: string): Promise<void> {
  try {
    const outcome = await runIn(driver, { kind: "system" }, async (tx): Promise<"ok" | "expired"> => {
      const c = await lockByToken(tx, token);
      if (!c) throw new AppError("NOT_FOUND", "This link is not valid.");
      if (c.status === "CONFIRMED" || c.status === "ATTENDED") return "ok";
      if (c.status !== "PENDING_EMAIL") throw new AppError("VALIDATION", "This sign-up was cancelled. You can sign up again from the project page.");
      if (c.hold_expired) {
        // The cancellation must commit even though the caller is told no, so it is returned rather than thrown here.
        await tx.query(`UPDATE volunteer_commitments SET status = 'CANCELLED', cancelled_at = now() WHERE id = $1`, [c.id]);
        await recordEvent(tx, c.id, "HOLD_EXPIRED", "PENDING_EMAIL", "CANCELLED", "SYSTEM");
        return "expired";
      }
      if (isWithdrawn(c)) throw new AppError("VALIDATION", "This project is no longer taking volunteers.");
      if (shiftEnded(c)) throw new AppError("VALIDATION", "This shift has already ended.");
      await tx.query(`UPDATE volunteer_commitments SET status = 'CONFIRMED', confirmed_at = now() WHERE id = $1`, [c.id]);
      await recordEvent(tx, c.id, "CONFIRMED", "PENDING_EMAIL", "CONFIRMED", "VOLUNTEER");
      await writeAudit(tx, { actorUserId: null, action: "VOLUNTEER_CONFIRMED", subjectType: "volunteer_commitment", subjectId: c.id, details: { needId: c.need_id } });
      return "ok";
    });
    if (outcome === "expired") throw new AppError("VALIDATION", "The 24-hour hold on this spot has ended. Please sign up again from the project page.");
  } catch (err) {
    throw fromDbError(err);
  }
}

/** Volunteer: cancel a pending or confirmed sign-up until the shift ends. Idempotent once cancelled. */
export async function cancelCommitment(driver: Driver, token: string): Promise<void> {
  try {
    await runIn(driver, { kind: "system" }, async (tx) => {
      const c = await lockByToken(tx, token);
      if (!c) throw new AppError("NOT_FOUND", "This link is not valid.");
      if (c.status === "CANCELLED") return;
      if (c.status === "ATTENDED" || c.status === "NO_SHOW") throw new AppError("VALIDATION", "Attendance has been recorded, so this sign-up can no longer be cancelled.");
      if (shiftEnded(c)) throw new AppError("VALIDATION", "This shift has already ended.");
      await tx.query(`UPDATE volunteer_commitments SET status = 'CANCELLED', cancelled_at = now() WHERE id = $1`, [c.id]);
      await recordEvent(tx, c.id, "CANCELLED", c.status, "CANCELLED", "VOLUNTEER");
      await writeAudit(tx, { actorUserId: null, action: "VOLUNTEER_CANCELLED", subjectType: "volunteer_commitment", subjectId: c.id, details: { needId: c.need_id } });
    });
  } catch (err) {
    throw fromDbError(err);
  }
}

export type RosterRow = {
  id: string;
  needId: string;
  needTitle: string;
  volunteerName: string;
  email: string;
  phone: string | null;
  status: CommitmentStatus;
  createdAt: string;
  confirmedAt: string | null;
};

/** Org admins and editors of the owning org may run the roster. */
async function isOrgEditor(tx: Tx, orgId: string, userId: string): Promise<boolean> {
  const role = await membershipRole(tx, orgId, userId);
  return role === "ORG_ADMIN" || role === "EDITOR";
}

/**
 * The people signed up for a project's shifts. Org admins and editors of the owning org, administrators of the project's
 * county, and executives may read it; everyone else (including org viewers) is refused. Expired holds are not people.
 */
export async function listRoster(driver: Driver, userId: string, projectId: string): Promise<RosterRow[]> {
  const id = parseOrThrow(z.string().uuid(), projectId);
  return runIn(driver, { kind: "system" }, async (tx) => {
    const p = await tx.query<{ org_id: string; county_id: string }>(`SELECT org_id, county_id FROM projects WHERE id = $1`, [id]);
    if (!p.length) throw new AppError("NOT_FOUND", "Project not found.");
    const access = await loadAccess(tx, userId);
    if (!(await isOrgEditor(tx, p[0].org_id, userId)) && !canManageCounty(access, p[0].county_id)) {
      throw new AppError("FORBIDDEN", "You cannot see this project's volunteers.");
    }
    const rows = await tx.query<{
      id: string; need_id: string; need_title: string; volunteer_name: string; email: string; phone: string | null;
      status: CommitmentStatus; created_at: Date; confirmed_at: Date | null;
    }>(
      `SELECT c.id, c.need_id, n.title AS need_title, c.volunteer_name, c.email, c.phone, c.status, c.created_at, c.confirmed_at
         FROM volunteer_commitments c JOIN project_needs n ON n.id = c.need_id
        WHERE n.project_id = $1 AND NOT (c.status = 'PENDING_EMAIL' AND c.hold_expires_at <= now())
        ORDER BY n.starts_at NULLS LAST, n.created_at, n.id, c.created_at, c.id`,
      [id],
    );
    return rows.map((r) => ({
      id: r.id, needId: r.need_id, needTitle: r.need_title, volunteerName: r.volunteer_name, email: r.email, phone: r.phone,
      status: r.status, createdAt: new Date(r.created_at).toISOString(), confirmedAt: iso(r.confirmed_at),
    }));
  });
}

/**
 * Org admin or editor: record attendance (once the shift has started), or cancel a sign-up to free its slot.
 * Lock order matches sign-up: the need, then the commitment.
 */
export async function markAttendance(driver: Driver, userId: string, commitmentId: string, to: "ATTENDED" | "NO_SHOW" | "CANCELLED"): Promise<void> {
  const id = parseOrThrow(z.string().uuid(), commitmentId);
  const target = parseOrThrow(z.enum(["ATTENDED", "NO_SHOW", "CANCELLED"]), to);
  try {
    await runIn(driver, { kind: "system" }, async (tx) => {
      const found = await tx.query<{ need_id: string; org_id: string }>(
        `SELECT c.need_id, p.org_id FROM volunteer_commitments c JOIN project_needs n ON n.id = c.need_id JOIN projects p ON p.id = n.project_id WHERE c.id = $1`,
        [id],
      );
      if (!found.length) throw new AppError("NOT_FOUND", "Sign-up not found.");
      if (!(await isOrgEditor(tx, found[0].org_id, userId))) throw new AppError("FORBIDDEN", "Only editors of the organization can change sign-ups.");
      await tx.query(`SELECT 1 FROM project_needs WHERE id = $1 FOR UPDATE`, [found[0].need_id]);
      const rows = await tx.query<{ status: CommitmentStatus; starts_at: Date | null }>(
        `SELECT c.status, n.starts_at FROM volunteer_commitments c JOIN project_needs n ON n.id = c.need_id WHERE c.id = $1 FOR UPDATE OF c`,
        [id],
      );
      const c = rows[0];
      if (target === "CANCELLED") {
        if (c.status === "CANCELLED") return;
        if (c.status !== "PENDING_EMAIL" && c.status !== "CONFIRMED") throw new AppError("VALIDATION", "This sign-up can no longer be cancelled.");
        await tx.query(`UPDATE volunteer_commitments SET status = 'CANCELLED', cancelled_at = now() WHERE id = $1`, [id]);
        const who = await tx.query<{ email: string; project_title: string; need_title: string }>(
          `SELECT c.email, p.title AS project_title, n.title AS need_title
             FROM volunteer_commitments c JOIN project_needs n ON n.id = c.need_id JOIN projects p ON p.id = n.project_id WHERE c.id = $1`,
          [id],
        );
        await enqueueNotice(tx, who[0].email, who[0].project_title, who[0].need_title, "removed");
      } else {
        if (c.status !== "CONFIRMED") throw new AppError("VALIDATION", "Only a confirmed volunteer can be marked as attended or a no-show.");
        if (c.starts_at && new Date(c.starts_at).getTime() > Date.now()) throw new AppError("VALIDATION", "The shift has not started yet.");
        await tx.query(
          `UPDATE volunteer_commitments SET status = $2, attendance_marked_by = $3, attendance_marked_at = now() WHERE id = $1`,
          [id, target, userId],
        );
      }
      await recordEvent(tx, id, target, c.status, target, "ORG");
      await writeAudit(tx, {
        actorUserId: userId, actorOrgId: found[0].org_id, action: "VOLUNTEER_STATUS_BY_ORG", subjectType: "volunteer_commitment", subjectId: id,
        details: { needId: found[0].need_id, from: c.status, to: target },
      });
    });
  } catch (err) {
    throw fromDbError(err);
  }
}
