import { formatINR, formatTime, istDayStart } from "@/lib/format";
import { LiveRefresh } from "@/components/LiveRefresh";
import { formatQuantity, type UnitInfo } from "@/lib/quantity";
import { createClient } from "@/lib/supabase/server";
import type { Location } from "@/lib/types";
import { VoidOrderForm } from "./VoidOrderForm";

export const metadata = { title: "Orders" };

interface OrderRow {
  id: string;
  occurred_at: string;
  status: "completed" | "voided";
  item_count: number;
  total_amount: string;
  void_reason: string | null;
  location_id: string;
  worker: { full_name: string } | null;
  order_items: { id: string; quantity: number; product: { name: string } | null }[];
}

interface MovementRow {
  ref_id: string;
  qty_delta: string;
  movement_type: string;
  material: { name: string; display_unit: string } | null;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export default async function OrdersPage({ searchParams }: PageProps<"/admin/orders">) {
  const params = await searchParams;
  const dateParam = typeof params.date === "string" && DATE_PATTERN.test(params.date) ? params.date : null;
  const cartParam = typeof params.cart === "string" ? params.cart : "";
  const dayStart = dateParam ? new Date(`${dateParam}T00:00:00+05:30`) : istDayStart();
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  const dateValue = new Date(dayStart.getTime() + 330 * 60 * 1000).toISOString().slice(0, 10);

  const supabase = await createClient();
  let query = supabase
    .from("orders")
    .select(
      "id, occurred_at, status, item_count, total_amount, void_reason, location_id, worker:profiles!orders_worker_id_fkey(full_name), order_items(id, quantity, product:products(name))",
    )
    .gte("occurred_at", dayStart.toISOString())
    .lt("occurred_at", dayEnd.toISOString())
    .order("occurred_at", { ascending: false })
    .limit(150);
  if (cartParam) query = query.eq("location_id", cartParam);

  const [{ data: orders, error }, { data: locations }, { data: units }] = await Promise.all([
    query.returns<OrderRow[]>(),
    supabase.from("locations").select("id, code, name, type, sort_order, is_active").order("sort_order").returns<Location[]>(),
    supabase.from("units").select("code, factor_to_base").returns<UnitInfo[]>(),
  ]);

  const itemIds = (orders ?? []).flatMap((o) => o.order_items.map((i) => i.id));
  const { data: movements } = itemIds.length
    ? await supabase
        .from("stock_movements")
        .select("ref_id, qty_delta, movement_type, material:raw_materials(name, display_unit)")
        .eq("ref_type", "order_item")
        .in("ref_id", itemIds)
        .returns<MovementRow[]>()
    : { data: [] as MovementRow[] };

  const unitByCode = new Map((units ?? []).map((u) => [u.code, u]));
  const locationName = new Map((locations ?? []).map((l) => [l.id, l.name]));
  const movementsByItem = new Map<string, MovementRow[]>();
  for (const m of movements ?? []) {
    if (m.movement_type !== "SALE_CONSUMPTION") continue;
    movementsByItem.set(m.ref_id, [...(movementsByItem.get(m.ref_id) ?? []), m]);
  }

  const completed = (orders ?? []).filter((o) => o.status === "completed");
  const totals = {
    orders: completed.length,
    items: completed.reduce((s, o) => s + o.item_count, 0),
    sales: completed.reduce((s, o) => s + Number(o.total_amount), 0),
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3"><h1 className="text-2xl font-bold">Orders</h1><LiveRefresh tables={["orders"]} /></div>

      <form className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Date</span>
          <input type="date" name="date" defaultValue={dateValue} className="field" />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Cart</span>
          <select name="cart" defaultValue={cartParam} className="field">
            <option value="">All carts</option>
            {(locations ?? [])
              .filter((l) => l.type === "cart")
              .map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
          </select>
        </label>
        <button type="submit" className="btn btn-secondary">
          Show
        </button>
      </form>

      <div className="grid grid-cols-3 gap-3 sm:max-w-lg">
        {[
          ["Orders", totals.orders],
          ["Items sold", totals.items],
          ["Sales", formatINR(totals.sales)],
        ].map(([label, value]) => (
          <div key={label} className="card p-4">
            <p className="text-xs font-semibold uppercase text-muted">{label}</p>
            <p className="text-xl font-bold tabular-nums">{value}</p>
          </div>
        ))}
      </div>

      {error && <p className="text-danger">Could not load orders: {error.message}</p>}
      {!error && orders?.length === 0 && <p className="card p-5 text-muted">No orders for this day.</p>}

      <ul className="flex flex-col gap-2">
        {(orders ?? []).map((o) => (
          <li key={o.id} className={`card ${o.status === "voided" ? "opacity-70" : ""}`}>
            <details>
              <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-4 gap-y-1 p-4">
                <span className="w-16 font-semibold tabular-nums">{formatTime(o.occurred_at)}</span>
                <span className="w-20 text-sm text-muted">{locationName.get(o.location_id)}</span>
                <span className="min-w-0 flex-1 font-medium">
                  {o.order_items.map((i) => `${i.product?.name ?? "?"} × ${i.quantity}`).join(", ")}
                </span>
                {o.status === "voided" && (
                  <span className="rounded-full bg-danger/10 px-2 py-0.5 text-xs font-bold text-danger">VOIDED</span>
                )}
                <span className={`font-semibold tabular-nums ${o.status === "voided" ? "line-through" : ""}`}>
                  {formatINR(o.total_amount)}
                </span>
              </summary>
              <div className="grid gap-4 border-t border-line p-4 md:grid-cols-[2fr_1fr]">
                <div>
                  <p className="mb-2 text-sm text-muted">
                    Recorded by {o.worker?.full_name ?? "—"} · Ingredients deducted:
                  </p>
                  <ul className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                    {o.order_items.flatMap((i) =>
                      (movementsByItem.get(i.id) ?? []).map((m, idx) => (
                        <li key={`${i.id}-${idx}`} className="flex justify-between gap-3">
                          <span>
                            {m.material?.name} <span className="text-muted">({i.product?.name})</span>
                          </span>
                          <span className="tabular-nums">
                            {formatQuantity(
                              m.qty_delta,
                              unitByCode.get(m.material?.display_unit ?? "") ?? { code: m.material?.display_unit ?? "", factor_to_base: 1 },
                            )}
                          </span>
                        </li>
                      )),
                    )}
                  </ul>
                  {o.status === "voided" && (
                    <p className="mt-3 text-sm text-danger">Voided: {o.void_reason} — ingredients were returned to stock.</p>
                  )}
                </div>
                {o.status === "completed" && <VoidOrderForm orderId={o.id} />}
              </div>
            </details>
          </li>
        ))}
      </ul>
    </div>
  );
}
