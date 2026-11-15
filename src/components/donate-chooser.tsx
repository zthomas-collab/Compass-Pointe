import Link from "next/link";
import { OFFER_TYPES, OFFER_TYPE_INFO, OFFER_TYPE_LABELS } from "@/lib/offers";
import { donatePath } from "@/lib/volunteer-paths";

/** "What are you giving?": one large link card per offer type. Each is a plain link, so it works without JavaScript. */
export function DonateChooser() {
  return (
    <ul className="mt-4 grid gap-3 sm:grid-cols-2" aria-label="What would you like to give?">
      {OFFER_TYPES.map((code) => {
        const info = OFFER_TYPE_INFO[code];
        return (
          <li key={code}>
            <Link
              href={donatePath(code)}
              className="card flex h-full gap-3 p-4 no-underline transition hover:border-brand hover:shadow-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
            >
              <span aria-hidden="true" className="text-3xl leading-none">{info.glyph}</span>
              <span>
                <span className="block text-lg font-semibold text-brand">{OFFER_TYPE_LABELS[code]}</span>
                <span className="mt-1 block text-sm text-muted">{info.description}</span>
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
