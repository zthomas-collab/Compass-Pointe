import type { Metadata } from "next";
import Link from "next/link";
import { VolunteerSectionNav } from "@/components/volunteer-nav";
import { VOLUNTEER_PATHS } from "@/lib/volunteer-paths";

export const metadata: Metadata = { title: "Thank you", robots: { index: false } };

export default async function Thanks({ searchParams }: { searchParams: Promise<{ ref?: string }> }) {
  const { ref } = await searchParams;
  const reference = ref && /^OFR-\d{4}-\d{6}$/.test(ref) ? ref : null;
  return (
    <>
      <VolunteerSectionNav current="donate" />
      <div className="mx-auto w-full max-w-xl px-4 py-8">
        <h1 className="text-3xl">Thank you</h1>
        <p className="mt-3">We received your offer.</p>
        {reference && (
          <p className="card mt-4 p-4">Your reference number: <strong className="font-mono">{reference}</strong><br />
            <span className="text-sm text-muted">Keep this number if you contact us about your offer. We also emailed it to you.</span></p>
        )}

        <section className="mt-6" aria-labelledby="next-h">
          <h2 id="next-h" className="text-xl">What happens next</h2>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm">
            <li>A coordinator reviews your offer and matches it to a real need if one fits.</li>
            <li>If they can use it, they will contact you using the details you gave.</li>
            <li>Sending an offer does not commit anyone to accept it, and we cannot promise it will be used.</li>
          </ol>
        </section>

        <p className="mt-6 text-sm text-muted">Want to do more in the meantime?</p>
        <p className="mt-2 flex flex-wrap gap-3">
          <Link className="btn btn-primary" href={VOLUNTEER_PATHS.shifts}>Find a volunteer shift</Link>
          <Link className="btn btn-secondary" href="/events">See current events</Link>
        </p>
      </div>
    </>
  );
}
