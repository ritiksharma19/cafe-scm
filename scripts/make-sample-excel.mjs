#!/usr/bin/env node
/**
 * Writes data/sample-recipes.xlsx in the owner's layout:
 * products down column A, raw materials across row 1, quantities in the cells
 * ("20gm", "200ml", or a plain number for pieces).
 *
 *   node scripts/make-sample-excel.mjs
 */
import * as XLSX from "xlsx";
import * as fs from "node:fs";

XLSX.set_fs(fs);

const materials = [
  "Burger Bun", "Veg Patty", "Cheese Slice", "Mayonnaise", "Lettuce", "Tomato", "Onion",
  "Paratha", "Paneer", "Green Chutney", "Frozen Fries", "Peri Peri Masala", "Tomato Ketchup",
  "Cooking Oil", "Milk", "Vanilla Ice Cream", "Chocolate Syrup", "Sugar", "Ice",
  "Mint Leaves", "Lemon", "Sugar Syrup", "Soda",
];

/** @type {Record<string, Record<string, string | number>>} */
const recipes = {
  Burger: {
    "Burger Bun": 1, "Veg Patty": 1, "Cheese Slice": 1, Mayonnaise: "20gm", Lettuce: "15gm",
    Tomato: "20gm", Onion: "15gm", "Cooking Oil": "10ml",
  },
  Roll: {
    Paratha: 1, Paneer: "80gm", Onion: "25gm", Mayonnaise: "15gm", "Green Chutney": "15gm",
    "Cooking Oil": "15ml",
  },
  Fries: {
    "Frozen Fries": "150gm", "Peri Peri Masala": "5gm", "Tomato Ketchup": "20gm", "Cooking Oil": "25ml",
  },
  Shake: {
    Milk: "200ml", "Vanilla Ice Cream": "60gm", "Chocolate Syrup": "30ml", Sugar: "15gm", Ice: "50gm",
  },
  Mojito: {
    "Mint Leaves": "5gm", Lemon: 0.5, "Sugar Syrup": "30ml", Soda: "200ml", Ice: "80gm",
  },
};

const rows = [["Product", ...materials]];
for (const [product, items] of Object.entries(recipes)) {
  rows.push([product, ...materials.map((m) => items[m] ?? "")]);
}

const ws = XLSX.utils.aoa_to_sheet(rows);
ws["!cols"] = [{ wch: 12 }, ...materials.map((m) => ({ wch: Math.max(8, m.length + 1) }))];
ws["!freeze"] = { xSplit: 1, ySplit: 1 };
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, "Recipes");

fs.mkdirSync("data", { recursive: true });
XLSX.writeFile(wb, "data/sample-recipes.xlsx");
console.log(`Wrote data/sample-recipes.xlsx (${Object.keys(recipes).length} products × ${materials.length} raw materials)`);
