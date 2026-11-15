import type { Metadata } from "next";
import Link from "next/link";
import { ActionButton } from "@/components/project-forms";
import { VOLUNTEER_PATHS, shiftPath } from "@/lib/volunteer-paths";
import { getDriver } from "@/server/db";
import { getCommitmentByToken } from "@/server/modules/volunteers";
import { cancelCommitmentAction, confirmCommitmentAction } from "./actions";

// The link is private: keep it out of search results and never reveal anything for a token that does not match.
export const metadata: Metadata = { title: "Your volunteer sign-up", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

const fmt = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" }) : null;

function NotValid() {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-8">
      <h1 className="text-2xl">This link is not valid</h1>
      <p className="mt-2 text-muted">
        It may have been mistyped or cut off. Use the link in your confirmation email, or find a shift on the{" "}
        <Link className="underline" href={VOLUNTEER_PATHS.shifts}>volunteer shifts page</Link>.
      </p>
    </div>
  );
}

/**
 * The page behind the emailed link. Opening it only SHOWS the sign-up: confirming and cancelling are explicit button presses,
 * because email scanners open links automatically.
 */
export default async function CommitmentPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  const view = typeof token === "string" ? await getCommitmentByToken(await getDriver(), token) : null;
  if (!view || typeof token !== "string") return <NotValid />;
  const { status, project, need } = view;
  const shift = need.startsAt || need.endsAt ? `${fmt(need.startsAt) ?? "?"} to ${fmt(need.endsAt) ?? "?"} (Eastern Time)` : null;
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-6">
      <h1 className="text-2xl">Your volunteer sign-up</h1>
      <div className="card mt-4 p-4">
        <p className="text-sm text-muted">{project.orgName} · {project.countyName}, {project.state} {project.zip}</p>
        <h2 className="mt-1 text-lg font-semibold">{project.title}</h2>
        <p className="mt-1">Role: <strong>{need.title}</strong></p>
        {shift && <p className="text-sm text-muted">{shift}</p>}
        {need.skills && <p className="text-sm text-muted">Skills or what to bring: {need.skills}</p>}
      </div>

      {view.withdrawn && (status === "PENDING_EMAIL" || status === "CONFIRMED") && (
        <section role="alert" className="mt-4 rounded-md bg-bad-bg p-4 text-bad" aria-labelledby="withdrawn-h">
          <h2 id="withdrawn-h" className="text-lg font-semibold"><span aria-hidden="true">✕</span> This project has been withdrawn</h2>
          <p className="mt-1 text-sm">
            The organization cancelled this project or is not currently active, so please do not travel for it. You can step back
            from this sign-up below, or look for other shifts on the <Link className="underline" href={VOLUNTEER_PATHS.shifts}>shifts page</Link>.
          </p>
          <div className="mt-3"><ActionButton action={cancelCommitmentAction.bind(null, token)} label="Cancel my sign-up" /></div>
        </section>
      )}

      {!view.withdrawn && status === "PENDING_EMAIL" && (
        <section className="card mt-4 p-4" aria-labelledby="pending-h">
          <h2 id="pending-h" className="text-lg font-semibold">Confirm your spot</h2>
          <p className="mt-1 text-sm text-muted">
            <span aria-hidden="true">⏳</span> We are holding your spot until {fmt(view.holdExpiresAt)}. Press the button to confirm it.
          </p>
          <div className="mt-3 flex flex-wrap gap-3">
            <ActionButton action={confirmCommitmentAction.bind(null, token)} label="Confirm my spot" className="btn btn-primary" />
            <ActionButton action={cancelCommitmentAction.bind(null, token)} label="Cancel" />
          </div>
        </section>
      )}

      {!view.withdrawn && (status === "CONFIRMED" || status === "ATTENDED") && (
        <section className="card mt-4 p-4" aria-labelledby="confirmed-h">
          <h2 id="confirmed-h" className="text-lg font-semibold">
            <span aria-hidden="true">✓</span> {status === "ATTENDED" ? "Thank you for helping" : "You are confirmed"}
          </h2>
          {view.privateLocationNotes && (
            <p className="mt-2 whitespace-pre-line text-sm"><strong>Where to go:</strong> {view.privateLocationNotes}</p>
          )}
          {view.instructions && <p className="mt-2 whitespace-pre-line text-sm"><strong>Instructions:</strong> {view.instructions}</p>}
          <p className="mt-2 text-sm text-muted">Please keep this link private: it shows the meeting details.</p>
          {status === "CONFIRMED" && (
            <div className="mt-3"><ActionButton action={cancelCommitmentAction.bind(null, token)} label="Cancel my sign-up" /></div>
          )}
        </section>
      )}

      {status === "CANCELLED" && (
        <p role="status" className="mt-4 rounded-md bg-surface p-3 text-sm">
          This sign-up was cancelled or its 24-hour hold ended, so the spot was released.{" "}
          <Link className="underline" href={shiftPath(project.id)}>Sign up again on the project page</Link>.
        </p>
      )}
      {status === "NO_SHOW" && <p role="status" className="mt-4 rounded-md bg-surface p-3 text-sm">This sign-up has been closed by the organization.</p>}
    </div>
  );
}
