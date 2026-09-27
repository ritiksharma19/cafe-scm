import { ProfitChart } from "@/components/charts/ProfitChart";
import { pctChange, type ProductProfitRow, type ProfitSummary } from "@/lib/analytics";
import { formatINR } from "@/lib/format";
import { expenseCategoryLabel, formatPct, paymentMethodLabel } from "@/lib/money";

const dayLabel = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });

/** ₹ with a real minus sign for losses, whole rupees. */
export const money = (v: number | string) => {
  const n = Number(v);
  return `${n < 0 ? "−" : ""}${formatINR(Math.abs(n).toFixed(0))}`;
};

function Tile({ label, value, sub, delta, tone }: { label: string; value: string; sub?: string; delta?: string | null; tone?: "ok" | "danger" }) {
  return (
    <div className="card p-4">
      <p className="text-xs font-semibold uppercase text-muted">{label}</p>
      <p className={`text-2xl font-extrabold tabular-nums ${tone === "danger" ? "text-danger" : tone === "ok" ? "text-ok" : ""}`}>{value}</p>
      <p className="text-xs text-muted">
        {sub}
        {delta && (
          <span className="ml-1">
            {sub ? "· " : ""}
            {delta} vs previous period
          </span>
        )}
      </p>
    </div>
  );
}

