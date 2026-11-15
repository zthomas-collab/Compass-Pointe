import { z } from "zod";
import { DAILY_SIGNUP_LIMIT, HOLD_HOURS } from "@/lib/volunteers";
import type { Driver, Tx } from "../db";
import { runIn } from "../db/context";
import { AppError, fromDbError } from "../errors";
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

      const recent = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM volunteer_commitments WHERE email = $1 AND created_at > now() - interval '24 hours'`,
        [input.email],
      );
      if (recent[0].n >= DAILY_SIGNUP_LIMIT) {
        throw new AppError("RATE_LIMITED", "You have already signed up for several shifts today. Please try again tomorrow.");
      }

      // Free the slots of abandoned sign-ups before counting.
      const expired = await tx.query<{ id: string }>(
        `UPDATE volunteer_commitments SET status = 'CANCELLED', cancelled_at = now()
          WHERE need_id = $1 AND status = 'PENDING_EMAIL' AND hold_expires_at <= now() RETURNING id`,
        [input.needId],
      );
      for (const e of expired) await recordEvent(tx, e.id, "HOLD_EXPIRED", "PENDING_EMAIL", "CANCELLED", "SYSTEM");

      const mine = await tx.query(
        `SELECT 1 FROM volunteer_commitments WHERE need_id = $1 AND email = $2 AND status IN ('PENDING_EMAIL','CONFIRMED','ATTENDED')`,
        [input.needId, input.email],
      );
      if (mine.length) throw new AppError("CONFLICT", "You already signed up for this shift. Check your email for your link.");

      const taken = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM volunteer_commitments WHERE need_id = $1 AND ${TAKEN_SQL}`,
        [input.needId],
      );
      if (taken[0].n >= n.slots_needed) throw new AppError("CONFLICT", "This shift is full.");

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
