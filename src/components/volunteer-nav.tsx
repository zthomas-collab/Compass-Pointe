import Link from "next/link";
import { VOLUNTEER_PATHS } from "@/lib/volunteer-paths";

type Section = "overview" | "shifts" | "donate";

const ITEMS: { key: Section; label: string; href: string }[] = [
  { key: "overview", label: "Overview", href: VOLUNTEER_PATHS.hub },
  { key: "shifts", label: "Find a shift", href: VOLUNTEER_PATHS.shifts },
  { key: "donate", label: "Donate", href: VOLUNTEER_PATHS.donate },
];

/** Sub-navigation shown on every page of the Volunteer & donate section. */
export function VolunteerSectionNav({ current }: { current: Section }) {
  return (
    <nav aria-label="Volunteer and donate" className="border-b border-line bg-surface">
      <ul className="mx-auto flex max-w-6xl flex-wrap gap-1 px-4 py-1">
        {ITEMS.map((i) => (
          <li key={i.key}>
            <Link
              href={i.href}
              aria-current={i.key === current ? "page" : undefined}
              className={`inline-block rounded-md px-3 py-2 text-sm font-semibold ${
                i.key === current ? "bg-brand text-white" : "text-brand hover:bg-soft"
              }`}
            >
              {i.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** "Volunteer & donate › Find a shift › <project>" above a page title. The last item is the current page and is not a link. */
export function Breadcrumb({ items }: { items: { label: string; href?: string }[] }) {
  return (
    <nav aria-label="Breadcrumb" className="text-sm text-muted">
      <ol className="flex flex-wrap items-center gap-x-2">
        {items.map((item, i) => {
          const last = i === items.length - 1;
          return (
            <li key={`${item.label}-${i}`} className="flex items-center gap-x-2">
              {item.href && !last ? <Link className="underline" href={item.href}>{item.label}</Link> : <span aria-current={last ? "page" : undefined}>{item.label}</span>}
              {!last && <span aria-hidden="true">›</span>}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
