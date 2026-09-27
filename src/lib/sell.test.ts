import { describe, expect, it } from "vitest";
import { addLine, addonsFor, changeLine, groupMenu, lineKey, sizeLabel, toSaleItems, unitPrice, type MenuAddon, type MenuProduct } from "./sell";

const p = (id: string, price: number, extra: Partial<MenuProduct> = {}): MenuProduct => ({
  id,
  name: id,
  category: null,
  selling_price: String(price),
  variant_of: null,
  variant_label: null,
  ...extra,
});

const shake = p("shake", 110);
const shakeL = p("shakeL", 150, { variant_of: "shake", variant_label: "Large" });
const burger = p("burger", 120);
const orphan = p("rollXL", 140, { variant_of: "roll", variant_label: "XL" }); // main product not on sale
const cheese: MenuAddon = { id: "cheese", name: "Extra cheese", price: "20", productIds: ["burger", "shake"] };
const mayo: MenuAddon = { id: "mayo", name: "Extra mayo", price: "10", productIds: ["burger"] };

describe("groupMenu", () => {
  it("puts sizes on their main product's tile; a size without its main product stands alone", () => {
    const g = groupMenu([shake, burger, shakeL, orphan]);
    expect(g.map((x) => [x.key, x.options.map((o) => o.id)])).toEqual([
      ["shake", ["shake", "shakeL"]],
      ["burger", ["burger"]],
      ["rollXL", ["rollXL"]],
    ]);
    expect(sizeLabel(shake, g[0])).toBe("Regular");
    expect(sizeLabel(shakeL, g[0])).toBe("Large");
  });
});

describe("add-ons and lines", () => {
  it("a size offers its main product's add-ons", () => {
    expect(addonsFor(shakeL, [cheese, mayo]).map((a) => a.id)).toEqual(["cheese"]);
    expect(addonsFor(burger, [cheese, mayo]).map((a) => a.id)).toEqual(["cheese", "mayo"]);
  });

  it("merges identical lines only, prices add-ons per unit, and builds record_sale items", () => {
    let lines = addLine([], "burger", {}, 1);
    lines = addLine(lines, "burger", { cheese: 1, mayo: 0 }, 2);
    lines = addLine(lines, "burger", { cheese: 1 }, 1);
    expect(lines.map((l) => [l.key, l.qty])).toEqual([
      ["burger", 1],
      ["burger|cheesex1", 3],
    ]);
    expect(lineKey("b", { z: 1, a: 2 })).toBe("b|ax2|zx1");
    const prices = unitPrice(lines[1], new Map([["burger", burger]]), new Map([["cheese", cheese]]));
    expect(prices).toBe(140);
    expect(toSaleItems(lines)).toEqual([
      { product_id: "burger", quantity: 1, addons: [] },
      { product_id: "burger", quantity: 3, addons: [{ addon_id: "cheese", quantity: 1 }] },
    ]);
    expect(changeLine(lines, "burger", -1).map((l) => l.key)).toEqual(["burger|cheesex1"]);
  });
});
