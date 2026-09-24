import { describe, expect, it } from "vitest";
import { parseQty, toBase, unitChoices, type Material, type Unit } from "./units";

const units: Unit[] = [
  { code: "g", name: "Gram", base_code: "g", factor_to_base: "1" },
  { code: "kg", name: "Kilogram", base_code: "g", factor_to_base: "1000" },
  { code: "ml", name: "Millilitre", base_code: "ml", factor_to_base: "1" },
  { code: "l", name: "Litre", base_code: "ml", factor_to_base: "1000" },
  { code: "pcs", name: "Pieces", base_code: "pcs", factor_to_base: "1" },
  { code: "dozen", name: "Dozen", base_code: "pcs", factor_to_base: "12" },
];
const paneer: Material = { id: "p", name: "Paneer", base_unit: "g", display_unit: "kg", is_active: true };
const bun: Material = { id: "b", name: "Bun", base_unit: "pcs", display_unit: "pcs", is_active: true };

describe("unitChoices", () => {
  it("offers compatible units with the display unit first", () => {
    expect(unitChoices(paneer, units).map((u) => u.code)).toEqual(["kg", "g"]);
  });

  it("adds material-specific packaging", () => {
    const choices = unitChoices(bun, units, [{ material_id: "b", unit_label: "pack", factor_to_base: "6" }]);
    expect(choices.map((u) => u.code)).toEqual(["pcs", "dozen", "pack"]);
    expect(toBase(3, choices[2])).toBe(18);
  });
});

describe("toBase / parseQty", () => {
  it("converts to base units without float noise", () => {
    expect(toBase(2.5, { code: "kg", factor: 1000 })).toBe(2500);
    expect(toBase(0.1 + 0.2, { code: "l", factor: 1000 })).toBe(300);
  });

  it("parses typed quantities, accepting a decimal comma", () => {
    expect(parseQty("2,5")).toBe(2.5);
    expect(parseQty(" 10 ")).toBe(10);
    expect(parseQty("0")).toBeNull();
    expect(parseQty("abc")).toBeNull();
  });
});
