import { afterEach, describe, expect, it, vi } from "vitest";
import { actionErrorState } from "@/server/action-state";
import { AppError } from "@/server/errors";

/** The one way server actions turn a thrown error into form state (was copied into eleven action files). */
describe("actionErrorState", () => {
  afterEach(() => vi.restoreAllMocks());

  it("passes an AppError's message and field errors to the form, without logging", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const err = new AppError("VALIDATION", "Please correct the highlighted fields.", { siteId: ["Choose a location"] });
    expect(actionErrorState(err, "projects")).toEqual({
      error: "Please correct the highlighted fields.", fieldErrors: { siteId: ["Choose a location"] },
    });
    expect(log).not.toHaveBeenCalled();
  });

  it("hides any other error behind a generic message and logs it with the action tag", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(actionErrorState(new Error("connection reset"), "events")).toEqual({ error: "Something went wrong. Please try again." });
    expect(log).toHaveBeenCalledWith(JSON.stringify({ level: "error", action: "events", message: "connection reset" }));
  });
});
