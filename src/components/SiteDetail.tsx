"use client";

import { displayAvailability, telHref, type AvailabilityStatus, type Freshness } from "@/lib/domain";
import type { MapSite } from "@/server/modules/map";
import { DirectionsMenu } from "./DirectionsMenu";
import { fmtTime } from "./map-shared";
import { StatusPill } from "./status-icons";

/** The panel for one selected site: who runs it, hours, resources, how to get there, volunteer projects and giving. */
export function SiteDetail({ site, stale, onClose }: { site: MapSite; stale: boolean; onClose: () => void }) {
  const isPublic = site.visibility === "PUBLIC";
  return (
    <section className="card m-3 p-4" aria-labelledby="site-detail-h">
      <div className="flex items-start gap-2">
        <h2 id="site-detail-h" className="flex-1 text-lg font-bold">{site.name}</h2>
        <button className="btn btn-secondary px-3" onClick={onClose} aria-label="Close details">✕</button>
      </div>
      <div className="mt-1 flex flex-wrap gap-1">
        {site.isSynthetic && <span className="badge tone-warn">SYNTHETIC DEMO DATA — not a real resource</span>}
        {!isPublic && <span className="badge tone-warn">Restricted: {site.visibility.replaceAll("_", " ").toLowerCase()} — do not share</span>}
      </div>
      {site.imageId && (
        // eslint-disable-next-line @next/next/no-img-element -- authorized image route
        <img src={`/api/sites/${site.id}/image?v=${site.imageId}`} alt={site.imageAlt ?? ""} className="mt-2 max-h-56 w-full rounded-lg object-cover" />
      )}
      {site.serviceLabel && (
        <p className="mt-2 flex items-center gap-2 text-sm">
          <span aria-hidden className="inline-flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-[10px] font-bold text-white" style={{ background: site.serviceColor ?? "#616161" }}>{site.serviceShort}</span>
          {site.serviceLabel}
        </p>
      )}
      <p className="mt-1 text-sm">
        Operated by{" "}
        {site.orgHasProfile
          ? <a className="font-semibold underline" href={`/orgs/${site.orgId}`}>{site.orgName}</a>
          : <strong>{site.orgName}</strong>}{" "}
        <span className="badge tone-ok">Verified organization</span>
      </p>
      {(site.addressLine || site.city) && (
        <p className="mt-1 text-sm">{[site.addressLine, site.city, site.state, site.postalCode].filter(Boolean).join(", ")}</p>
      )}
      {site.hoursText && <p className="mt-1 text-sm">Hours: {site.hoursText}</p>}
      {site.description && <p className="mt-1 text-sm text-muted">{site.description}</p>}
      <p className="mt-1 text-xs text-muted">Site last confirmed {fmtTime(site.lastConfirmedAt)}{stale ? " · this view may be out of date" : ""}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {site.publicPhone && <a className="btn btn-primary" href={telHref(site.publicPhone)}>Call {site.publicPhone}</a>}
        {isPublic && <DirectionsMenu lat={site.lat} lng={site.lng} />}
      </div>
      <h3 className="mt-4 font-semibold">Resources</h3>
      <ul className="mt-1 divide-y divide-line">
        {site.resources.map((r) => {
          const d = displayAvailability(r.reportedStatus as AvailabilityStatus, r.freshness as Freshness);
          return (
            <li key={r.id} className="py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{r.name}</span>
                <span className="text-xs text-muted">{r.categoryLabel}</span>
                <StatusPill kind={d.kind} label={d.label} />
                {r.visibility !== "PUBLIC" && <span className="badge tone-warn">Restricted</span>}
              </div>
              {d.note && <div className="text-xs text-muted">{d.note}</div>}
              {r.reportedQuantity !== null && (
                <div className="text-sm">{r.reportedQuantity} {r.quantityUnit} <span className="text-xs text-muted">({r.quantityBasis === "VERIFIED_COUNT" ? "verified count" : "reported by organization"})</span></div>
              )}
              <div className="text-xs text-muted">Last confirmed {fmtTime(r.lastConfirmedAt)}</div>
            </li>
          );
        })}
        {site.resources.length === 0 && <li className="py-2 text-sm text-muted">No resources listed.</li>}
      </ul>
      <p className="mt-3 text-xs text-muted">Call ahead before traveling. Availability is reported by the organization and can change quickly.</p>
      {site.projects.length > 0 && (
        <div className="mt-4 border-t border-line pt-3">
          <h3 className="font-semibold">Volunteers needed here</h3>
          <ul className="mt-1 divide-y divide-line">
            {site.projects.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-2 py-2">
                <a className="font-medium text-brand underline" href={`/volunteer/projects/${p.id}`}>{p.title}</a>
                {p.hasUrgent && <span className="badge tone-bad"><span aria-hidden="true">!</span> Urgent</span>}
                <span className="text-sm text-muted">{p.spotsLeft > 0 ? `${p.spotsLeft} ${p.spotsLeft === 1 ? "spot" : "spots"} left` : "Full"}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {(site.orgDonationUrl || site.orgHasProfile) && (
        <div className="mt-4 border-t border-line pt-3">
          <h3 className="font-semibold">Want to support {site.orgName}?</h3>
          <div className="mt-2 flex flex-wrap gap-2">
            {site.orgDonationUrl && (
              <a className="btn btn-secondary" href={site.orgDonationUrl} target="_blank" rel="noopener noreferrer nofollow">
                Give money <span aria-hidden="true">↗</span><span className="sr-only"> to {site.orgName} on their own website (opens in a new tab)</span>
              </a>
            )}
            {site.orgHasProfile && <a className="btn btn-secondary" href={`/orgs/${site.orgId}`}>Other ways to help</a>}
          </div>
        </div>
      )}
    </section>
  );
}
