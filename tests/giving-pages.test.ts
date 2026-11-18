import { describe, expect, it } from "vitest";
import { donateViewFor } from "@/lib/offers";
import { donatePath } from "@/lib/volunteer-paths";

/** Address rules for giving to a chosen organization (pure functions shared by the donate page and its links). */

const ORG = "6f0c7a8e-2b1d-4c3e-9f00-1a2b3c4d5e6f";

describe("donate addresses", () => {
  it("donatePath carries the organization and the type", () => {
    expect(donatePath()).toBe("/volunteer/donate");
    expect(donatePath("FOOD")).toBe("/volunteer/donate?type=FOOD");
    expect(donatePath(undefined, ORG)).toBe(`/volunteer/donate?org=${ORG}`);
    expect(donatePath("FOOD", ORG)).toBe(`/volunteer/donate?org=${ORG}&type=FOOD`);
  });
});

describe("donate view with an organization's accepted types", () => {
  it("giveTarget filters types: an accepted type opens the form", () => {
    expect(donateViewFor("FOOD", ["FOOD", "DRINKING_WATER"])).toEqual({ mode: "form", type: "FOOD" });
  });

  it("an unaccepted or missing type shows the chooser, never the form", () => {
    expect(donateViewFor("EQUIPMENT", ["FOOD"])).toEqual({ mode: "chooser" });
    expect(donateViewFor(undefined, ["FOOD"])).toEqual({ mode: "chooser" });
    expect(donateViewFor(["FOOD", "FOOD"], ["FOOD"])).toEqual({ mode: "chooser" });
  });

  it("without a list every valid type is allowed, as before", () => {
    expect(donateViewFor("EQUIPMENT")).toEqual({ mode: "form", type: "EQUIPMENT" });
  });
});
