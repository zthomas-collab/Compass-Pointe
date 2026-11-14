import Link from "next/link";

export type Stat = { label: string; value: number | string; href?: string; hint?: string; tone?: "warn" | "ok" };

/** A row of metric cards. Every value is passed in from a database count; nothing here is static. */
export function StatGrid({ stats, label }: { stats: Stat[]; label: string }) {
  return (
    <section aria-label={label} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {stats.map((s) => {
        const inner = (
          <>
            <div className="text-xs font-semibold uppercase tracking-wide text-muted">{s.label}</div>
            <div className={`mt-1 text-3xl font-semibold ${s.tone === "warn" ? "text-warn" : "text-brand"}`} style={{ fontFamily: "var(--font-serif)" }}>
              {typeof s.value === "number" ? s.value.toLocaleString("en-US") : s.value}
            </div>
            {s.hint && <div className="mt-1 text-xs text-muted">{s.hint}</div>}
          </>
        );
        return s.href ? (
          <Link key={s.label} href={s.href} className="card block border-t-4 border-t-gold p-4 hover:bg-neutral-bg">{inner}</Link>
        ) : (
          <div key={s.label} className="card border-t-4 border-t-gold p-4">{inner}</div>
        );
      })}
    </section>
  );
}

export function FilterBar({ children, action }: { children: React.ReactNode; action: string }) {
  return (
    <form method="get" action={action} className="card mt-4 grid gap-3 p-4 sm:grid-cols-5">
      {children}
      <div className="flex items-end"><button className="btn btn-primary w-full" type="submit">Apply filters</button></div>
    </form>
  );
}
