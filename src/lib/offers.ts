/**
 * Client-safe constants for volunteer and donation offers (no server imports): shared by the offer service, the donate
 * pages, the form and the tests. The service re-exports them, so its other importers are unaffected.
 */
export const OFFER_TYPES = [
  "VOLUNTEER_LABOR", "PROFESSIONAL_SKILLS", "EQUIPMENT", "TRANSPORTATION", "DRINKING_WATER", "FOOD",
  "BUILDING_SUPPLIES", "CLEANING_SUPPLIES", "STORAGE_SPACE", "OTHER",
] as const;
export type OfferType = (typeof OFFER_TYPES)[number];

export const OFFER_TYPE_LABELS: Record<OfferType, string> = {
  VOLUNTEER_LABOR: "Volunteer labor",
  PROFESSIONAL_SKILLS: "Professional skills",
  EQUIPMENT: "Equipment",
  TRANSPORTATION: "Transportation",
  DRINKING_WATER: "Drinking water",
  FOOD: "Food",
  BUILDING_SUPPLIES: "Building supplies",
  CLEANING_SUPPLIES: "Cleaning supplies",
  STORAGE_SPACE: "Storage or staging space",
  OTHER: "Something else",
};

export type OfferTypeInfo = {
  /** One plain sentence on what counts, shown on the chooser card. */
  description: string;
  /** Hint under "Quantity or capacity" for this type. */
  quantityHint: string;
  /** Hint under "Unit" for this type. */
  unitHint: string;
  /** True when a real, signed-up shift is the better way to help than a general offer. */
  steerToShifts: boolean;
  /** Decorative symbol for the chooser card (always rendered aria-hidden). */
  glyph: string;
};

export const OFFER_TYPE_INFO: Record<OfferType, OfferTypeInfo> = {
  VOLUNTEER_LABOR: {
    description: "Your time and hands: cleanup, hauling, rebuilding, meals, sorting donations.",
    quantityHint: "How many people can come, for example 6.",
    unitHint: "people, crews, hours…",
    steerToShifts: true,
    glyph: "🙌",
  },
  PROFESSIONAL_SKILLS: {
    description: "A trade or profession: electrician, roofer, nurse, counselor, translator, driver, case worker.",
    quantityHint: "How many people with this skill, for example 2.",
    unitHint: "people, hours per week…",
    steerToShifts: true,
    glyph: "🛠️",
  },
  EQUIPMENT: {
    description: "Machines and tools: generators, chainsaws, pumps, trailers, dehumidifiers, a lift.",
    quantityHint: "How many pieces you can lend or give, for example 3.",
    unitHint: "units, trailers, pumps…",
    steerToShifts: false,
    glyph: "⚙️",
  },
  TRANSPORTATION: {
    description: "Rides and hauling: moving supplies, delivering to a site, driving people to services.",
    quantityHint: "How many trips or vehicles you can offer, for example 4.",
    unitHint: "trips, trucks, vans…",
    steerToShifts: false,
    glyph: "🚚",
  },
  DRINKING_WATER: {
    description: "Bottled or bulk drinking water, sealed and safe to hand out.",
    quantityHint: "How much water you can provide, for example 200.",
    unitHint: "cases, gallons, pallets…",
    steerToShifts: false,
    glyph: "💧",
  },
  FOOD: {
    description: "Shelf-stable food, baby food and pet food, or prepared meals from a licensed kitchen.",
    quantityHint: "How much food you can provide, for example 80.",
    unitHint: "meals, boxes, pallets…",
    steerToShifts: false,
    glyph: "🥫",
  },
  BUILDING_SUPPLIES: {
    description: "Lumber, tarps, tools, drywall, roofing and similar materials for repairs.",
    quantityHint: "How much material you can provide, for example 40.",
    unitHint: "tarps, sheets, bundles, pallets…",
    steerToShifts: false,
    glyph: "🧱",
  },
  CLEANING_SUPPLIES: {
    description: "Buckets, bleach-free cleaners, gloves, masks, mops, trash bags and hygiene kits.",
    quantityHint: "How many kits or items you can provide, for example 100.",
    unitHint: "kits, cases, buckets…",
    steerToShifts: false,
    glyph: "🧽",
  },
  STORAGE_SPACE: {
    description: "A warehouse, lot, garage or hall that can store or stage supplies, or host a distribution.",
    quantityHint: "How much room you have, for example 2,000.",
    unitHint: "square feet, pallet spaces, bays…",
    steerToShifts: false,
    glyph: "🏭",
  },
  OTHER: {
    description: "Anything else you think could help. Tell us what it is and a coordinator will decide where it fits.",
    quantityHint: "How many, if it can be counted.",
    unitHint: "items, hours, loads…",
    steerToShifts: false,
    glyph: "✨",
  },
};

export type DonateView = { mode: "chooser" } | { mode: "form"; type: OfferType };

/**
 * What /volunteer/donate shows for its `?type=` address value: the form when it is exactly one valid code, otherwise the
 * chooser (an unknown, repeated or empty value is never an error and never a wrong preselection).
 */
export function donateViewFor(raw: string | string[] | undefined): DonateView {
  const type = parseOfferType(raw);
  return type ? { mode: "form", type } : { mode: "chooser" };
}

/** An offer type from an address or form, accepted only when it is exactly one code (never an array, case variant or padded string). */
export function parseOfferType(value: unknown): OfferType | null {
  return typeof value === "string" && (OFFER_TYPES as readonly string[]).includes(value) ? (value as OfferType) : null;
}
