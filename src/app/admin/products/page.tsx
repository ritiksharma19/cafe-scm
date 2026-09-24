import { formatINR } from "@/lib/format";
import { formatQuantity, type UnitInfo } from "@/lib/quantity";
import { createClient } from "@/lib/supabase/server";
import { ProductForm } from "./ProductForm";

export const metadata = { title: "Products" };

interface ProductRow {
  id: string;
  name: string;
  selling_price: string;
  sort_order: number;
  is_active: boolean;
  product_recipes: {
    version: number;
    effective_to: string | null;
    recipe_items: {
      quantity: string;
      material: { name: string; display_unit: string; base_unit: string; avg_unit_cost: string } | null;
    }[];
  }[];
}

export default async function ProductsPage() {
  const supabase = await createClient();
  const [{ data: products, error }, { data: units }] = await Promise.all([
    supabase
      .from("products")
      .select(
        "id, name, selling_price, sort_order, is_active, product_recipes(version, effective_to, recipe_items(quantity, material:raw_materials(name, display_unit, base_unit, avg_unit_cost)))",
      )
      .is("product_recipes.effective_to", null)
      .order("sort_order")
      .order("name")
      .returns<ProductRow[]>(),
    supabase.from("units").select("code, factor_to_base").returns<UnitInfo[]>(),
  ]);
  const unitByCode = new Map((units ?? []).map((u) => [u.code, u]));

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-2xl font-bold">Products</h1>
        <p className="mt-1 text-sm text-muted">
          Recipes come from the recipe sheet import. Changing a recipe creates a new version; past orders keep the
          version they used.
        </p>
      </div>
      {error && <p className="text-danger">Could not load products: {error.message}</p>}

      <div className="grid gap-4 lg:grid-cols-2">
        {(products ?? []).map((p) => {
          const recipe = p.product_recipes[0];
          const lines = (recipe?.recipe_items ?? [])
            .filter((i) => i.material)
            .map((i) => ({
              name: i.material!.name,
              qty: formatQuantity(
                i.quantity,
                // Recipes read best in small units (20 g, not 0.02 kg).
                unitByCode.get(i.material!.base_unit) ?? { code: i.material!.base_unit, factor_to_base: 1 },
              ),
              cost: Number(i.quantity) * Number(i.material!.avg_unit_cost),
            }))
            .sort((a, b) => b.cost - a.cost);
          const cost = lines.reduce((s, l) => s + l.cost, 0);
          const hasCosts = lines.some((l) => l.cost > 0);
          const price = Number(p.selling_price);

          return (
            <article key={p.id} className={`card flex flex-col gap-4 p-5 ${p.is_active ? "" : "opacity-70"}`}>
              <div className="flex items-baseline justify-between gap-3">
                <h2 className="text-lg font-bold">
                  {p.name}
                  {!p.is_active && <span className="ml-2 text-xs font-bold text-danger">INACTIVE</span>}
                </h2>
                <span className="text-sm text-muted">{recipe ? `Recipe v${recipe.version}` : "No recipe"}</span>
              </div>

              {lines.length > 0 && (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase text-muted">
                      <th className="pb-1 font-semibold">Ingredient</th>
                      <th className="pb-1 text-right font-semibold">Qty</th>
                      <th className="pb-1 text-right font-semibold">Est. cost</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {lines.map((l) => (
                      <tr key={l.name}>
                        <td className="py-1.5">{l.name}</td>
                        <td className="py-1.5 text-right tabular-nums">{l.qty}</td>
                        <td className="py-1.5 text-right tabular-nums">{hasCosts ? formatINR(l.cost.toFixed(2)) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              <dl className="grid grid-cols-3 gap-2 rounded-xl bg-bg p-3 text-sm">
                <div>
                  <dt className="text-xs text-muted">Selling price</dt>
                  <dd className="font-bold tabular-nums">{formatINR(price)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">Est. ingredient cost</dt>
                  <dd className="font-bold tabular-nums">{hasCosts ? formatINR(cost.toFixed(2)) : "No costs yet"}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">Est. gross margin before other expenses</dt>
                  <dd className="font-bold tabular-nums">
                    {hasCosts && price > 0 ? `${formatINR((price - cost).toFixed(2))} (${Math.round(((price - cost) / price) * 100)}%)` : "—"}
                  </dd>
                </div>
              </dl>

              <ProductForm id={p.id} price={p.selling_price} sortOrder={p.sort_order} active={p.is_active} />
            </article>
          );
        })}
      </div>
      <p className="text-xs text-muted">
        Costs use each material&apos;s weighted-average purchase cost. They fill in automatically once purchases are
        recorded (Phase 3).
      </p>
    </div>
  );
}