/** Profit tiles, P&L statement, daily profit, per-location profit, payments and expenses. */
export function ProfitOverview({ profit, days }: { profit: ProfitSummary; days: number }) {
  const c = profit.current;
  const p = profit.previous;
  const pl: { label: string; value: number; strong?: boolean; note?: string; indent?: boolean }[] = [
    { label: "Sales at menu price", value: c.gross_sales },
    { label: "− Discounts given", value: -c.discounts, indent: true },
    { label: "Net sales (money received)", value: c.net_sales, strong: true },
    { label: "− Ingredient cost of items sold", value: -c.cogs, indent: true, note: "recipe × cost at the time of sale" },
    { label: `Gross profit · ${formatPct(c.gross_margin_pct)} of sales`, value: c.gross_profit, strong: true },
    { label: "− Wastage", value: -c.wastage_cost, indent: true },
    { label: `${c.stock_variance < 0 ? "−" : "+"} Stock count differences`, value: c.stock_variance, indent: true, note: "found by stock counts and adjustments" },
    { label: "− Expenses", value: -c.expenses, indent: true, note: "rent, salaries, gas …" },
    { label: `Net profit · ${formatPct(c.net_margin_pct)} of sales`, value: c.net_profit, strong: true },
  ];

  return (
    <>
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Tile label="Net sales" value={money(c.net_sales)} sub={`${c.orders} orders · avg ${c.orders ? money(c.net_sales / c.orders) : "—"}`} delta={pctChange(c.net_sales, p.net_sales)} />
        <Tile
          label="Gross profit"
          value={money(c.gross_profit)}
          sub={`${formatPct(c.gross_margin_pct)} margin`}
          delta={pctChange(c.gross_profit, p.gross_profit)}
          tone={c.gross_profit < 0 ? "danger" : undefined}
        />
        <Tile
          label="Net profit"
          value={money(c.net_profit)}
          sub={`${formatPct(c.net_margin_pct)} margin`}
          delta={p.net_profit > 0 ? pctChange(c.net_profit, p.net_profit) : null}
          tone={c.net_profit < 0 ? "danger" : c.net_profit > 0 ? "ok" : undefined}
        />
        <Tile label="Expenses" value={money(c.expenses)} sub={c.shared_expenses > 0 ? `+ ${money(c.shared_expenses)} shared (not included)` : "rent, salaries, gas …"} delta={pctChange(c.expenses, p.expenses)} />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_1.2fr]">
        <section className="card flex flex-col gap-3 p-5">
          <div>
            <h2 className="text-lg font-bold">Profit &amp; loss</h2>
            <p className="mt-0.5 text-xs text-muted">
              Ingredient costs are the weighted-average costs frozen on each sale, so past figures never change when prices change.
              {c.shared_expenses > 0 && (
                <>
                  {" "}
                  {money(c.shared_expenses)} of business-wide expenses (no location) is not included in this location&apos;s profit.
                </>
              )}
            </p>
          </div>
          <table className="w-full text-sm">
            <tbody className="divide-y divide-line">
              {pl.map((r) => (
                <tr key={r.label} className={r.strong ? "font-bold" : ""}>
                  <td className={`py-2 pr-3 ${r.indent ? "pl-3 text-muted" : ""}`}>
                    {r.label}
                    {r.note && <span className="block text-xs font-normal text-muted">{r.note}</span>}
                  </td>
                  <td className={`py-2 text-right tabular-nums ${r.strong && r.value < 0 ? "text-danger" : ""}`}>{money(r.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="card flex flex-col gap-3 p-5">
          <div>
            <h2 className="text-lg font-bold">Net profit per day</h2>
            <p className="mt-0.5 text-xs text-muted">Bars below the line are loss days (for example, the day rent was paid).</p>
          </div>
          {days > 1 ? (
            <ProfitChart
              ariaLabel="Net profit per day"
              data={profit.daily.map((d) => {
                const label = dayLabel.format(new Date(`${d.day}T00:00:00Z`));
                return { key: d.day, label, title: label, value: Number(d.net_profit) };
              })}
            />
          ) : (
            <p className="text-sm text-muted">Choose a period longer than one day to see the daily trend.</p>
          )}
        </section>
      </div>

      {profit.by_location.length > 0 && (
        <section className="card flex flex-col gap-3 p-5">
          <div>
            <h2 className="text-lg font-bold">Profit by location</h2>
            <p className="mt-0.5 text-xs text-muted">
              Each location&apos;s own expenses are subtracted. Business-wide expenses (no location) appear only in the total above.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[44rem] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs uppercase text-muted">
                  <th className="py-2 pr-3 font-semibold">Location</th>
                  <th className="py-2 pr-3 text-right font-semibold">Orders</th>
                  <th className="py-2 pr-3 text-right font-semibold">Net sales</th>
                  <th className="py-2 pr-3 text-right font-semibold">Gross profit</th>
                  <th className="py-2 pr-3 text-right font-semibold">Wastage &amp; variance</th>
                  <th className="py-2 pr-3 text-right font-semibold">Expenses</th>
                  <th className="py-2 text-right font-semibold">Net profit</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {profit.by_location.map((l) => (
                  <tr key={l.location_id}>
                    <td className="py-2 pr-3 font-medium">{l.name}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{l.orders}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{money(l.net_sales)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {money(l.gross_profit)} <span className="text-xs text-muted">{formatPct(l.gross_margin_pct)}</span>
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">{money(-l.wastage_cost + l.stock_variance)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{money(l.expenses)}</td>
                    <td className={`py-2 text-right font-semibold tabular-nums ${l.net_profit < 0 ? "text-danger" : ""}`}>
                      {money(l.net_profit)} <span className="text-xs font-normal text-muted">{formatPct(l.net_margin_pct)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="card flex flex-col gap-3 p-5">
          <h2 className="text-lg font-bold">How customers paid</h2>
          {profit.payments.length === 0 ? (
            <p className="text-sm text-muted">No sales in this period.</p>
          ) : (
            <table className="w-full text-sm">
              <tbody className="divide-y divide-line">
                {profit.payments.map((m) => (
                  <tr key={m.method}>
                    <td className="py-2 pr-3 font-medium">{paymentMethodLabel(m.method)}</td>
                    <td className="py-2 pr-3 text-right text-muted tabular-nums">{m.orders} orders</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{money(m.amount)}</td>
                    <td className="py-2 text-right text-muted tabular-nums">{c.net_sales > 0 ? formatPct(Math.round((m.amount / c.net_sales) * 1000) / 10) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
        <section className="card flex flex-col gap-3 p-5">
          <h2 className="text-lg font-bold">Expenses by category</h2>
          {profit.expenses_by_category.length === 0 ? (
            <p className="text-sm text-muted">
              No expenses recorded. Add rent, salaries, gas etc. under <a href="/admin/expenses" className="font-semibold text-brand hover:underline">Expenses</a> to see real net profit.
            </p>
          ) : (
            <table className="w-full text-sm">
              <tbody className="divide-y divide-line">
                {profit.expenses_by_category.map((e) => (
                  <tr key={e.category}>
                    <td className="py-2 pr-3 font-medium">{expenseCategoryLabel(e.category)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{money(e.amount)}</td>
                    <td className="py-2 text-right text-muted tabular-nums">{c.net_sales > 0 ? `${formatPct(Math.round((e.amount / c.net_sales) * 1000) / 10)} of sales` : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </>
  );
}

/** Profit per product from actual orders in the period. */
export function ProductProfitTable({ rows }: { rows: ProductProfitRow[] }) {
  if (rows.length === 0) return <p className="text-sm text-muted">No sales in this period.</p>;
  const totalProfit = rows.reduce((s, r) => s + Number(r.profit), 0);
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[40rem] text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs uppercase text-muted">
            <th className="py-2 pr-3 font-semibold">Product</th>
            <th className="py-2 pr-3 text-right font-semibold">Sold</th>
            <th className="py-2 pr-3 text-right font-semibold">Sales</th>
            <th className="py-2 pr-3 text-right font-semibold">Ingredient cost</th>
            <th className="py-2 pr-3 text-right font-semibold">Profit</th>
            <th className="py-2 pr-3 text-right font-semibold">Margin</th>
            <th className="py-2 text-right font-semibold">Share of profit</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((r) => {
            const margin = r.margin_pct === null ? null : Number(r.margin_pct);
            return (
              <tr key={r.product_id}>
                <td className="py-2 pr-3 font-medium">
                  {r.name}
                  {r.category && <span className="ml-2 text-xs text-muted">{r.category}</span>}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">{r.quantity}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{money(r.sales)}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{money(r.cogs)}</td>
                <td className={`py-2 pr-3 text-right font-semibold tabular-nums ${Number(r.profit) < 0 ? "text-danger" : ""}`}>{money(r.profit)}</td>
                <td className={`py-2 pr-3 text-right tabular-nums ${margin !== null && margin < 50 ? "font-semibold text-warn" : ""}`}>{formatPct(margin)}</td>
                <td className="py-2 text-right text-muted tabular-nums">
                  {totalProfit > 0 ? formatPct(Math.round((Number(r.profit) / totalProfit) * 1000) / 10) : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
