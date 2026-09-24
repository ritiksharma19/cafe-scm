import Link from "next/link";
import { LiveRefresh } from "@/components/LiveRefresh";
import { RangeFilter } from "@/components/RangeFilter";
import { StatusPill } from "@/components/StatusPill";
import { getDashboardSummary, getStockStatus, pctChange, type StockStatusRow } from "@/lib/analytics";
import { formatDateTime, formatINR } from "@/lib/format";
import { formatQuantity, type UnitInfo } from "@/lib/quantity";
import { resolveRange } from "@/lib/range";
import { createClient } from "@/lib/supabase/server";
import type { Location, Profile } from "@/lib/types";

export const metadata = { title: "Dashboard" };

export default async function AdminDashboard({ searchParams }: PageProps<"/admin">) {
  const range = resolveRange(await searchParams);
  const supabase = await createClient();

  const [{ data: locations }, { data: profiles }, { data: units }, { count: productCount }, summary, overall] = await Promise.all([
    supabase.from("locations").select("id, code, name, type, sort_order, is_active").eq("is_active", true).order("sort_order").returns<Location[]>(),
    supabase.from("profiles").select("id, role, location_id, is_active").returns<Pick<Profile, "id" | "role" | "location_id" | "is_active">[]>(),
    supabase.from("units").select("code, factor_to_base").returns<UnitInfo[]>(),
    supabase.from("products").select("id", { count: "exact", head: true }),
    getDashboardSummary(range.from, range.to),
    getStockStatus(null),
  ]);
  const carts = (locations ?? []).filter((l) => l.type === "cart");
  const perCart = await Promise.all(carts.map((c) => getStockStatus(c.id)));
  const cartStatus = new Map(carts.map((c, i) => [c.id, perCart[i]]));

  const unitByCode = new Map((units ?? []).map((u) => [u.code, u]));
  const qty = (r: Pick<StockStatusRow, "quantity" | "display_unit">) =>
    formatQuantity(r.quantity, unitByCode.get(r.display_unit) ?? { code: r.display_unit, factor_to_base: 1 });
  const runway = (r: StockStatusRow) =>
    r.days_left === null ? (r.avg_daily_use === null ? "not enough history" : "") : `~${Number(r.days_left)} day${Number(r.days_left) === 1 ? "" : "s"} left`;

  // ---- What needs attention -------------------------------------------------
  const attention: { href: string; text: string; tone: "danger" | "warn" }[] = [];
  for (const r of overall.filter((r) => r.status === "critical")) {
    attention.push({ href: `/admin/inventory/${r.material_id}`, text: `${r.name} — ${qty(r)} in total${runway(r) ? `, ${runway(r)}` : ""}`, tone: "danger" });
  }
  for (const c of carts) {
    const crit = (cartStatus.get(c.id) ?? []).filter((r) => r.status === "critical");
    if (crit.length) {
      attention.push({
        href: `/admin/inventory?location=${c.id}`,
        text: `${c.name}: ${crit.map((r) => r.name).slice(0, 4).join(", ")}${crit.length > 4 ? ` +${crit.length - 4}` : ""} critical`,
        tone: "danger",
      });
    }
  }
  if (summary.pending_requests > 0)
    attention.push({ href: "/admin/requests", text: `${summary.pending_requests} stock request${summary.pending_requests === 1 ? "" : "s"} waiting`, tone: "warn" });
  if (summary.counts_to_review > 0)
    attention.push({ href: "/admin/counts", text: `${summary.counts_to_review} stock count${summary.counts_to_review === 1 ? "" : "s"} to approve (inventory variance)`, tone: "warn" });
  if (summary.stale_in_transit > 0 && summary.oldest_in_transit)
    attention.push({
      href: "/admin/transfers",
      text: `${summary.stale_in_transit} transfer(s) not received for over 6 hours (oldest sent ${formatDateTime(summary.oldest_in_transit)})`,
      tone: "warn",
    });

  const cur = summary.current;
  const prev = summary.previous;
  const kpis: { label: string; value: string; delta: string | null; href?: string }[] = [
    { label: "Orders", value: String(cur.orders), delta: pctChange(cur.orders, prev.orders), href: "/admin/orders" },
    { label: "Items sold", value: String(cur.items), delta: pctChange(cur.items, prev.items) },
    { label: "Sales", value: formatINR(cur.sales), delta: pctChange(cur.sales, prev.sales) },
    { label: "Ingredients used (cost)", value: formatINR(cur.consumption_cost), delta: pctChange(cur.consumption_cost, prev.consumption_cost), href: "/admin/analytics" },
    { label: "Purchases", value: formatINR(cur.purchases), delta: pctChange(cur.purchases, prev.purchases), href: "/admin/purchases" },
    { label: "Wastage", value: formatINR(cur.wastage_cost), delta: pctChange(cur.wastage_cost, prev.wastage_cost), href: "/admin/wastage" },
  ];

  const groups: { title: string; status: StockStatusRow["status"]; rows: StockStatusRow[] }[] = [
    { title: "Critical", status: "critical", rows: overall.filter((r) => r.status === "critical") },
    { title: "Low", status: "low", rows: overall.filter((r) => r.status === "low") },
    { title: "Healthy", status: "ok", rows: overall.filter((r) => r.status === "ok") },
  ];
  const noData = overall.filter((r) => r.status === "unknown").length;

  const cartsWithoutWorker = carts.filter(
    (c) => !(profiles ?? []).some((p) => p.role === "worker" && p.is_active && p.location_id === c.id),
  );
  const setupDone = cartsWithoutWorker.length === 0 && (productCount ?? 0) > 0;
  const prevLabel = range.days === 1 ? "previous day" : `previous ${range.days} days`;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <LiveRefresh tables={["stock_levels", "orders", "stock_requests", "stock_transfers", "stock_counts", "wastage", "purchase_receipts"]} />
      </div>

      {!setupDone && (
        <section className="card border-warn p-4 text-sm">
          <p className="font-bold">Finish setup</p>
          <ul className="mt-1 list-disc pl-5">
            {cartsWithoutWorker.length > 0 && (
              <li>
                <Link href="/admin/users" className="underline">
                  Add a worker
                </Link>{" "}
                for {cartsWithoutWorker.map((c) => c.name).join(", ")}
              </li>
            )}
            {(productCount ?? 0) === 0 && (
              <li>
                Import products and recipes (<code>npm run seed:sample</code> for the sample menu)
              </li>
            )}
          </ul>
        </section>
      )}

      {/* 1. What needs attention */}
      <section className={`card p-5 ${attention.length ? "border-danger/40" : ""}`}>
        {attention.length === 0 ? (
          <p className="font-bold text-ok">✓ Nothing needs attention right now</p>
        ) : (
          <>
            <h2 className="mb-2 text-lg font-bold">
              <span className="text-danger">●</span> {attention.length} item{attention.length === 1 ? "" : "s"} need attention
            </h2>
            <ul className="flex flex-col gap-1.5">
              {attention.map((a, i) => (
                <li key={i}>
                  <Link href={a.href} className={`font-medium underline-offset-2 hover:underline ${a.tone === "danger" ? "text-danger" : "text-warn"}`}>
                    {a.text}
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {/* 2. Operations for the period */}
      <section className="flex flex-col gap-3">
        <RangeFilter path="/admin" range={range} />
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          {kpis.map((k) => {
            const body = (
              <>
                <p className="text-xs font-semibold uppercase text-muted">{k.label}</p>
                <p className="text-2xl font-bold tabular-nums">{k.value}</p>
                <p className="text-xs text-muted">{k.delta ? `${k.delta} vs ${prevLabel}` : `— vs ${prevLabel}`}</p>
              </>
            );
            return k.href ? (
              <Link key={k.label} href={k.href} className="card p-4 hover:border-brand">
                {body}
              </Link>
            ) : (
              <div key={k.label} className="card p-4">
                {body}
              </div>
            );
          })}
        </div>
      </section>

      {/* 3. Stock alerts (whole business) */}
      <section className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-bold">Stock — all locations</h2>
          <Link href="/admin/inventory" className="text-sm font-semibold text-brand">
            Full inventory →
          </Link>
        </div>
        <div className="grid gap-3 lg:grid-cols-3">
          {groups.map((g) => (
            <div key={g.title} className="card p-4">
              <div className="mb-2 flex items-center gap-2">
                <StatusPill status={g.status} />
                <span className="text-sm text-muted">{g.rows.length}</span>
              </div>
              {g.rows.length === 0 ? (
                <p className="text-sm text-muted">None</p>
              ) : (
                <ul className="flex flex-col gap-1.5 text-sm">
                  {g.rows.slice(0, 8).map((r) => (
                    <li key={r.material_id} className="flex justify-between gap-3">
                      <Link href={`/admin/inventory/${r.material_id}`} className="truncate font-medium hover:underline">
                        {r.name}
                      </Link>
                      <span className="shrink-0 text-right tabular-nums">
                        {qty(r)}
                        {r.days_left !== null && <span className="ml-2 text-muted">~{Number(r.days_left)}d</span>}
                      </span>
                    </li>
                  ))}
                  {g.rows.length > 8 && <li className="text-muted">+{g.rows.length - 8} more</li>}
                </ul>
              )}
            </div>
          ))}
        </div>
        {noData > 0 && (
          <p className="text-xs text-muted">
            {noData} material{noData === 1 ? " has" : "s have"} no reorder levels and not enough history for a runway estimate yet —{" "}
            <Link href="/admin/materials" className="underline">
              set levels
            </Link>
            .
          </p>
        )}
      </section>

      {/* 4. Carts */}
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-bold">Carts — {range.label.toLowerCase()}</h2>
        <div className="grid gap-3 md:grid-cols-3">
          {summary.carts.map((c) => {
            const st = cartStatus.get(c.location_id) ?? [];
            const crit = st.filter((r) => r.status === "critical").length;
            const low = st.filter((r) => r.status === "low").length;
            return (
              <Link key={c.location_id} href={`/admin/analytics?location=${c.location_id}&range=${range.key === "custom" ? "7d" : range.key}`} className="card flex flex-col gap-3 p-4 hover:border-brand">
                <p className="text-lg font-bold">{c.name}</p>
                <dl className="grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <dt className="text-xs text-muted">Sales</dt>
                    <dd className="font-bold tabular-nums">{formatINR(c.sales)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted">Orders · items</dt>
                    <dd className="font-bold tabular-nums">
                      {c.orders} · {c.items}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted">Wastage</dt>
                    <dd className="font-bold tabular-nums">{formatINR(c.wastage_cost)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted">Stock alerts</dt>
                    <dd className="flex flex-wrap gap-1">
                      {crit > 0 && <StatusPill status="critical" />}
                      {low > 0 && <StatusPill status="low" />}
                      {crit + low === 0 && <span className="font-bold">None</span>}
                      {(crit > 0 || low > 0) && <span className="text-xs text-muted">{crit + low}</span>}
                    </dd>
                  </div>
                </dl>
                {c.negative_items > 0 && (
                  <p className="text-xs font-semibold text-danger">{c.negative_items} item(s) below zero — check stock</p>
                )}
              </Link>
            );
          })}
        </div>
      </section>
    </div>
  );
}
