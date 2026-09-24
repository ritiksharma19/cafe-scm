import type { ExistingCatalog } from "@/lib/import-preview";
import { createClient } from "@/lib/supabase/server";
import { ImportScreen } from "./ImportScreen";

export const metadata = { title: "Import recipes" };

interface ProductRow {
  name: string;
  selling_price: string;
  product_recipes: { recipe_items: { quantity: string; material: { name: string } | null }[] }[];
}

export default async function ImportPage() {
  const supabase = await createClient();
  const [{ data: materials }, { data: products }] = await Promise.all([
    supabase.from("raw_materials").select("name, base_unit").returns<{ name: string; base_unit: string }[]>(),
    supabase
      .from("products")
      .select("name, selling_price, product_recipes(recipe_items(quantity, material:raw_materials(name)))")
      .is("product_recipes.effective_to", null)
      .returns<ProductRow[]>(),
  ]);

  const existing: ExistingCatalog = {
    materials: materials ?? [],
    products: (products ?? []).map((p) => ({
      name: p.name,
      selling_price: Number(p.selling_price),
      recipe: p.product_recipes[0]
        ? p.product_recipes[0].recipe_items.map((i) => ({ material: i.material?.name ?? "?", quantity: Number(i.quantity) }))
        : null,
    })),
  };

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-2xl font-bold">Import recipes from Excel</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          One row per product, one column per raw material, quantities in the cells (<code>20gm</code>, <code>200ml</code>, or a
          plain number for pieces). An optional <b>Price</b> column sets selling prices. You will see exactly what changes
          before anything is saved, and the import is all-or-nothing.
        </p>
        <p className="mt-2 text-sm">
          <a href="/admin/export/recipes?format=xlsx" download className="font-semibold text-brand underline">
            Download the current recipes
          </a>{" "}
          in this format to edit and re-import.
        </p>
      </div>
      <ImportScreen existing={existing} />
    </div>
  );
}
