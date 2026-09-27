import { requireRole } from "@/lib/auth";
import { istDayStart } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { SellScreen, type SellAddon, type SellProduct } from "./SellScreen";

export const metadata = { title: "Sell" };

export default async function SellPage() {
  const { location } = await requireRole("worker");
  const supabase = await createClient();

  const [{ data: products, error }, { data: today }, { data: settings }, { data: addons }] = await Promise.all([
    // Only active products that have a current recipe can be sold.
    supabase
      .from("products")
      .select("id, name, category, selling_price, color, sort_order, variant_of, variant_label, product_recipes!inner(id)")
      .eq("is_active", true)
      .is("product_recipes.effective_to", null)
      .order("sort_order")
      .order("selling_price")
      .order("name")
      .returns<(SellProduct & { product_recipes: unknown })[]>(),
    supabase
      .from("orders")
      .select("total_amount")
      .eq("location_id", location?.id ?? "")
      .eq("status", "completed")
      .gte("occurred_at", istDayStart().toISOString())
      .returns<{ total_amount: string }[]>(),
    supabase.from("app_settings").select("worker_discount_limit_pct").maybeSingle<{ worker_discount_limit_pct: number }>(),
    supabase
      .from("addons")
      .select("id, name, price, product_addons(product_id)")
      .eq("is_active", true)
      .order("sort_order")
      .order("name")
      .returns<{ id: string; name: string; price: string; product_addons: { product_id: string }[] }[]>(),
  ]);

  if (error) {
    return <p className="card p-5 text-danger">Could not load products. Check the connection and reopen this tab.</p>;
  }
  if (!products?.length) {
    return <p className="card p-5 text-muted">No products are set up yet. Ask the owner to add products and recipes.</p>;
  }

  return (
    <SellScreen
      products={products.map(({ id, name, category, selling_price, color, sort_order, variant_of, variant_label }) => ({
        id,
        name,
        category,
        selling_price,
        color,
        sort_order,
        variant_of,
        variant_label,
      }))}
      addons={(addons ?? []).map(
        (a): SellAddon => ({ id: a.id, name: a.name, price: a.price, productIds: a.product_addons.map((p) => p.product_id) }),
      )}
      todayOrders={today?.length ?? 0}
      todaySales={(today ?? []).reduce((sum, o) => sum + Number(o.total_amount), 0)}
      discountLimitPct={settings?.worker_discount_limit_pct ?? 0}
    />
  );
}
