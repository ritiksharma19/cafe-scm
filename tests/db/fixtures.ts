import { readFileSync } from "node:fs";
import * as XLSX from "xlsx";
import { parseRecipeSheet } from "@/lib/recipe-sheet";
import type { Tx } from "./harness";

/** data/sample-recipes.xlsx in the shape import_recipe_sheet() expects. */
export function sampleSheet() {
  const wb = XLSX.read(readFileSync("data/sample-recipes.xlsx"));
  const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: "" });
  const parsed = parseRecipeSheet(rows);
  return {
    materials: parsed.materials.map((m) => ({ name: m.name, base_unit: m.baseUnit })),
    products: parsed.products.map((p) => ({
      name: p.name,
      items: p.items.map((i) => ({
        material: i.material,
        quantity: i.quantity,
        entered_qty: i.enteredQty,
        entered_unit: i.enteredUnit,
      })),
    })),
  };
}

/** Switches the signed-in user inside an open test transaction. */
export async function actAs(tx: Tx, userId: string): Promise<void> {
  await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId })]);
}

export async function idsByName(tx: Tx, table: "products" | "raw_materials"): Promise<Record<string, string>> {
  const r = await tx.query<{ id: string; name: string }>(`select id, name from public.${table}`);
  return Object.fromEntries(r.rows.map((x) => [x.name, x.id]));
}
