import type { OfferType } from "./offers";

/** The Volunteer & donate section's addresses, in one place so pages, links, redirects and tests agree. */
export const VOLUNTEER_PATHS = {
  hub: "/volunteer",
  shifts: "/volunteer/projects",
  donate: "/volunteer/donate",
  thanks: "/volunteer/thanks",
} as const;

export function shiftPath(projectId: string): string {
  return `${VOLUNTEER_PATHS.shifts}/${projectId}`;
}

/** The donate page, optionally for one organization (`org`) and with what is being given preselected (`type`). */
export function donatePath(type?: OfferType, orgId?: string): string {
  const q = new URLSearchParams();
  if (orgId) q.set("org", orgId);
  if (type) q.set("type", type);
  const s = q.toString();
  return s ? `${VOLUNTEER_PATHS.donate}?${s}` : VOLUNTEER_PATHS.donate;
}
