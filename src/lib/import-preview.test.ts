import { describe, expect, it } from "vitest";
import { previewImport } from "./import-preview";
import { parseRecipeSheet } from "./recipe-sheet";

const sheet = parseRecipeSheet([
  ["Product", "Price", "Bun", "Patty", "Mayo", "Milk"],
  ["Burger", 130, 1, 2, "20gm", ""],
  ["Shake", "", "", "", "", "200ml"],
  ["Tea", 20, "", "", "", "100ml"],
]);

describe("previewImport", () => {
  it("classifies materials and products and lists recipe changes", () => {
    const p = previewImport(sheet, {
      materials: [
        { name: "Bun", base_unit: "pcs" },
        { name: "patty", base_unit: "pcs" },
        { name: "Milk", base_unit: "ml" },
        { name: "Cheese", base_unit: "pcs" },
      ],
      products: [
        {
          name: "Burger",
          selling_price: 120,
          recipe: [
            { material: "Bun", quantity: 1 },
            { material: "Patty", quantity: 1 },
            { material: "Cheese", quantity: 1 },
          ],
        },
        { name: "Shake", selling_price: 110, recipe: [{ material: "Milk", quantity: 200 }] },
      ],
    });

    expect(p.materials.map((m) => [m.name, m.status])).toEqual([
      ["Bun", "existing"],
      ["Patty", "existing"],
      ["Mayo", "new"],
      ["Milk", "existing"],
    ]);
    const burger = p.products.find((x) => x.name === "Burger")!;
    expect(burger.status).toBe("changed");
    expect(burger.price).toEqual({ from: 120, to: 130 });
    expect(burger.changes).toEqual([
      { material: "Patty", from: 1, to: 2, baseUnit: "pcs" },
      { material: "Mayo", from: null, to: 20, baseUnit: "g" },
      { material: "Cheese", from: 1, to: null, baseUnit: "pcs" },
    ]);
    expect(p.products.find((x) => x.name === "Shake")).toMatchObject({ status: "unchanged", price: null });
    expect(p.products.find((x) => x.name === "Tea")).toMatchObject({ status: "new", price: { from: null, to: 20 } });
    expect(p.counts).toEqual({ newMaterials: 1, newProducts: 1, changedRecipes: 1, unchanged: 1, priceChanges: 1 });
    expect(p.blocking).toEqual([]);
    expect(p.payload.products[0]).toMatchObject({ name: "Burger", selling_price: 130 });
  });

  it("blocks when a material's unit conflicts with the app", () => {
    const p = previewImport(sheet, { materials: [{ name: "Mayo", base_unit: "ml" }], products: [] });
    expect(p.blocking).toEqual(['"Mayo" is measured in ml in the app but g in the sheet.']);
    expect(p.materials.find((m) => m.name === "Mayo")!.status).toBe("unit_conflict");
  });
});
