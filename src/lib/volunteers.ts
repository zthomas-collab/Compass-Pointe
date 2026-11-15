/** Client-safe volunteer constants (no server imports): shared by the service and the screens. */
export const COMMITMENT_STATUSES = ["PENDING_EMAIL", "CONFIRMED", "CANCELLED", "ATTENDED", "NO_SHOW"] as const;
export type CommitmentStatus = (typeof COMMITMENT_STATUSES)[number];

/** An unconfirmed sign-up holds its slot this long. */
export const HOLD_HOURS = 24;
/** One email address may start at most this many sign-ups in 24 hours. */
export const DAILY_SIGNUP_LIMIT = 5;
