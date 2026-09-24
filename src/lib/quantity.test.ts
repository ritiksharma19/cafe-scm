import { describe, expect, it } from "vitest";
import { formatQuantity, toBaseQuantity } from "./quantity";

const kg = { code: "kg", factor_to_base: "1000.000000" };
const pcs = { code: "pcs", factor_to_base: 1 };

describe("quantity helpers", () => {
  it("formats base quantities in the display unit", () => {
    expect(formatQuantity("2500.000", kg)).toBe("2.5 kg");
    expect(formatQuantity("12.000", pcs)).toBe("12 pcs");
    expect(formatQuantity("-3.000", pcs)).toBe("-3 pcs");
  });

  it("converts entered quantities to base without float noise", () => {
    expect(toBaseQuantity(0.1 + 0.2, kg)).toBe(300);
    expect(toBaseQuantity(1.2345, kg)).toBe(1234.5);
  });
});
