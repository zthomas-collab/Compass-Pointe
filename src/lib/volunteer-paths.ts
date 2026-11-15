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

export function donatePath(type?: OfferType): string {
  return type ? `${VOLUNTEER_PATHS.donate}?type=${type}` : VOLUNTEER_PATHS.donate;
}
