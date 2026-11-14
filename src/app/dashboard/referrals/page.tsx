import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ApplicationRows } from "@/components/assistance-ui";
import { getDriver } from "@/server/db";
import { AppError } from "@/server/errors";
import { STATUS_LABELS, listApplicationsForStaff } from "@/server/modules/assistance";
import { requireUser } from "@/server/session";

export const metadata: Metadata = { title: "Referred requests", robots: { index: false } };
export const dynamic = "force-dynamic";

/** Requests a county has referred to the signed-in person's organization (only with the applicant's consent). */
export default async function Referrals({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const user = await requireUser();
  const { status } = await searchParams;
  let r;
  try {
    r = await listApplicationsForStaff(await getDriver(), user.id, { status });
  } catch (err) {
    if (err instanceof AppError && err.code === "FORBIDDEN") notFound();
    if (err instanceof AppError && err.code === "VALIDATION") return <p className="mx-auto max-w-3xl px-4 py-6">Check the filter and try again.</p>;
    throw err;
  }
  const tabs: [string, string][] = [["", "All"], ["REFERRED", STATUS_LABELS.REFERRED], ["IN_PROGRESS", STATUS_LABELS.IN_PROGRESS], ["COMPLETED", STATUS_LABELS.COMPLETED]];
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6">
      <p className="text-sm"><Link className="underline" href="/dashboard">← Dashboard</Link></p>
      <h1 className="mt-2 text-3xl">Referred requests</h1>
      <p className="mt-2 text-sm text-muted">
        These households agreed to share their request with a provider. Open one to accept it, record progress, mark it completed, or return it to the county with a reason.
        Opening a request is recorded in the audit log. Use the details only to deliver the help requested.
      </p>
      <nav className="mt-4 flex flex-wrap gap-2" aria-label="Filter by status">
        {tabs.map(([v, label]) => (
          <Link key={v} href={v ? `?status=${v}` : "?"} className={`rounded-md border px-3 py-1.5 text-sm font-semibold ${(status ?? "") === v ? "border-brand bg-brand text-white" : "border-line bg-surface"}`}>{label}</Link>
        ))}
      </nav>
      <section className="card mt-4 p-4" aria-label="Referred requests">
        {r.rows.length === 0 ? <p className="text-sm text-muted">Nothing has been referred to your organization.</p> : <ApplicationRows rows={r.rows} basePath="/admin/applications" />}
      </section>
    </div>
  );
}
