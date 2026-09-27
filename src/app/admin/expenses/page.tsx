import { ActionForm } from "@/components/ActionForm";
import { LiveRefresh } from "@/components/LiveRefresh";
import { RangeFilter } from "@/components/RangeFilter";
import { formatINR, istDate } from "@/lib/format";
import { expenseCategoryLabel, paymentMethodLabel } from "@/lib/money";
import { resolveRange } from "@/lib/range";
import { createClient } from "@/lib/supabase/server";
import type { Location } from "@/lib/types";
import { voidExpense } from "./actions";
import { ExpenseForm } from "./ExpenseForm";

export const metadata = { title: "Expenses" };

interface ExpenseRow {
  id: string;
  location_id: string | null;
  category: string;
  amount: string;
  description: string | null;
  spent_on: string;
  payment_method: string;
  status: "posted" | "voided";
  void_reason: string | null;
  recorder: { full_name: string } | null;
}

export default async function ExpensesPage({ searchParams }: PageProps<"/admin/expenses">) {
  const params = await searchParams;
  const range = resolveRange(params, new Date(), "30d");
  const supabase = await createClient();
  const { data: locations } = await supabase
    .from("locations")
    .select("id, code, name, type, sort_order, is_active")
    .order("sort_order")
    .returns<Location[]>();
  const locationId = typeof params.location === "string" && (locations ?? []).some((l) => l.id === params.location) ? params.location : null;

  let q = supabase
    .from("expenses")
    .select("id, location_id, category, amount, description, spent_on, payment_method, status, void_reason, recorder:profiles!expenses_recorded_by_fkey(full_name)")
    .gte("spent_on", range.fromDate)
    .lte("spent_on", range.toDate)
    .order("spent_on", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(500);
  if (locationId) q = q.eq("location_id", locationId);
  const { data: rows, error } = await q.returns<ExpenseRow[]>();

  const locationName = new Map((locations ?? []).map((l) => [l.id, l.name]));
  const posted = (rows ?? []).filter((r) => r.status === "posted");
  const total = posted.reduce((s, r) => s + Number(r.amount), 0);
  const byCategory = new Map<string, number>();
  for (const r of posted) byCategory.set(r.category, (byCategory.get(r.category) ?? 0) + Number(r.amount));
  const today = istDate();

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Expenses</h1>
          <p className="mt-1 text-sm text-muted">
            Everything the business pays for that is not a raw material — rent, salaries, gas, electricity, repairs. These turn gross
            profit into real net profit on Analytics. Workers can also add small cart expenses from their phones.
          </p>
        </div>
        <LiveRefresh tables={["expenses"]} />
      </div>

      <section className="card p-5">
        <h2 className="mb-3 font-bold">Add expense</h2>
        <ExpenseForm locations={(locations ?? []).filter((l) => l.is_active)} today={today} />
      </section>

      <RangeFilter path="/admin/expenses" range={range} locations={locations ?? []} locationId={locationId ?? undefined} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div className="card p-4">
          <p className="text-xs font-semibold uppercase text-muted">Total</p>
          <p className="text-xl font-bold tabular-nums">{formatINR(total.toFixed(0))}</p>
          <p className="text-xs text-muted">{posted.length} entries</p>
        </div>
        {[...byCategory.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([cat, amount]) => (
            <div key={cat} className="card p-4">
              <p className="text-xs font-semibold uppercase text-muted">{expenseCategoryLabel(cat)}</p>
              <p className="text-xl font-bold tabular-nums">{formatINR(amount.toFixed(0))}</p>
            </div>
          ))}
      </div>

      {error && <p className="text-danger">Could not load expenses: {error.message}</p>}
      {!error && rows?.length === 0 && <p className="card p-5 text-muted">No expenses in this period.</p>}

      <ul className="flex flex-col gap-2">
        {(rows ?? []).map((r) => (
          <li key={r.id} className={`card ${r.status === "voided" ? "opacity-70" : ""}`}>
            <details>
              <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-4 gap-y-1 p-4">
                <span className="w-24 text-sm tabular-nums text-muted">{r.spent_on}</span>
                <span className="w-44 font-semibold">{expenseCategoryLabel(r.category)}</span>
                <span className="min-w-0 flex-1 text-sm">
                  {r.description ?? ""}
                  <span className="ml-2 text-muted">
                    {r.location_id ? locationName.get(r.location_id) : "Whole business"} · {paymentMethodLabel(r.payment_method)}
                  </span>
                </span>
                {r.status === "voided" && <span className="rounded-full bg-danger/10 px-2 py-0.5 text-xs font-bold text-danger">VOIDED</span>}
                <span className={`font-semibold tabular-nums ${r.status === "voided" ? "line-through" : ""}`}>{formatINR(r.amount)}</span>
              </summary>
              <div className="flex flex-col gap-3 border-t border-line p-4 text-sm">
                <p className="text-muted">Recorded by {r.recorder?.full_name ?? "—"}</p>
                {r.status === "voided" ? (
                  <p className="text-danger">Voided: {r.void_reason}</p>
                ) : (
                  <ActionForm action={voidExpense} id={r.id} label="Void expense" tone="danger" reason={{ placeholder: "Reason, e.g. entered twice", required: true }} />
                )}
              </div>
            </details>
          </li>
        ))}
      </ul>
    </div>
  );
}
