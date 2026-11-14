import { OFFER_TYPE_LABELS, type OfferType } from "@/server/modules/offers";
import { PROJECT_STATUS_LABELS, type NeedTotals, type Priority, type ProjectStatus } from "@/server/modules/projects";

export function ProgressBar({ percent, label }: { percent: number; label: string }) {
  return (
    <div>
      <div role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label={label} className="h-3 w-full overflow-hidden rounded-full bg-neutral-bg">
        <div className="h-full bg-brand" style={{ width: `${percent}%` }} />
      </div>
      <p className="mt-1 text-xs text-muted">{percent}% verified</p>
    </div>
  );
}

const PRIORITY_TONE: Record<Priority, string> = { LOW: "tone-muted", NORMAL: "tone-brand", HIGH: "tone-warn", CRITICAL: "tone-bad" };
export const PriorityBadge = ({ priority }: { priority: Priority }) => <span className={`badge ${PRIORITY_TONE[priority]}`}>{priority.charAt(0) + priority.slice(1).toLowerCase()} priority</span>;
export const ProjectStatusBadge = ({ status }: { status: ProjectStatus }) => (
  <span className={`badge ${status === "ACTIVE" ? "tone-ok" : status === "COMPLETED" ? "tone-brand" : status === "CANCELED" ? "tone-muted" : "tone-warn"}`}>{PROJECT_STATUS_LABELS[status]}</span>
);
export const typeLabel = (t: OfferType) => OFFER_TYPE_LABELS[t];

/** The six quantities side by side. Verified is the number that counts toward completion. */
export function NeedTable({ needs }: { needs: NeedTotals[] }) {
  const n = (v: number) => v.toLocaleString("en-US");
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[34rem] text-sm">
        <caption className="sr-only">Quantities by resource</caption>
        <thead><tr className="border-b border-line text-left text-xs uppercase text-muted">
          <th scope="col" className="py-2 pr-2">Resource</th><th scope="col" className="px-2 text-right">Requested</th><th scope="col" className="px-2 text-right">Offered</th>
          <th scope="col" className="px-2 text-right">Accepted</th><th scope="col" className="px-2 text-right">Dispatched</th><th scope="col" className="px-2 text-right">Received</th>
          <th scope="col" className="pl-2 text-right">Verified</th></tr></thead>
        <tbody>
          {needs.map((x) => (
            <tr key={x.id} className="border-b border-line align-top">
              <th scope="row" className="py-2 pr-2 text-left font-semibold">{x.label} <span className="font-normal text-muted">({x.unit})</span>
                <div className="mt-1 max-w-[14rem]"><ProgressBar percent={x.percentVerified} label={`${x.label} verified`} /></div></th>
              <td className="px-2 text-right">{n(x.requested)}</td><td className="px-2 text-right">{n(x.offered)}</td><td className="px-2 text-right">{n(x.accepted)}</td>
              <td className="px-2 text-right">{n(x.dispatched)}</td><td className="px-2 text-right">{n(x.received)}</td><td className="pl-2 text-right font-semibold">{n(x.verified)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
