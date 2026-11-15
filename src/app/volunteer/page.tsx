import type { Metadata } from "next";
import Link from "next/link";
import { VolunteerSectionNav } from "@/components/volunteer-nav";
import { OFFER_TYPE_INFO, OFFER_TYPE_LABELS, type OfferType } from "@/lib/offers";
import { VOLUNTEER_PATHS, donatePath, shiftPath } from "@/lib/volunteer-paths";
import { getDriver } from "@/server/db";
import { searchProjects } from "@/server/modules/projects";

export const metadata: Metadata = { title: "Volunteer & donate" };
export const dynamic = "force-dynamic";

/** The most common things people give, shown as quick links on the hub. */
const QUICK_GIFTS: OfferType[] = ["FOOD", "DRINKING_WATER", "BUILDING_SUPPLIES"];

const STEPS = [
  { title: "Choose", text: "Pick a shift that fits your time, or tell us what you can give." },
  { title: "Confirm by email", text: "We email one link to confirm your spot or review your offer. No account to create." },
  { title: "Show up or drop off", text: "You get the details after you confirm. Plans change? Cancel from the same link." },
];

/**
 * The front door: one question, two clear paths. Everything shown comes from real public data (the same search the
 * shifts page uses), and an empty state always offers another way to help.
 */
export default async function VolunteerHubPage() {
  const { projects } = await searchProjects(await getDriver(), {});
  const urgent = projects.slice(0, 3); // The search puts projects with an urgent need first.
  return (
    <>
      <VolunteerSectionNav current="overview" />
      <div className="mx-auto w-full max-w-5xl px-4 py-8">
        <header className="max-w-2xl">
          <h1 className="text-3xl sm:text-4xl">How do you want to help?</h1>
          <p className="mt-2 text-muted">
            Real needs, posted by approved organizations in your community. Choose a path and we will walk you through it.
          </p>
        </header>

        <div className="mt-6 grid gap-5 md:grid-cols-2">
          <section className="card flex flex-col p-5" aria-labelledby="volunteer-h">
            <h2 id="volunteer-h" className="text-2xl">Volunteer my time</h2>
            <p className="mt-1 text-sm text-muted">
              {projects.length > 0
                ? `${projects.length} volunteer project${projects.length === 1 ? "" : "s"} need${projects.length === 1 ? "s" : ""} people right now.`
                : "No shifts are open right now, but new ones are posted often."}
            </p>

            <form method="get" action={VOLUNTEER_PATHS.shifts} className="mt-4 flex flex-wrap items-end gap-2">
              <label className="field flex-1" style={{ minWidth: "9rem" }}>
                <span>Your ZIP code</span>
                <input className="input" name="zip" inputMode="numeric" pattern="[0-9]{5}" maxLength={5} placeholder="28801" autoComplete="postal-code" />
              </label>
              <button className="btn btn-primary" type="submit">Find shifts near me</button>
            </form>

            {urgent.length > 0 ? (
              <div className="mt-5">
                <h3 className="text-sm font-semibold uppercase tracking-wide text-muted">Needed now</h3>
                <ul className="mt-2 divide-y divide-line">
                  {urgent.map((p) => (
                    <li key={p.id} className="py-2">
                      <Link className="font-medium text-brand underline" href={shiftPath(p.id)}>{p.title}</Link>
                      <p className="flex flex-wrap items-center gap-2 text-sm text-muted">
                        {p.hasUrgent && <span className="badge tone-bad"><span aria-hidden="true">!</span> Urgent</span>}
                        <span>{p.orgName} · {p.countyName}, {p.state}</span>
                        <span>
                          {p.needs.length > 0 && p.needs.every((n) => n.ended)
                            ? "Shifts ended"
                            : p.spotsLeft > 0 ? `${p.spotsLeft} of ${p.totalSlots} spots left` : "Full"}
                        </span>
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="mt-5 text-sm">
                Meanwhile you can <Link className="underline" href={donatePath("VOLUNTEER_LABOR")}>tell us you are available to help</Link> and
                a coordinator will look for a fit.
              </p>
            )}

            <p className="mt-auto pt-5">
              <Link className="btn btn-secondary" href={VOLUNTEER_PATHS.shifts}>Browse all shifts</Link>
            </p>
          </section>

          <section className="card flex flex-col p-5" aria-labelledby="donate-h">
            <h2 id="donate-h" className="text-2xl">Donate supplies, equipment or space</h2>
            <p className="mt-1 text-sm text-muted">
              Food, water, building materials, tools, a truck or a warehouse. Coordinators match each offer to a real need.
            </p>
            <ul className="mt-4 grid gap-2">
              {QUICK_GIFTS.map((code) => (
                <li key={code}>
                  <Link
                    href={donatePath(code)}
                    className="flex items-center gap-3 rounded-md border border-line p-3 no-underline hover:border-brand focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
                  >
                    <span aria-hidden="true" className="text-2xl leading-none">{OFFER_TYPE_INFO[code].glyph}</span>
                    <span>
                      <span className="block font-semibold text-brand">{OFFER_TYPE_LABELS[code]}</span>
                      <span className="block text-sm text-muted">{OFFER_TYPE_INFO[code].description}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
            <p className="mt-auto pt-5">
              <Link className="btn btn-primary" href={VOLUNTEER_PATHS.donate}>See everything you can give</Link>
            </p>
          </section>
        </div>

        <p className="mt-5 text-sm">
          Skilled professional (electrician, nurse, translator, driver)?{" "}
          <Link className="underline" href={donatePath("PROFESSIONAL_SKILLS")}>Offer your skills</Link>.
        </p>

        <section className="mt-10" aria-labelledby="how-h">
          <h2 id="how-h" className="text-xl">How it works</h2>
          <ol className="mt-3 grid gap-4 sm:grid-cols-3">
            {STEPS.map((s, i) => (
              <li key={s.title} className="card p-4">
                <span aria-hidden="true" className="badge tone-brand">{i + 1}</span>
                <h3 className="mt-2 font-semibold">{s.title}</h3>
                <p className="mt-1 text-sm text-muted">{s.text}</p>
              </li>
            ))}
          </ol>
        </section>

        <p className="mt-8 rounded-md bg-surface p-4 text-sm text-muted">
          No account needed · Your details are shared only with the organization you help · Cancel any time from your email link.
        </p>
        <p className="mt-4 text-sm">
          Helping with a specific disaster? <Link className="underline" href="/events">See current events</Link>.
        </p>
      </div>
    </>
  );
}
