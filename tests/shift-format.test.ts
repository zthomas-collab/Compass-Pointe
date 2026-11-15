import { describe, expect, it } from "vitest";
import { formatShift } from "@/lib/shift";

// Intl may use a narrow no-break space before AM/PM; compare with ordinary spaces.
const plain = (s: string | null) => (s === null ? null : s.replace(/\s/g, " "));

describe("formatShift", () => {
  const start = "2026-11-20T14:00:00.000Z"; // 9:00 AM Eastern
  const end = "2026-11-20T18:00:00.000Z"; // 1:00 PM Eastern

  it("shows a full shift in Eastern Time", () => {
    expect(plain(formatShift(start, end))).toBe("Nov 20, 2026, 9:00 AM to Nov 20, 2026, 1:00 PM (Eastern Time)");
  });

  it("never leaves a dangling 'to' when only one end is known", () => {
    expect(plain(formatShift(start, null))).toBe("Starts Nov 20, 2026, 9:00 AM (Eastern Time)");
    expect(plain(formatShift(null, end))).toBe("Ends Nov 20, 2026, 1:00 PM (Eastern Time)");
  });

  it("returns null when there is no shift time", () => {
    expect(formatShift(null, null)).toBeNull();
  });
});
