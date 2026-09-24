import Link from "next/link";
import { BarList } from "@/components/charts/BarList";
import { ColumnChart } from "@/components/charts/ColumnChart";
import { RangeFilter } from "@/components/RangeFilter";
import { StatusPill } from "@/components/StatusPill";
import {
  getDailyTrend,
  getHourlyOrders,
  getMaterialFlow,
  getProductCosts,
  getProductSales,
  getPurchasesByMaterial,
  getPurchasesBySupplier,
  getStockStatus,
} from "@/lib/analytics";
import { formatINR } from "@/lib/format";
import { formatQuantity, type UnitInfo } from "@/lib/quantity";
import { resolveRange } from "@/lib/range";
import { createClient } from "@/lib/supabase/server";
import type { Location } from "@/lib/types";

export const metadata = { title: "Analytics" };

const DAY = 24 * 60 * 60 * 1000;
const dayLabel = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
const hourLabel = (h: number) => (h === 0 ? "12a" : h < 12 ? `${h}a` : h === 12 ? "12p" : `${h - 12}p`);
const hourTitle = (h: number) => `${hourLabel(h).replace("a", " AM").replace("p", " PM")} – ${hourLabel((h + 1) % 24).replace("a", " AM").replace("p", " PM")}`;

function Section({ title, children, note }: { title: string; children: React.ReactNode; note?: React.ReactNode }) {
  return (
    <section className="card flex flex-col gap-3 p-5">
      <div>
        <h2 className="text-lg font-bold">{title}</h2>
        {note && <p className="mt-0.5 text-xs text-muted">{note}</p>}
      </div>
      {children}
    </section>
  );
}

