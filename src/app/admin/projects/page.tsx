import type { Metadata } from "next";
import Link from "next/link";
import { gateAdminError } from "@/app/admin/events/gate";
import { ProjectReviewForm } from "@/components/project-review-form";
import { PROJECT_AUDIENCE_LABELS } from "@/lib/projects";
import { getDriver } from "@/server/db";
import { listProjectsForReview, type ProjectRow } from "@/server/modules/projects";
import { requireUser } from "@/server/session";
import { reviewProjectAction } from "./actions";

export const metadata: Metadata = { title: "Project review", robots: { index: false } };
export const dynamic = "force-dynamic";

const fmtShift = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" }) : null;

export default async function AdminProjectsPage() {
  const user = await requireUser();
  let projects: ProjectRow[];
  try {
    projects = await listProjectsForReview(await getDriver(), user.id);
  } catch (err) {
    return gateAdminError(err);
  }
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6">
      <Link href="/admin" className="text-sm text-brand underline">← Administration</Link>
      <h1 className="mt-2 text-2xl font-bold">Project review</h1>
      <p className="text-sm text-muted">
        Projects wait here before the public sees them. Check that nothing names a person or gives a home address.
        You cannot review your own organization&apos;s project. County administrators see their counties only.
      </p>
      <ul className="mt-5 grid gap-4">
        {projects.map((p) => (
          <li key={p.id} className="card p-4">
            <h2 className="text-lg font-semibold">{p.title}</h2>
            <p className="text-sm text-muted">
              {p.orgName} · {p.countyName}, {p.state} {p.zip} · {PROJECT_AUDIENCE_LABELS[p.audience as keyof typeof PROJECT_AUDIENCE_LABELS] ?? p.audience}
            </p>
            <p className="mt-2 whitespace-pre-line text-sm">{p.description}</p>
            {p.privateLocationNotes && <p className="mt-2 text-sm"><strong>Private location notes:</strong> {p.privateLocationNotes}</p>}
            <ul className="mt-3 divide-y divide-line text-sm">
              {p.needs.map((n) => (
                <li key={n.id} className="py-1.5">
                  <span className="font-medium">{n.title}</span> · {n.slotsNeeded} needed{n.urgency === "URGENT" ? " · urgent" : ""}
                  {(n.startsAt || n.endsAt) && <span className="text-muted"> · {fmtShift(n.startsAt)} to {fmtShift(n.endsAt)} (Eastern Time)</span>}
                  {n.skills && <span className="text-muted"> · {n.skills}</span>}
                </li>
              ))}
            </ul>
            <div className="mt-4"><ProjectReviewForm action={reviewProjectAction.bind(null, p.id)} /></div>
          </li>
        ))}
        {projects.length === 0 && <li className="text-sm text-muted">No projects are waiting for review.</li>}
      </ul>
    </div>
  );
}
