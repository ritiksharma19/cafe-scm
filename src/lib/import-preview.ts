import type { RecipeSheetResult } from "@/lib/recipe-sheet";

/** What the app has today, as needed to preview an import. */
export interface ExistingCatalog {
  materials: { name: string; base_unit: string }[];
  products: { name: string; selling_price: number; recipe: { material: string; quantity: number }[] | null }[];
}

export type MaterialStatus = "new" | "existing" | "unit_conflict";
export type ProductStatus = "new" | "changed" | "unchanged";

export interface IngredientChange {
  material: string;
  from: number | null; // base units; null = not in the current recipe
  to: number | null; // null = removed by the sheet
  baseUnit: string;
}

export interface ImportPreview {
  materials: { name: string; baseUnit: string; status: MaterialStatus; appUnit?: string }[];
  products: {
    name: string;
    row: number;
    status: ProductStatus;
    changes: IngredientChange[];
    price: { from: number | null; to: number } | null; // only when the price changes
  }[];
  blocking: string[]; // must be fixed before importing
  counts: { newMaterials: number; newProducts: number; changedRecipes: number; unchanged: number; priceChanges: number };
  payload: {
    materials: { name: string; base_unit: string }[];
    products: {
      name: string;
      selling_price: number | null;
      items: { material: string; quantity: number; entered_qty: number; entered_unit: string }[];
    }[];
  };
}

const key = (s: string) => s.trim().toLowerCase();

/** Compares a parsed recipe sheet with the current catalog. Nothing is written. */
export function previewImport(sheet: RecipeSheetResult, existing: ExistingCatalog): ImportPreview {
  const blocking = [...sheet.errors];
  const appMaterials = new Map(existing.materials.map((m) => [key(m.name), m]));
  const appProducts = new Map(existing.products.map((p) => [key(p.name), p]));
  const unitOf = new Map<string, string>();

  const materials = sheet.materials.map((m) => {
    unitOf.set(key(m.name), m.baseUnit);
    const app = appMaterials.get(key(m.name));
    if (!app) return { name: m.name, baseUnit: m.baseUnit, status: "new" as const };
    if (app.base_unit !== m.baseUnit) {
      blocking.push(`"${m.name}" is measured in ${app.base_unit} in the app but ${m.baseUnit} in the sheet.`);
      return { name: m.name, baseUnit: m.baseUnit, status: "unit_conflict" as const, appUnit: app.base_unit };
    }
    return { name: m.name, baseUnit: m.baseUnit, status: "existing" as const };
  });

  const products = sheet.products.map((p) => {
    const app = appProducts.get(key(p.name));
    const price = p.price !== null && (!app || app.selling_price !== p.price) ? { from: app ? app.selling_price : null, to: p.price } : null;
    if (!app || !app.recipe) {
      return {
        name: p.name,
        row: p.row,
        status: (app ? "changed" : "new") as ProductStatus,
        changes: p.items.map((i) => ({ material: i.material, from: null, to: i.quantity, baseUnit: i.baseUnit })),
        price,
      };
    }
    const current = new Map(app.recipe.map((r) => [key(r.material), r]));
    const changes: IngredientChange[] = [];
    for (const i of p.items) {
      const was = current.get(key(i.material));
      if (!was || was.quantity !== i.quantity) {
        changes.push({ material: i.material, from: was ? was.quantity : null, to: i.quantity, baseUnit: i.baseUnit });
      }
      current.delete(key(i.material));
    }
    for (const gone of current.values()) {
      const baseUnit = unitOf.get(key(gone.material)) ?? appMaterials.get(key(gone.material))?.base_unit ?? "";
      changes.push({ material: gone.material, from: gone.quantity, to: null, baseUnit });
    }
    return { name: p.name, row: p.row, status: (changes.length ? "changed" : "unchanged") as ProductStatus, changes, price };
  });

  return {
    materials,
    products,
    blocking,
    counts: {
      newMaterials: materials.filter((m) => m.status === "new").length,
      newProducts: products.filter((p) => p.status === "new").length,
      changedRecipes: products.filter((p) => p.status === "changed").length,
      unchanged: products.filter((p) => p.status === "unchanged").length,
      priceChanges: products.filter((p) => p.price !== null && p.status !== "new").length,
    },
    payload: {
      materials: sheet.materials.map((m) => ({ name: m.name, base_unit: m.baseUnit })),
      products: sheet.products.map((p) => ({
        name: p.name,
        selling_price: p.price,
        items: p.items.map((i) => ({ material: i.material, quantity: i.quantity, entered_qty: i.enteredQty, entered_unit: i.enteredUnit })),
      })),
    },
  };
}
