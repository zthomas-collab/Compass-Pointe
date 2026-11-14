import type { Metadata } from "next";
import Link from "next/link";
import { LearningCard } from "@/components/learning-ui";
import { getDriver } from "@/server/db";
import { LEARNING_CATEGORIES, LEARNING_CATEGORY_LABELS, listPublicResources } from "@/server/modules/learning";

export const metadata: Metadata = { title: "Learn" };
export const dynamic = "force-dynamic";

export default async function LearnPage({ searchParams }: { searchParams: Promise<{ category?: string; q?: string }> }) {
  const { category, q } = await searchParams;
  const items = await listPublicResources(await getDriver(), { category, q });
  const chip = (on: boolean) => `rounded-full border px-3 py-1 text-sm font-semibold ${on ? "border-brand bg-brand text-white" : "border-line bg-surface"}`;
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6">
      <h1 className="text-3xl">Learn</h1>
      <p className="mt-2 text-muted">Preparedness, recovery and how-to guides from Crisis Compass Carolinas and approved partner organizations. Every item is reviewed before it appears here.</p>
      <form method="get" className="card mt-4 flex flex-wrap items-end gap-3 p-4">
        {category && <input type="hidden" name="category" value={category} />}
        <label className="field grow"><span>Search</span><input className="input" name="q" defaultValue={q ?? ""} maxLength={80} /></label>
        <button className="btn btn-primary" type="submit">Search</button>
      </form>
      <nav className="mt-3 flex flex-wrap gap-2" aria-label="Categories">
        <Link className={chip(!category)} href={q ? `?q=${encodeURIComponent(q)}` : "?"}>All</Link>
        {LEARNING_CATEGORIES.map((c) => <Link key={c} className={chip(category === c)} href={`?category=${c}${q ? `&q=${encodeURIComponent(q)}` : ""}`}>{LEARNING_CATEGORY_LABELS[c]}</Link>)}
      </nav>
      <section className="mt-4 grid gap-4" aria-label="Learning materials">
        {items.length === 0 ? <p className="text-sm text-muted">Nothing matches yet.</p> : items.map((i) => <LearningCard key={i.id} {...i} href={`/learn/${i.id}`} />)}
      </section>
      <p className="mt-6 rounded-md bg-bad-bg p-3 text-sm text-bad"><strong>Life-threatening emergency? Call 911.</strong> These materials are general guidance, not emergency instructions or professional advice.</p>
    </div>
  );
}
