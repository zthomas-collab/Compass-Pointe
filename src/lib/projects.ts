/** Client-safe project constants (no server imports): shared by the service and the forms. */
export const PROJECT_AUDIENCES = ["COMMUNITY", "ORG_FACILITY", "HOUSEHOLD_GENERALIZED"] as const;
export const PROJECT_STATUSES = ["DRAFT", "PENDING_REVIEW", "OPEN", "PAUSED", "COMPLETED", "CANCELLED"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
