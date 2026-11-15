import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";
import { OFFER_TYPES, OFFER_TYPE_INFO, OFFER_TYPE_LABELS, parseOfferType } from "@/lib/offers";
import { VOLUNTEER_PATHS, donatePath, shiftPath } from "@/lib/volunteer-paths";
import { OFFER_TYPES as SERVER_OFFER_TYPES } from "@/server/modules/offers";

const TEN = [
  "VOLUNTEER_LABOR", "PROFESSIONAL_SKILLS", "EQUIPMENT", "TRANSPORTATION", "DRINKING_WATER", "FOOD",
  "BUILDING_SUPPLIES", "CLEANING_SUPPLIES", "STORAGE_SPACE", "OTHER",
] as const;

describe("offer types", () => {
  it("keeps all ten offer types, in order, with labels and info", () => {
    expect([...OFFER_TYPES]).toEqual([...TEN]);
    expect([...SERVER_OFFER_TYPES]).toEqual([...TEN]);
    for (const code of TEN) {
      expect(OFFER_TYPE_LABELS[code].length).toBeGreaterThan(2);
      expect(OFFER_TYPE_INFO[code].description.length).toBeGreaterThanOrEqual(20);
    }
    const steered = TEN.filter((c) => OFFER_TYPE_INFO[c].steerToShifts);
    expect(steered).toEqual(["VOLUNTEER_LABOR", "PROFESSIONAL_SKILLS"]);
  });

  it("parses an offer type only when it exactly matches a code", () => {
    for (const code of TEN) expect(parseOfferType(code)).toBe(code);
    for (const bad of ["food", "", " FOOD", "FOOD,FOOD", ["FOOD"], ["FOOD", "FOOD"], undefined, null, 42, "NOPE", "FOOD\n"]) {
      expect(parseOfferType(bad)).toBeNull();
    }
  });
});

describe("section paths and redirects", () => {
  it("builds section paths", () => {
    expect(shiftPath("abc")).toBe("/volunteer/projects/abc");
    expect(donatePath()).toBe("/volunteer/donate");
    expect(donatePath("FOOD")).toBe("/volunteer/donate?type=FOOD");
    expect(VOLUNTEER_PATHS).toEqual({ hub: "/volunteer", shifts: "/volunteer/projects", donate: "/volunteer/donate", thanks: "/volunteer/thanks" });
  });

  it("redirects the old project URLs permanently", async () => {
    const rules = await nextConfig.redirects!();
    expect(rules).toContainEqual({ source: "/projects", destination: "/volunteer/projects", permanent: true });
    expect(rules).toContainEqual({ source: "/projects/:id", destination: "/volunteer/projects/:id", permanent: true });
    expect(rules).toContainEqual({ source: "/black-book", destination: "/contacts", permanent: true });
  });
});
