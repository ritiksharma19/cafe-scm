import { ActionForm } from "@/components/ActionForm";
import { formatDateTime, formatINR, istDayStart } from "@/lib/format";
import { formatQuantity, type UnitInfo } from "@/lib/quantity";
import { createClient } from "@/lib/supabase/server";
import type { Location } from "@/lib/types";
import { WASTAGE_REASONS } from "@/lib/wastage";
import { voidWastage } from "../stock-actions";

export const metadata = { title: "Wastage" };

interface WastageRow {
  id: string;
  occurred_at: string;
  quantity: string;
  reason: string;
  notes: string | null;
  status: "posted" | "voided";
  void_reason: string | null;
  location_id: string;
  material: { name: string; display_unit: string; avg_unit_cost: string } | null;
  recorder: { full_name: string } | null;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const toIstDate = (d: Date) => new Date(d.getTime() + 330 * 60 * 1000).toISOString().slice(0, 10);

export default async function WastagePage({ searchParams }: PageProps<"/admin/wastage">) {
  const params = await searchParams;
  const today = istDayStart();
  const from = typeof params.from === "string" && DATE.test(params.from) ? new Date(`${params.from}T00:00:00+05:30`) : new Date(today.getTime() - 6 * DAY_MS);
  const to = typeof params.to === "string" && DATE.test(params.to) ? new Date(`${params.to}T00:00:00+05:30`) : today;
  const cart = typeof params.cart === "string" ? params.cart : "";

  const supabase = await createClient();
  let q = supabase
    .from("wastage")
    .select(
      "id, occurred_at, quantity, reason, notes, status, void_reason, location_id, material:raw_materials(name, display_unit, avg_unit_cost), recorder:profiles!wastage_recorded_by_fkey(full_name)",
    )
    .gte("occurred_at", from.toISOString())
    .lt("occurred_at", new Date(to.getTime() + DAY_MS).toISOString())
    .order("occurred_at", { ascending: false })
    .limit(500);
  if (cart) q = q.eq("location_id", cart);

  const [{ data: rows, error }, { data: locations }, { data: units }, { data: movements }] = await Promise.all([
    q.returns<WastageRow[]>(),
    supabase.from("locations").select("id, code, name, type, sort_order, is_active").order("sort_order").returns<Location[]>(),
    supabase.from("units").select("code, factor_to_base").returns<UnitInfo[]>(),
    // Cost as posted (unit cost frozen at the time of wastage).
    supabase
      .from("stock_movements")
      .select("ref_id, qty_delta, unit_cost")
      .eq("movement_type", "WASTAGE")
      .gte("occurred_at", from.toISOString())
      .lt("occurred_at", new Date(to.getTime() + DAY_MS).toISOString())
      .returns<{ ref_id: string; qty_delta: string; unit_cost: string | null }[]>(),
  ]);

  const unitByCode = new Map((units ?? []).map((u) => [u.code, u]));
  const locationName = new Map((locations ?? []).map((l) => [l.id, l.name]));
  const costById = new Map((movements ?? []).map((m) => [m.ref_id, -Number(m.qty_delta) * Number(m.unit_cost ?? 0)]));
  const reasonLabel = new Map<string, string>(WASTAGE_REASONS.map((r) => [r.value, r.label]));
  const posted = (rows ?? []).filter((r) => r.status === "posted");
  const cost = (r: WastageRow) => costById.get(r.id) ?? 0;

  const group = (key: (r: WastageRow) => string) => {
    const m = new Map<string, number>();
    for (const r of posted) m.set(key(r), (m.get(key(r)) ?? 0) + cost(r));
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };
  const total = posted.reduce((s, r) => s + cost(r), 0);

  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-2xl font-bold">Wastage</h1>

      <form className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">From</span>
          <input type="date" name="from" defaultValue={toIstDate(from)} className="field" />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">To</span>
          <input type="date" name="to" defaultValue={toIstDate(to)} className="field" />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Location</span>
          <select name="cart" defaultValue={cart} className="field">
            <option value="">All</option>
            {(locations ?? []).map((l) => (
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

      <div className="grid gap-3 md:grid-cols-4">
        <div className="card p-4">
          <p className="text-xs font-semibold uppercase text-muted">Wastage cost</p>
          <p className="text-2xl font-bold tabular-nums">{formatINR(total.toFixed(2))}</p>
          <p className="text-xs text-muted">{posted.length} records</p>
        </div>
        {[
          ["By material", group((r) => r.material?.name ?? "?")],
          ["By location", group((r) => locationName.get(r.location_id) ?? "?")],
          ["By reason", group((r) => reasonLabel.get(r.reason) ?? r.reason)],
        ].map(([title, entries]) => (
          <div key={title as string} className="card p-4">
            <p className="mb-2 text-xs font-semibold uppercase text-muted">{title as string}</p>
            <ul className="flex flex-col gap-1 text-sm">
              {(entries as [string, number][]).slice(0, 5).map(([k, v]) => (
                <li key={k} className="flex justify-between gap-2">
                  <span className="truncate">{k}</span>
                  <span className="tabular-nums">{formatINR(v.toFixed(2))}</span>
                </li>
              ))}
              {(entries as [string, number][]).length === 0 && <li className="text-muted">—</li>}
            </ul>
          </div>
        ))}
      </div>

      {error && <p className="text-danger">Could not load wastage: {error.message}</p>}
      <ul className="flex flex-col gap-2">
        {(rows ?? []).map((r) => {
          const code = r.material?.display_unit ?? "";
          return (
            <li key={r.id} className={`card ${r.status === "voided" ? "opacity-70" : ""}`}>
              <details>
                <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-4 gap-y-1 p-4 text-sm">
                  <span className="font-semibold">{formatDateTime(r.occurred_at)}</span>
                  <span className="text-muted">{locationName.get(r.location_id)}</span>
                  <span className="min-w-0 flex-1 font-medium">
                    {r.material?.name} · {formatQuantity(r.quantity, unitByCode.get(code) ?? { code, factor_to_base: 1 })}
                  </span>
                  <span className="rounded-full bg-bg px-2 py-0.5 text-xs font-bold">{reasonLabel.get(r.reason)}</span>
                  {r.status === "voided" && <span className="text-xs font-bold text-danger">VOIDED</span>}
                  <span className="tabular-nums font-semibold">{formatINR(cost(r).toFixed(2))}</span>
                </summary>
                <div className="flex flex-col gap-2 border-t border-line p-4 text-sm">
                  <p className="text-muted">
                    By {r.recorder?.full_name ?? "?"}
                    {r.notes && ` · “${r.notes}”`}
                  </p>
                  {r.status === "voided" ? (
                    <p className="text-danger">Voided: {r.void_reason}</p>
                  ) : (
                    <ActionForm action={voidWastage} id={r.id} label="Void" tone="danger" reason={{ placeholder: "Reason", required: true }} />
                  )}
                </div>
              </details>
            </li>
          );
        })}
        {rows?.length === 0 && <li className="card p-4 text-muted">No wastage in this period.</li>}
      </ul>
    </div>
  );
}
