import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { LearningForm } from "@/components/learning-forms";
import { LearningStatusBadge, categoryLabel } from "@/components/learning-ui";
import { getDriver } from "@/server/db";
import { AppError } from "@/server/errors";
import { LEARNING_CATEGORIES, LEARNING_CATEGORY_LABELS, listMine } from "@/server/modules/learning";
import { listMyOrganizations } from "@/server/modules/organizations";
import { requireUser } from "@/server/session";
import { submitLearningAction } from "../../learn/actions";

export const metadata: Metadata = { title: "Learning materials", robots: { index: false } };
export const dynamic = "force-dynamic";

/** Organizations and county administrators add videos and articles here; an administrator reviews them before they are public. */
export default async function MyLearning({ searchParams }: { searchParams: Promise<{ submitted?: string }> }) {
  const user = await requireUser();
  const { submitted } = await searchParams;
  const db = await getDriver();
  let items;
  try {
    items = await listMine(db, user.id);
  } catch (err) {
    if (err instanceof AppError && err.code === "FORBIDDEN") notFound();
    throw err;
  }
  const orgs = (await listMyOrganizations(db, user.id)).filter((o) => o.status === "APPROVED");
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6">
      <p className="text-sm"><Link className="underline" href="/dashboard">← Dashboard</Link></p>
      <h1 className="mt-2 text-3xl">Learning materials</h1>
      <p className="mt-2 text-sm text-muted">Share a YouTube video or a written guide with the public. An administrator reviews each item before it is published, and will tell you if it needs changes.</p>
      {submitted && <p role="status" className="mt-3 rounded-md bg-ok-bg p-3 text-sm text-ok">Thank you. Your item is waiting for review.</p>}
      <section className="card mt-5 p-4" aria-labelledby="mine"><h2 id="mine" className="text-xl">Your submissions</h2>
        {items.length === 0 ? <p className="mt-2 text-sm text-muted">Nothing submitted yet.</p> : (
          <ul className="mt-2 divide-y divide-line">
            {items.map((i) => (
              <li key={i.id} className="py-3 text-sm">
                <Link className="font-semibold text-brand underline" href={`/dashboard/learning/${i.id}`}>{i.title}</Link> <LearningStatusBadge status={i.status} />
                <div className="text-xs text-muted">{i.kind === "VIDEO" ? "Video" : "Article"} · {categoryLabel(i.category)}{i.orgName ? ` · ${i.orgName}` : ""}</div>
                {i.status === "REJECTED" && i.reviewNote && <p className="mt-1 rounded bg-bad-bg p-2 text-bad">Reviewer: {i.reviewNote}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="card mt-5 p-4" aria-labelledby="add"><h2 id="add" className="text-xl">Add something</h2>
        <div className="mt-3">
          <LearningForm action={submitLearningAction} submit="Submit for review"
            categories={LEARNING_CATEGORIES.map((c) => ({ value: c, label: LEARNING_CATEGORY_LABELS[c] }))} orgs={orgs.map((o) => ({ value: o.id, label: o.displayName }))} />
        </div>
      </section>
    </div>
  );
}
