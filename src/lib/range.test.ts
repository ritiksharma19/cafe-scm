import { describe, expect, it } from "vitest";
import { rangeQuery, resolveRange } from "./range";

const now = new Date("2026-09-27T10:00:00Z"); // 15:30 IST, 27 Sep

describe("resolveRange", () => {
  it("today is 00:00–24:00 IST", () => {
    const r = resolveRange({}, now);
    expect(r.from.toISOString()).toBe("2026-09-26T18:30:00.000Z");
    expect(r.to.toISOString()).toBe("2026-09-27T18:30:00.000Z");
    expect(r).toMatchObject({ fromDate: "2026-09-27", toDate: "2026-09-27", days: 1 });
  });

  it("last 7 days includes today", () => {
    expect(resolveRange({ range: "7d" }, now)).toMatchObject({ fromDate: "2026-09-21", toDate: "2026-09-27", days: 7 });
  });

  it("yesterday", () => {
    expect(resolveRange({ range: "yesterday" }, now)).toMatchObject({ fromDate: "2026-09-26", toDate: "2026-09-26", days: 1 });
  });

  it("custom dates are inclusive; invalid ones fall back", () => {
    expect(resolveRange({ from: "2026-09-01", to: "2026-09-10" }, now)).toMatchObject({ key: "custom", days: 10 });
    expect(resolveRange({ from: "2026-09-10", to: "2026-09-01" }, now).key).toBe("today");
    expect(resolveRange({ range: "bogus" }, now).key).toBe("today");
  });

  it("builds query strings that keep other filters", () => {
    expect(rangeQuery({ key: "7d" }, { location: "abc" })).toBe("?location=abc&range=7d");
    expect(rangeQuery({ key: "custom", fromDate: "2026-09-01", toDate: "2026-09-02" })).toBe("?from=2026-09-01&to=2026-09-02");
  });
});