export default async function AnalyticsPage({ searchParams }: PageProps<"/admin/analytics">) {
  const params = await searchParams;
  const range = resolveRange(params, new Date(), "7d");
  const supabase = await createClient();
  const [{ data: locations }, { data: units }] = await Promise.all([
    supabase.from("locations").select("id, code, name, type, sort_order, is_active").eq("is_active", true).order("sort_order").returns<Location[]>(),
    supabase.from("units").select("code, factor_to_base").returns<UnitInfo[]>(),
  ]);
  const locationId = typeof params.location === "string" && (locations ?? []).some((l) => l.id === params.location) ? params.location : null;
  const compareAt = new Date(range.to.getTime() - 30 * DAY);

  const [daily, hourly, products, flow, status, byMaterial, bySupplier, costs] = await Promise.all([
    getDailyTrend(range.from, range.to, locationId),
    getHourlyOrders(range.from, range.to, locationId),
    getProductSales(range.from, range.to, locationId),
    getMaterialFlow(range.from, range.to, locationId),
    getStockStatus(locationId),
    getPurchasesByMaterial(range.from, range.to),
    getPurchasesBySupplier(range.from, range.to),
    getProductCosts(compareAt),
  ]);

  const unitByCode = new Map((units ?? []).map((u) => [u.code, u]));
  const unitOf = (code: string) => unitByCode.get(code) ?? { code, factor_to_base: 1 };
  const q = (v: number | string, code: string) => formatQuantity(v, unitOf(code));
  const scope = locationId ? (locations ?? []).find((l) => l.id === locationId)?.name : "All locations";

  const sum = (k: "orders" | "items" | "sales" | "consumption_cost" | "wastage_cost" | "purchase_cost") =>
    daily.reduce((s, d) => s + Number(d[k]), 0);
  const totals = {
    orders: sum("orders"),
    items: sum("items"),
    sales: sum("sales"),
    consumption: sum("consumption_cost"),
    wastage: sum("wastage_cost"),
    purchases: sum("purchase_cost"),
  };
  const col = (key: "orders" | "sales" | "wastage_cost") =>
    daily.map((d) => {
      const date = new Date(`${d.day}T00:00:00Z`);
      return { key: d.day, label: dayLabel.format(date), title: dayLabel.format(date), value: Number(d[key]) };
    });
  const activeHours = hourly.filter((h) => Number(h.orders) > 0).map((h) => h.hour);
  const hours = activeHours.length
    ? hourly.filter((h) => h.hour >= Math.min(...activeHours) && h.hour <= Math.max(...activeHours))
    : [];
  const toBuy = status
    .filter((s) => s.status === "critical" || s.status === "low")
    .sort((a, b) => (a.status === b.status ? 0 : a.status === "critical" ? -1 : 1));

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-2xl font-bold">Analytics</h1>
        <p className="text-sm text-muted">
          {scope} · {range.label}
        </p>
      </div>
      <RangeFilter path="/admin/analytics" range={range} locations={locations ?? []} locationId={locationId ?? undefined} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {[
          ["Orders", String(totals.orders)],
          ["Items sold", String(totals.items)],
          ["Sales", formatINR(totals.sales.toFixed(0))],
          ["Ingredients used (cost)", formatINR(totals.consumption.toFixed(0))],
          ["Purchases", formatINR(totals.purchases.toFixed(0))],
          ["Wastage", formatINR(totals.wastage.toFixed(0))],
        ].map(([label, value]) => (
          <div key={label} className="card p-4">
            <p className="text-xs font-semibold uppercase text-muted">{label}</p>
            <p className="text-xl font-bold tabular-nums">{value}</p>
          </div>
        ))}
      </div>

      {range.days > 1 && (
        <div className="grid gap-4 lg:grid-cols-3">
          <Section title="Sales per day">
            <ColumnChart data={col("sales")} valueFormat="inr" ariaLabel="Sales per day" />
          </Section>
          <Section title="Orders per day">
            <ColumnChart data={col("orders")} ariaLabel="Orders per day" />
          </Section>
          <Section title="Wastage cost per day">
            <ColumnChart data={col("wastage_cost")} valueFormat="inr" ariaLabel="Wastage cost per day" />
          </Section>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Product sales" note="Quantity sold; sales value alongside.">
          <BarList
            rows={products.map((p) => ({ key: p.product_id, label: p.name, value: Number(p.quantity) }))}
            secondary={(k) => {
              const p = products.find((x) => x.product_id === k);
              return p ? formatINR(Number(p.sales).toFixed(0)) : null;
            }}
          />
        </Section>
        <Section title="Orders by hour" note="When orders happen (India time). Descriptive only — no forecast.">
          <ColumnChart
            data={hours.map((h) => ({ key: String(h.hour), label: hourLabel(h.hour), title: hourTitle(h.hour), value: Number(h.orders) }))}
            ariaLabel="Orders by hour of day"
            maxXLabels={12}
          />
        </Section>
      </div>

      <Section
        title="Raw material use vs sales"
        note={
          <>
            <b>Used in sales</b> = recipe × items sold (expected). <b>Inventory variance</b> = corrections from approved stock
            counts and admin adjustments (− means less stock than expected). <b>Actual use</b> = sales + wastage − variance. A
            variance is not assumed to be theft or error.
          </>
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[56rem] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase text-muted">
                <th className="py-2 pr-3 font-semibold">Material</th>
                <th className="py-2 pr-3 text-right font-semibold">Used in sales</th>
                <th className="py-2 pr-3 text-right font-semibold">Wasted</th>
                <th className="py-2 pr-3 text-right font-semibold">Inventory variance</th>
                <th className="py-2 pr-3 text-right font-semibold">Actual use</th>
                <th className="py-2 pr-3 text-right font-semibold">Purchased</th>
                <th className="py-2 pr-3 text-right font-semibold">Transfers in / out</th>
                <th className="py-2 pr-3 text-right font-semibold">Cost used</th>
                <th className="py-2 text-right font-semibold">Stock now</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {flow.map((f) => {
                const adj = Number(f.count_adjust);
                const actual = Number(f.consumed) + Number(f.wasted) - adj;
                return (
                  <tr key={f.material_id}>
                    <td className="py-2 pr-3 font-medium">
                      <Link href={`/admin/inventory/${f.material_id}`} className="hover:underline">
                        {f.name}
                      </Link>
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">{q(f.consumed, f.display_unit)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{q(f.wasted, f.display_unit)}</td>
                    <td className={`py-2 pr-3 text-right tabular-nums ${adj < 0 ? "font-semibold text-danger" : adj > 0 ? "text-ok" : "text-muted"}`}>
                      {adj === 0 ? "—" : `${adj > 0 ? "+" : ""}${q(adj, f.display_unit)}`}
                    </td>
                    <td className="py-2 pr-3 text-right font-semibold tabular-nums">{q(actual, f.display_unit)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{q(f.purchased, f.display_unit)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums text-muted">
                      {q(f.transfer_in, f.display_unit)} / {q(f.transfer_out, f.display_unit)}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">{formatINR(Number(f.consumed_cost).toFixed(0))}</td>
                    <td className="py-2 text-right tabular-nums">{q(f.current_qty, f.display_unit)}</td>
                  </tr>
                );
              })}
              {flow.length === 0 && (
                <tr>
                  <td colSpan={9} className="py-4 text-muted">
                    No stock movements in this period.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Section>

      <Section
        title="What to buy"
        note="Runway uses the average daily use over the configured window (Settings). Materials with too little history show “—” rather than a guess."
      >
        {toBuy.length === 0 ? (
          <p className="text-sm text-muted">Nothing is low for {scope?.toLowerCase()}.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[44rem] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs uppercase text-muted">
                  <th className="py-2 pr-3 font-semibold">Material</th>
                  <th className="py-2 pr-3 font-semibold">Status</th>
                  <th className="py-2 pr-3 text-right font-semibold">In stock</th>
                  <th className="py-2 pr-3 text-right font-semibold">Avg use / day</th>
                  <th className="py-2 pr-3 text-right font-semibold">Days left</th>
                  <th className="py-2 pr-3 text-right font-semibold">Reorder level</th>
                  <th className="py-2 text-right font-semibold">Suggested order</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {toBuy.map((s) => (
                  <tr key={s.material_id}>
                    <td className="py-2 pr-3 font-medium">{s.name}</td>
                    <td className="py-2 pr-3">
                      <StatusPill status={s.status} />
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">{q(s.quantity, s.display_unit)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{s.avg_daily_use ? q(s.avg_daily_use, s.display_unit) : "—"}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{s.days_left !== null ? `~${Number(s.days_left)}` : "—"}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{s.reorder_level ? q(s.reorder_level, s.display_unit) : "—"}</td>
                    <td className="py-2 text-right font-semibold tabular-nums">{s.suggested_reorder ? q(s.suggested_reorder, s.display_unit) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Purchases by supplier" note="All locations. Actual amounts paid, as entered on receipts.">
          <BarList
            rows={bySupplier.map((s) => ({ key: s.supplier_id ?? "none", label: s.name, value: Number(s.value) }))}
            format={(v) => formatINR(v.toFixed(0))}
            secondary={(k) => {
              const s = bySupplier.find((x) => (x.supplier_id ?? "none") === k);
              return s ? `${s.receipts} receipt${s.receipts === 1 ? "" : "s"}` : null;
            }}
            emptyText="No purchases in this period."
          />
        </Section>
        <Section title="Purchase prices" note="Last price paid vs the one before. Shown as facts — no reason is assumed.">
          {byMaterial.length === 0 ? (
            <p className="text-sm text-muted">No purchases in this period.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs uppercase text-muted">
                  <th className="py-2 pr-3 font-semibold">Material</th>
                  <th className="py-2 pr-3 text-right font-semibold">Bought</th>
                  <th className="py-2 pr-3 text-right font-semibold">Spent</th>
                  <th className="py-2 text-right font-semibold">Last price</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {byMaterial.map((m) => {
                  const f = Number(unitOf(m.display_unit).factor_to_base);
                  const last = m.last_unit_cost !== null ? Number(m.last_unit_cost) * f : null;
                  const prev = m.prev_unit_cost !== null ? Number(m.prev_unit_cost) * f : null;
                  const change = last !== null && prev !== null ? last - prev : null;
                  return (
                    <tr key={m.material_id}>
                      <td className="py-2 pr-3 font-medium">{m.name}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{q(m.quantity, m.display_unit)}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{formatINR(Number(m.value).toFixed(0))}</td>
                      <td className="py-2 text-right tabular-nums">
                        {last !== null ? `${formatINR(last.toFixed(2))}/${m.display_unit}` : "—"}
                        {change !== null && Math.abs(change) >= 0.01 && (
                          <span className={`ml-2 text-xs font-semibold ${change > 0 ? "text-danger" : "text-ok"}`}>
                            {change > 0 ? "+" : "−"}
                            {formatINR(Math.abs(change).toFixed(2))}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Section>
      </div>

      <Section
        title="Cost per product"
        note={
          <>
            Estimated ingredient cost from the current recipe and weighted-average costs, compared with 30 days earlier (
            {compareAt.toISOString().slice(0, 10)}). Margin is <b>estimated gross margin before other expenses</b> — not profit.
          </>
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[48rem] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase text-muted">
                <th className="py-2 pr-3 font-semibold">Product</th>
                <th className="py-2 pr-3 text-right font-semibold">Price</th>
                <th className="py-2 pr-3 text-right font-semibold">Ingredient cost</th>
                <th className="py-2 pr-3 text-right font-semibold">30 days ago</th>
                <th className="py-2 pr-3 text-right font-semibold">Est. gross margin</th>
                <th className="py-2 font-semibold">Biggest cost drivers</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {costs.map((c) => {
                const price = Number(c.selling_price);
                const now = Number(c.cost_now);
                const then = c.cost_then !== null ? Number(c.cost_then) : null;
                const change = then !== null ? now - then : null;
                const drivers = c.ingredients.filter((i) => i.cost_now > 0).slice(0, 3);
                return (
                  <tr key={c.product_id}>
                    <td className="py-2 pr-3 font-medium">{c.name}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{formatINR(price)}</td>
                    <td className="py-2 pr-3 text-right font-semibold tabular-nums">{now > 0 ? formatINR(now.toFixed(2)) : "—"}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {then === null ? (
                        <span className="text-muted">no history</span>
                      ) : (
                        <>
                          {formatINR(then.toFixed(2))}
                          {!c.then_complete && <span className="ml-1 text-xs text-muted">(partial)</span>}
                          {change !== null && Math.abs(change) >= 0.01 && (
                            <span className={`ml-2 text-xs font-semibold ${change > 0 ? "text-danger" : "text-ok"}`}>
                              {change > 0 ? "+" : "−"}
                              {formatINR(Math.abs(change).toFixed(2))}
                            </span>
                          )}
                        </>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {now > 0 && price > 0 ? `${formatINR((price - now).toFixed(2))} (${Math.round(((price - now) / price) * 100)}%)` : "—"}
                    </td>
                    <td className="py-2 text-muted">
                      {drivers.map((d) => `${d.material} ${formatINR(d.cost_now.toFixed(2))}`).join(" · ") || "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  );
}
