import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { formatINR, formatTime, istDayStart } from "@/lib/format";
import { formatQuantity, type UnitInfo } from "@/lib/quantity";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Today's activity" };

interface OrderRow {
  id: string;
  occurred_at: string;
  status: "completed" | "voided";
  item_count: number;
  total_amount: string;
  order_items: { quantity: number; product: { name: string } | null }[];
}

interface MovementRow {
  id: string;
  occurred_at: string;
  qty_delta: string;
  movement_type: string;
  material: { name: string; display_unit: string } | null;
}

// Everything except sale consumption (shown as orders above).
const MOVEMENT_LABEL: Record<string, string> = {
  PURCHASE: "Received",
  PURCHASE_REVERSAL: "Receipt voided",
  WASTAGE: "Wasted",
  WASTAGE_REVERSAL: "Wastage voided",
  TRANSFER_IN: "Arrived",
  TRANSFER_OUT: "Sent",
  TRANSFER_CANCEL: "Transfer cancelled",
  COUNT_ADJUSTMENT: "Count correction",
  MANUAL_ADJUSTMENT: "Owner adjustment",
  OPENING_BALANCE: "Opening stock",
};

export default async function ActivityPage() {
  const { location } = await requireRole("worker");
  const supabase = await createClient();
  const since = istDayStart().toISOString();
  const [{ data: orders, error }, { data: movements }, { data: units }] = await Promise.all([
    supabase
      .from("orders")
      .select("id, occurred_at, status, item_count, total_amount, order_items(quantity, product:products(name))")
      .eq("location_id", location?.id ?? "")
      .gte("occurred_at", since)
      .order("occurred_at", { ascending: false })
      .limit(200)
      .returns<OrderRow[]>(),
    supabase
      .from("stock_movements")
      .select("id, occurred_at, qty_delta, movement_type, material:raw_materials(name, display_unit)")
      .eq("location_id", location?.id ?? "")
      .in("movement_type", Object.keys(MOVEMENT_LABEL))
      .gte("occurred_at", since)
      .order("occurred_at", { ascending: false })
      .limit(200)
      .returns<MovementRow[]>(),
    supabase.from("units").select("code, factor_to_base").returns<UnitInfo[]>(),
  ]);

  const unitByCode = new Map((units ?? []).map((u) => [u.code, u]));
  const completed = (orders ?? []).filter((o) => o.status === "completed");
  const sales = completed.reduce((s, o) => s + Number(o.total_amount), 0);
  const items = completed.reduce((s, o) => s + o.item_count, 0);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <h1 className="text-xl font-bold">Today&apos;s activity</h1>
        <Link href="/worker/more" className="text-sm font-semibold text-brand">
          Back
        </Link>
      </div>
      <div className="grid grid-cols-3 gap-2 text-center">
        {[
          ["Orders", completed.length],
          ["Items", items],
          ["Sales", formatINR(sales)],
        ].map(([label, value]) => (
          <div key={label} className="card px-2 py-3">
            <p className="text-lg font-bold tabular-nums">{value}</p>
            <p className="text-xs text-muted">{label}</p>
          </div>
        ))}
      </div>

      {error && <p className="text-danger">Could not load activity. Check the connection and reopen this page.</p>}

      <h2 className="mt-2 font-bold">Orders</h2>
      {!error && orders?.length === 0 && <p className="card p-4 text-muted">No orders yet today.</p>}
      {(orders?.length ?? 0) > 0 && (
        <ul className="card divide-y divide-line">
          {(orders ?? []).map((o) => (
            <li key={o.id} className={`flex items-start justify-between gap-3 px-4 py-3 ${o.status === "voided" ? "opacity-60" : ""}`}>
              <div className="min-w-0">
                <p className="font-medium">{o.order_items.map((i) => `${i.product?.name ?? "?"} × ${i.quantity}`).join(", ")}</p>
                <p className="text-xs text-muted">
                  {formatTime(o.occurred_at)}
                  {o.status === "voided" && <span className="ml-2 font-bold text-danger">VOIDED</span>}
                </p>
              </div>
              <span className={`shrink-0 font-semibold tabular-nums ${o.status === "voided" ? "line-through" : ""}`}>
                {formatINR(o.total_amount)}
              </span>
            </li>
          ))}
        </ul>
      )}

      <h2 className="mt-2 font-bold">Stock in &amp; out</h2>
      {(movements?.length ?? 0) === 0 ? (
        <p className="card p-4 text-muted">No receipts, wastage or transfers today.</p>
      ) : (
        <ul className="card divide-y divide-line">
          {(movements ?? []).map((m) => {
            const unit = unitByCode.get(m.material?.display_unit ?? "") ?? { code: m.material?.display_unit ?? "", factor_to_base: 1 };
            const positive = Number(m.qty_delta) > 0;
            return (
              <li key={m.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="font-medium">{m.material?.name}</p>
                  <p className="text-xs text-muted">
                    {formatTime(m.occurred_at)} · {MOVEMENT_LABEL[m.movement_type]}
                  </p>
                </div>
                <span className={`shrink-0 font-semibold tabular-nums ${positive ? "text-ok" : "text-danger"}`}>
                  {positive ? "+" : ""}
                  {formatQuantity(m.qty_delta, unit)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
