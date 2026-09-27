import { describe, expect, it } from "vitest";
import { expenseCategoryLabel, formatPct, maxDiscount, paymentMethodLabel } from "./money";

describe("maxDiscount", () => {
  it("matches record_sale's rounding (₹, 2 decimals)", () => {
    expect(maxDiscount(240, 10)).toBe(24);
    expect(maxDiscount(99.99, 15)).toBe(15); // 14.9985 → 15.00
    expect(maxDiscount(120, 0)).toBe(0);
  });
});

describe("formatPct", () => {
  it("formats margins, including losses and missing values", () => {
    expect(formatPct(72.5)).toBe("72.5%");
    expect(formatPct("-127.6")).toBe("−127.6%");
    expect(formatPct(null)).toBe("—");
  });
});

describe("labels", () => {
  it("falls back to the raw value for unknown codes", () => {
    expect(paymentMethodLabel("upi")).toBe("UPI");
    expect(expenseCategoryLabel("gas_fuel")).toBe("Gas & fuel");
    expect(expenseCategoryLabel("new_thing")).toBe("new_thing");
  });
});
