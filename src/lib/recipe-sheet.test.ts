import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as XLSX from "xlsx";
import { formatQuantityCell, parseQuantityCell, parseRecipeSheet } from "./recipe-sheet";

describe("parseQuantityCell", () => {
  it("reads suffixed and plain quantities into base units", () => {
    expect(parseQuantityCell("20gm")).toMatchObject({ quantity: 20, baseUnit: "g", enteredUnit: "g" });
    expect(parseQuantityCell("1.5 kg")).toMatchObject({ quantity: 1500, baseUnit: "g", enteredUnit: "kg" });
    expect(parseQuantityCell("200ml")).toMatchObject({ quantity: 200, baseUnit: "ml" });
    expect(parseQuantityCell("0.25 L")).toMatchObject({ quantity: 250, baseUnit: "ml", enteredUnit: "l" });
    expect(parseQuantityCell(1)).toMatchObject({ quantity: 1, baseUnit: "pcs" });
    expect(parseQuantityCell("2 pcs")).toMatchObject({ quantity: 2, baseUnit: "pcs" });
    expect(parseQuantityCell(0.5)).toMatchObject({ quantity: 0.5, baseUnit: "pcs" });
  });

  it("treats blanks and zero as unused", () => {
    expect(parseQuantityCell("")).toBeNull();
    expect(parseQuantityCell(undefined)).toBeNull();
    expect(parseQuantityCell("0gm")).toBeNull();
  });

  it("reports unreadable cells", () => {
    expect(parseQuantityCell("twenty")).toEqual({ error: 'cannot read "twenty"' });
    expect(parseQuantityCell("5 cups")).toEqual({ error: 'unknown unit "cups" in "5 cups"' });
  });
});

describe("parseRecipeSheet", () => {
  it("flags a material measured in different units across products", () => {
    const r = parseRecipeSheet([
      ["Product", "Sugar"],
      ["Tea", "10gm"],
      ["Juice", "10ml"],
    ]);
    expect(r.errors).toContain("Row 3 (Juice), Sugar: measured in ml but row 2 uses g.");
  });

  it("reads an optional price column and does not treat it as a material", () => {
    const r = parseRecipeSheet([
      ["Product", "Price", "Bun"],
      ["Burger", "₹1,20", 1],
      ["Tea", 15, 1],
      ["Roll", "", 1],
      ["Bad", "abc", 1],
    ]);
    expect(r.materials.map((m) => m.name)).toEqual(["Bun"]);
    expect(r.products.map((p) => p.price)).toEqual([120, 15, null, null]);
    expect(r.errors).toEqual(['Row 5 (Bad): price "abc" is not a number.']);
  });

  it("exported cells parse back to the same quantities", () => {
    for (const [qty, unit] of [
      [20, "g"],
      [2500, "g"],
      [200, "ml"],
      [0.5, "pcs"],
      [1, "pcs"],
    ] as const) {
      expect(parseQuantityCell(formatQuantityCell(qty, unit))).toMatchObject({ quantity: qty, baseUnit: unit });
    }
  });

  it("parses the sample workbook", () => {
    const wb = XLSX.read(readFileSync("data/sample-recipes.xlsx"));
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: "" });
    const r = parseRecipeSheet(rows);

    expect(r.errors).toEqual([]);
    expect(r.products.map((p) => p.name)).toEqual(["Burger", "Roll", "Fries", "Shake", "Mojito"]);
    expect(r.materials).toHaveLength(23);

    const burger = r.products[0].items;
    expect(burger.find((i) => i.material === "Burger Bun")).toMatchObject({ quantity: 1, baseUnit: "pcs" });
    expect(burger.find((i) => i.material === "Mayonnaise")).toMatchObject({ quantity: 20, baseUnit: "g" });

    const mojito = r.products[4].items;
    expect(mojito.find((i) => i.material === "Lemon")).toMatchObject({ quantity: 0.5, baseUnit: "pcs" });
    expect(mojito.find((i) => i.material === "Soda")).toMatchObject({ quantity: 200, baseUnit: "ml" });
  });
});
