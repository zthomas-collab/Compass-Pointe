import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PriorityBadge, ProgressBar, ProjectStatusBadge, typeLabel } from "@/components/project-ui";
import { getDriver } from "@/server/db";
import { getPublicProject } from "@/server/modules/projects";

export const metadata: Metadata = { title: "Community project" };
export const dynamic = "force-dynamic";

export default async function PublicProjectPage({ params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params;
  const r = await getPublicProject(await getDriver(), ref);
  if (!r) notFound();
  const { project: p, updates } = r;
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6">
      <p className="text-sm"><Link className="underline" href="/projects">← All projects</Link></p>
      <h1 className="mt-2 text-3xl">{p.title}</h1>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-sm"><ProjectStatusBadge status={p.status} /><PriorityBadge priority={p.priority} />
        <span>{typeLabel(p.category)}</span><span className="text-muted">{p.countyName} County · ZIP {p.zips.join(", ")}</span></div>
      <p className="mt-3">{p.summary}</p>
      <section className="card mt-5 p-4" aria-labelledby="progress">
        <h2 id="progress" className="text-xl">Progress</h2>
        <div className="mt-2 max-w-md"><ProgressBar percent={p.percentVerified} label="Overall progress" /></div>
        <ul className="mt-3 grid gap-3">
          {p.needs.map((x) => {
            const pct = Math.min(100, Math.round((x.verified / x.requested) * 100));
            return (
              <li key={x.label} className="text-sm"><strong>{x.label}</strong>: {x.verified.toLocaleString("en-US")} of {x.requested.toLocaleString("en-US")} {x.unit} confirmed delivered
                <div className="mt-1 max-w-md"><ProgressBar percent={pct} label={`${x.label} progress`} /></div></li>
            );
          })}
        </ul>
        <p className="mt-3 text-xs text-muted">Only quantities confirmed as received count. {p.targetDate ? `Target completion: ${p.targetDate}.` : ""}</p>
      </section>
      {updates.length > 0 && (
        <section className="card mt-5 p-4" aria-labelledby="updates"><h2 id="updates" className="text-xl">Updates</h2>
          <ol className="mt-2 grid gap-3">{updates.map((u) => (
            <li key={u.id} className="border-l-4 border-gold pl-3 text-sm"><time className="text-xs text-muted" dateTime={u.at.toISOString()}>{u.at.toLocaleDateString("en-US", { dateStyle: "medium" })}</time><p className="whitespace-pre-wrap">{u.body}</p></li>
          ))}</ol></section>
      )}
      <p className="mt-6 text-sm">Can you help with this? <Link className="underline" href="/volunteer">Volunteer or donate</Link>. Offers are reviewed by coordinators and are never committed automatically.</p>
    </div>
  );
}
