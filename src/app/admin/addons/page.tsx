import { loadCatalog } from "@/lib/catalog";
import { formatINR } from "@/lib/format";
import { formatQuantity } from "@/lib/quantity";
import { createClient } from "@/lib/supabase/server";
import { AddonEditor, type ProductOption } from "./AddonEditor";

export const metadata = { title: "Add-ons" };

interface AddonRow {
  id: string;
  name: string;
  price: string;
  is_active: boolean;
  sort_order: number;
  addon_items: { material_id: string; quantity: string; entered_unit: string | null; material: { name: string; base_unit: string; avg_unit_cost: string } | null }[];
  product_addons: { product_id: string }[];
}

export default async function AddonsPage() {
  const supabase = await createClient();
  const [{ data: addons, error }, { data: products }, catalog] = await Promise.all([
    supabase
      .from("addons")
      .select("id, name, price, is_active, sort_order, addon_items(material_id, quantity, entered_unit, material:raw_materials(name, base_unit, avg_unit_cost)), product_addons(product_id)")
      .order("sort_order")
      .order("name")
      .returns<AddonRow[]>(),
    supabase
      .from("products")
      .select("id, name, category")
      .eq("is_active", true)
      .is("variant_of", null)
      .order("sort_order")
      .order("name")
      .returns<ProductOption[]>(),
    loadCatalog(),
  ]);
  const productName = new Map((products ?? []).map((p) => [p.id, p.name]));
  const unitOf = (code: string) => catalog.units.find((u) => u.code === code) ?? { code, factor_to_base: 1 };

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-2xl font-bold">Add-ons</h1>
        <p className="mt-1 text-sm text-muted">
          Extras a customer can add to a product — extra cheese, extra shot, whipped cream. Each has its own price and ingredients, so
          stock and profit stay exact. Workers pick them on the Sell screen.
        </p>
      </div>

      <details className="card p-5" open={(addons ?? []).length === 0}>
        <summary className="cursor-pointer font-bold">+ New add-on</summary>
        <div className="mt-4">
          <AddonEditor
            addon={{ id: null, name: "", price: "", is_active: true, items: [], product_ids: [] }}
            catalog={catalog}
            products={products ?? []}
          />
        </div>
      </details>

      {error && <p className="text-danger">Could not load add-ons: {error.message}</p>}

      <div className="flex flex-col gap-3">
        {(addons ?? []).map((a) => {
          const cost = a.addon_items.reduce((s, i) => s + Number(i.quantity) * Number(i.material?.avg_unit_cost ?? 0), 0);
          const price = Number(a.price);
          return (
            <details key={a.id} className={`card ${a.is_active ? "" : "opacity-70"}`}>
              <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-4 gap-y-1 p-4">
                <span className="min-w-40 flex-1 font-bold">
                  {a.name}
                  {!a.is_active && <span className="ml-2 text-xs font-bold text-danger">OFF</span>}
                </span>
                <span className="text-sm text-muted">
                  {a.addon_items.map((i) => `${i.material?.name} ${formatQuantity(i.quantity, unitOf(i.material?.base_unit ?? "pcs"))}`).join(" · ") ||
                    "no ingredients"}
                </span>
                <span className="text-sm text-muted">
                  {a.product_addons.map((p) => productName.get(p.product_id)).filter(Boolean).join(", ") || "not offered yet"}
                </span>
                <span className="font-semibold tabular-nums">
                  {formatINR(price)}
                  {cost > 0 && price > 0 && (
                    <span className="ml-2 text-xs font-normal text-muted">
                      cost {formatINR(cost.toFixed(2))} · {Math.round(((price - cost) / price) * 100)}% margin
                    </span>
                  )}
                </span>
              </summary>
              <div className="border-t border-line p-4">
                <AddonEditor
                  addon={{
                    id: a.id,
                    name: a.name,
                    price: a.price,
                    is_active: a.is_active,
                    items: a.addon_items.map(({ material_id, quantity, entered_unit }) => ({ material_id, quantity, entered_unit })),
                    product_ids: a.product_addons.map((p) => p.product_id),
                  }}
                  catalog={catalog}
                  products={products ?? []}
                />
              </div>
            </details>
          );
        })}
      </div>
    </div>
  );
}
