import { describe, expect, it } from "vitest";
import { formatINR, istDayStart } from "./format";

describe("istDayStart", () => {
  it("returns 00:00 IST (18:30 UTC the previous day)", () => {
    expect(istDayStart(new Date("2026-09-25T10:00:00Z")).toISOString()).toBe("2026-09-24T18:30:00.000Z");
  });

  it("handles times just after IST midnight", () => {
    // 00:15 IST on 26 Sep = 18:45 UTC on 25 Sep
    expect(istDayStart(new Date("2026-09-25T18:45:00Z")).toISOString()).toBe("2026-09-25T18:30:00.000Z");
  });
});

describe("formatINR", () => {
  it("formats rupees in the Indian style", () => {
    expect(formatINR(360)).toBe("₹360");
    expect(formatINR("125000.50")).toBe("₹1,25,000.50");
  });
});
