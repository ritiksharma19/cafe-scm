import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { formatINR, formatTime, istDate, istDayStart } from "@/lib/format";
import { expenseCategoryLabel, PAYMENT_METHODS, paymentMethodLabel } from "@/lib/money";
import { formatQuantity, type UnitInfo } from "@/lib/quantity";
import { describeLine } from "@/lib/sell";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Today's activity" };

interface OrderRow {
  id: string;
  occurred_at: string;
  status: "completed" | "voided";
  item_count: number;
  total_amount: string;
  discount_amount: string;
  payment_method: string;
  order_items: { quantity: number; product: { name: string } | null; order_item_addons: { quantity: number; addon: { name: string } | null }[] }[];
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
  const [{ data: orders, error }, { data: movements }, { data: units }, { data: expenses }] = await Promise.all([
    supabase
      .from("orders")
      .select("id, occurred_at, status, item_count, total_amount, discount_amount, payment_method, order_items(quantity, product:products(name), order_item_addons(quantity, addon:addons(name)))")
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
    supabase
      .from("expenses")
      .select("id, category, amount, description, payment_method")
      .eq("location_id", location?.id ?? "")
      .eq("status", "posted")
      .eq("spent_on", istDate())
      .order("created_at", { ascending: false })
      .returns<{ id: string; category: string; amount: string; description: string | null; payment_method: string }[]>(),
  ]);

  const unitByCode = new Map((units ?? []).map((u) => [u.code, u]));
  const completed = (orders ?? []).filter((o) => o.status === "completed");
  const sales = completed.reduce((s, o) => s + Number(o.total_amount), 0);
  const items = completed.reduce((s, o) => s + o.item_count, 0);
  const byMethod = PAYMENT_METHODS.map((m) => ({
    ...m,
    amount: completed.filter((o) => o.payment_method === m.value).reduce((s, o) => s + Number(o.total_amount), 0),
    orders: completed.filter((o) => o.payment_method === m.value).length,
  })).filter((m) => m.orders > 0);
  const cashSales = byMethod.find((m) => m.value === "cash")?.amount ?? 0;
  const cashSpent = (expenses ?? []).filter((e) => e.payment_method === "cash").reduce((s, e) => s + Number(e.amount), 0);
  const discounts = completed.reduce((s, o) => s + Number(o.discount_amount), 0);

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

      <section className="card p-4">
        <h2 className="mb-2 font-bold">Money</h2>
        {byMethod.length === 0 ? (
          <p className="text-sm text-muted">No sales yet today.</p>
        ) : (
          <table className="w-full text-sm">
            <tbody className="divide-y divide-line">
              {byMethod.map((m) => (
                <tr key={m.value}>
                  <td className="py-1.5">{m.label}</td>
                  <td className="py-1.5 text-right text-muted">{m.orders} orders</td>
                  <td className="py-1.5 text-right font-semibold tabular-nums">{formatINR(m.amount)}</td>
                </tr>
              ))}
              {cashSpent > 0 && (
                <tr>
                  <td className="py-1.5">Cash spent on expenses</td>
                  <td />
                  <td className="py-1.5 text-right font-semibold tabular-nums">−{formatINR(cashSpent)}</td>
                </tr>
              )}
              <tr className="text-base font-bold">
                <td className="py-2">Cash to hand over</td>
                <td />
                <td className="py-2 text-right tabular-nums">{formatINR(cashSales - cashSpent)}</td>
              </tr>
            </tbody>
          </table>
        )}
        {discounts > 0 && <p className="mt-1 text-xs text-muted">Discounts given today: {formatINR(discounts)}</p>}
      </section>

      {(expenses?.length ?? 0) > 0 && (
        <>
          <h2 className="mt-2 font-bold">Expenses</h2>
          <ul className="card divide-y divide-line">
            {(expenses ?? []).map((e) => (
              <li key={e.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="font-medium">{expenseCategoryLabel(e.category)}</p>
                  <p className="text-xs text-muted">
                    {e.description ? `${e.description} · ` : ""}
                    {paymentMethodLabel(e.payment_method)}
                  </p>
                </div>
                <span className="shrink-0 font-semibold tabular-nums">{formatINR(e.amount)}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {error && <p className="text-danger">Could not load activity. Check the connection and reopen this page.</p>}

      <h2 className="mt-2 font-bold">Orders</h2>
      {!error && orders?.length === 0 && <p className="card p-4 text-muted">No orders yet today.</p>}
      {(orders?.length ?? 0) > 0 && (
        <ul className="card divide-y divide-line">
          {(orders ?? []).map((o) => (
            <li key={o.id} className={`flex items-start justify-between gap-3 px-4 py-3 ${o.status === "voided" ? "opacity-60" : ""}`}>
              <div className="min-w-0">
                <p className="font-medium">{o.order_items.map(describeLine).join(", ")}</p>
                <p className="text-xs text-muted">
                  {formatTime(o.occurred_at)} · {paymentMethodLabel(o.payment_method)}
                  {Number(o.discount_amount) > 0 && <> · −{formatINR(o.discount_amount)} discount</>}
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
