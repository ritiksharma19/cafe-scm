import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { formatINR, formatTime, istDayStart } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Recent activity" };

interface OrderRow {
  id: string;
  occurred_at: string;
  status: "completed" | "voided";
  item_count: number;
  total_amount: string;
  order_items: { quantity: number; product: { name: string } | null }[];
}

export default async function ActivityPage() {
  const { location } = await requireRole("worker");
  const supabase = await createClient();
  const { data: orders, error } = await supabase
    .from("orders")
    .select("id, occurred_at, status, item_count, total_amount, order_items(quantity, product:products(name))")
    .eq("location_id", location?.id ?? "")
    .gte("occurred_at", istDayStart().toISOString())
    .order("occurred_at", { ascending: false })
    .limit(200)
    .returns<OrderRow[]>();

  const completed = (orders ?? []).filter((o) => o.status === "completed");
  const sales = completed.reduce((s, o) => s + Number(o.total_amount), 0);
  const items = completed.reduce((s, o) => s + o.item_count, 0);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <h1 className="text-xl font-bold">Today&apos;s orders</h1>
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

      {error && <p className="text-danger">Could not load orders. Check the connection and reopen this page.</p>}
      {!error && orders?.length === 0 && <p className="card p-5 text-muted">No orders yet today.</p>}

      <ul className="card divide-y divide-line">
        {(orders ?? []).map((o) => (
          <li key={o.id} className={`flex items-start justify-between gap-3 px-4 py-3 ${o.status === "voided" ? "opacity-60" : ""}`}>
            <div className="min-w-0">
              <p className="font-medium">
                {o.order_items.map((i) => `${i.product?.name ?? "?"} × ${i.quantity}`).join(", ")}
              </p>
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
    </div>
  );
}
