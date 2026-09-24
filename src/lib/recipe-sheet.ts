/**
 * Parses the owner's recipe sheet layout:
 *
 *            | Burger Bun | Mayonnaise | Milk  | ...     ← header row: raw material names
 *   Burger   | 1          | 20gm       |       |         ← one row per product
 *   Shake    |            |            | 200ml |
 *
 * Cell values: a number (pieces) or a number with a unit suffix (gm, g, kg, ml, l, pcs…).
 * Blank cells mean the product does not use that material.
 */

export type BaseUnit = "g" | "ml" | "pcs";

export interface ParsedQuantity {
  quantity: number; // in the base unit
  baseUnit: BaseUnit;
  enteredQty: number;
  enteredUnit: string; // normalised unit code: g | kg | ml | l | pcs
}

export interface RecipeSheetItem extends ParsedQuantity {
  material: string;
}

export interface RecipeSheetProduct {
  name: string;
  row: number; // 1-based spreadsheet row, for error messages
  items: RecipeSheetItem[];
}

export interface RecipeSheetMaterial {
  name: string;
  baseUnit: BaseUnit;
}

export interface RecipeSheetResult {
  products: RecipeSheetProduct[];
  materials: RecipeSheetMaterial[];
  errors: string[];
}

const UNIT_ALIASES: Record<string, { code: string; base: BaseUnit; factor: number }> = {
  "": { code: "pcs", base: "pcs", factor: 1 },
  g: { code: "g", base: "g", factor: 1 },
  gm: { code: "g", base: "g", factor: 1 },
  gms: { code: "g", base: "g", factor: 1 },
  gram: { code: "g", base: "g", factor: 1 },
  grams: { code: "g", base: "g", factor: 1 },
  kg: { code: "kg", base: "g", factor: 1000 },
  kgs: { code: "kg", base: "g", factor: 1000 },
  ml: { code: "ml", base: "ml", factor: 1 },
  l: { code: "l", base: "ml", factor: 1000 },
  ltr: { code: "l", base: "ml", factor: 1000 },
  litre: { code: "l", base: "ml", factor: 1000 },
  liter: { code: "l", base: "ml", factor: 1000 },
  pc: { code: "pcs", base: "pcs", factor: 1 },
  pcs: { code: "pcs", base: "pcs", factor: 1 },
  nos: { code: "pcs", base: "pcs", factor: 1 },
  no: { code: "pcs", base: "pcs", factor: 1 },
};

const QTY_PATTERN = /^(\d+(?:\.\d+)?|\.\d+)\s*([a-z]*)\.?$/;

/** Parses "20gm", "1.5 kg", "200ml", "1", 0.5 → base-unit quantity. Returns null for blanks. */
export function parseQuantityCell(value: unknown): ParsedQuantity | null | { error: string } {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return { error: `invalid number ${value}` };
    return value === 0 ? null : { quantity: round3(value), baseUnit: "pcs", enteredQty: value, enteredUnit: "pcs" };
  }
  const text = String(value).trim().toLowerCase();
  if (text === "" || text === "-") return null;
  const m = QTY_PATTERN.exec(text);
  if (!m) return { error: `cannot read "${String(value).trim()}"` };
  const unit = UNIT_ALIASES[m[2]];
  if (!unit) return { error: `unknown unit "${m[2]}" in "${String(value).trim()}"` };
  const entered = Number(m[1]);
  if (entered === 0) return null;
  return { quantity: round3(entered * unit.factor), baseUnit: unit.base, enteredQty: entered, enteredUnit: unit.code };
}

/** Parses a sheet given as rows of cells (e.g. from SheetJS `sheet_to_json(ws, { header: 1 })`). */
export function parseRecipeSheet(rows: unknown[][]): RecipeSheetResult {
  const errors: string[] = [];
  const headerIndex = rows.findIndex((r) => r.slice(1).some((c) => String(c ?? "").trim() !== ""));
  if (headerIndex < 0) return { products: [], materials: [], errors: ["No header row with raw material names found."] };

  const header = rows[headerIndex];
  const columns: { index: number; name: string }[] = [];
  const seen = new Set<string>();
  for (let i = 1; i < header.length; i++) {
    const name = String(header[i] ?? "").trim().replace(/\s+/g, " ");
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) errors.push(`Raw material "${name}" appears in more than one column.`);
    seen.add(key);
    columns.push({ index: i, name });
  }

  const materialUnits = new Map<string, { name: string; baseUnit: BaseUnit; firstRow: number }>();
  const products: RecipeSheetProduct[] = [];
  const productNames = new Set<string>();

  for (let r = headerIndex + 1; r < rows.length; r++) {
    const row = rows[r] ?? [];
    const name = String(row[0] ?? "").trim().replace(/\s+/g, " ");
    const rowNo = r + 1;
    if (!name) continue;
    if (productNames.has(name.toLowerCase())) errors.push(`Row ${rowNo}: product "${name}" is listed twice.`);
    productNames.add(name.toLowerCase());

    const items: RecipeSheetItem[] = [];
    for (const col of columns) {
      const parsed = parseQuantityCell(row[col.index]);
      if (parsed === null) continue;
      if ("error" in parsed) {
        errors.push(`Row ${rowNo} (${name}), ${col.name}: ${parsed.error}.`);
        continue;
      }
      const known = materialUnits.get(col.name.toLowerCase());
      if (!known) {
        materialUnits.set(col.name.toLowerCase(), { name: col.name, baseUnit: parsed.baseUnit, firstRow: rowNo });
      } else if (known.baseUnit !== parsed.baseUnit) {
        errors.push(
          `Row ${rowNo} (${name}), ${col.name}: measured in ${parsed.baseUnit} but row ${known.firstRow} uses ${known.baseUnit}.`,
        );
        continue;
      }
      items.push({ material: col.name, ...parsed });
    }
    if (items.length === 0) errors.push(`Row ${rowNo}: product "${name}" has no ingredients.`);
    products.push({ name, row: rowNo, items });
  }

  const materials = [...materialUnits.values()].map(({ name, baseUnit }) => ({ name, baseUnit }));
  return { products, materials, errors };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
