import type { Metadata } from "next";
import Link from "next/link";
import { ProgressForm, RespondForm } from "@/components/project-forms";
import { getDriver } from "@/server/db";
import { COMMITMENT_LABELS, listMyCommitments } from "@/server/modules/projects";
import { requireUser } from "@/server/session";
import { progressAction, respondAction } from "../../projects/actions";

export const metadata: Metadata = { title: "My commitments", robots: { index: false } };
export const dynamic = "force-dynamic";

/** Nonprofit view: commitments assigned to the organizations the signed-in person belongs to. */
export default async function MyCommitments() {
  const user = await requireUser();
  const rows = await listMyCommitments(await getDriver(), user.id);
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6">
      <p className="text-sm"><Link className="underline" href="/dashboard">← Dashboard</Link></p>
      <h1 className="mt-2 text-3xl">My commitments</h1>
      <p className="mt-2 text-sm text-muted">Resources your organization has been asked to provide for community projects. Accepting is always your choice; coordinators record receipt and verification.</p>
      <section className="card mt-5 p-4" aria-label="Commitments">
        {rows.length === 0 ? <p className="text-sm text-muted">No commitments are assigned to your organization.</p> : (
          <ul className="divide-y divide-line">
            {rows.map((k) => (
              <li key={k.id} className="py-3">
                <div className="flex flex-wrap items-center gap-2 text-sm"><strong>{k.projectTitle}</strong><span className="font-mono text-xs">{k.projectReference}</span><span className="badge tone-brand">{COMMITMENT_LABELS[k.status]}</span></div>
                <p className="mt-1 text-sm">{k.needLabel}: offered {k.offered.toLocaleString("en-US")}, accepted {k.accepted.toLocaleString("en-US")}, dispatched {k.dispatched.toLocaleString("en-US")}, received {k.received.toLocaleString("en-US")}, verified {k.verified.toLocaleString("en-US")}{k.scheduledFor ? ` · scheduled ${k.scheduledFor}` : ""}</p>
                {k.status === "PROPOSED" && <div className="mt-2"><RespondForm action={respondAction} projectId={k.projectId} commitmentId={k.id} offered={k.offered} needsNote={false} /></div>}
                {k.status === "ACCEPTED" && <div className="mt-2"><ProgressForm action={progressAction} projectId={k.projectId} commitmentId={k.id} stage="DISPATCHED" max={k.accepted} needsReceiver={false} label="Report dispatched" /></div>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
