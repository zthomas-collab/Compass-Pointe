import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError } from "@/server/errors";

/** Turns an access error from an admin read into the right page: MFA prompt, or 404 for anyone who may not see admin pages. */
export function gateAdminError(err: unknown): React.ReactNode {
  if (err instanceof AppError && err.code === "FORBIDDEN" && /Multi-factor/.test(err.message)) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-8">
        <h1 className="text-2xl">Set up multi-factor authentication first</h1>
        <p className="mt-2">
          {err.message} <Link className="underline" href="/account/security?required=1">Set it up now</Link>.
        </p>
      </div>
    );
  }
  if (err instanceof AppError && (err.code === "FORBIDDEN" || err.code === "NOT_FOUND")) notFound();
  throw err;
}
