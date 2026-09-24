import Link from "next/link";
import { LiveRefresh } from "@/components/LiveRefresh";
import { StatusPill } from "@/components/StatusPill";
import { getStockStatus } from "@/lib/analytics";
import { formatINR } from "@/lib/format";
import { formatQuantity, type UnitInfo } from "@/lib/quantity";
import { createClient } from "@/lib/supabase/server";
import type { Location } from "@/lib/types";

export const metadata = { title: "Inventory" };

interface LevelRow {
  location_id: string;
  material_id: string;
  quantity: string;
}

interface MaterialRow {
  id: string;
  name: string;
  display_unit: string;
  avg_unit_cost: string;
}

export default async function InventoryPage({ searchParams }: PageProps<"/admin/inventory">) {
  const params = await searchParams;
  const supabase = await createClient();
  const [{ data: locations }, { data: materials }, { data: levels }, { data: units }] = await Promise.all([
    supabase.from("locations").select("id, code, name, type, sort_order, is_active").eq("is_active", true).order("sort_order").returns<Location[]>(),
    supabase.from("raw_materials").select("id, name, display_unit, avg_unit_cost").eq("is_active", true).order("name").returns<MaterialRow[]>(),
    supabase.from("stock_levels").select("location_id, material_id, quantity").returns<LevelRow[]>(),
    supabase.from("units").select("code, factor_to_base").returns<UnitInfo[]>(),
  ]);
  const locationId =
    typeof params.location === "string" && (locations ?? []).some((l) => l.id === params.location) ? params.location : null;
  const statusRows = await getStockStatus(locationId);
  const statusBy = new Map(statusRows.map((s) => [s.material_id, s]));
  const unitByCode = new Map((units ?? []).map((u) => [u.code, u]));
  const qtyAt = new Map((levels ?? []).map((l) => [`${l.location_id}:${l.material_id}`, Number(l.quantity)]));

  const rows = (materials ?? []).map((m) => {
    const perLoc = (locations ?? []).map((l) => qtyAt.get(`${l.id}:${m.id}`) ?? 0);
    const total = perLoc.reduce((a, b) => a + b, 0);
    return { m, perLoc, total, value: Math.max(total, 0) * Number(m.avg_unit_cost), status: statusBy.get(m.id) };
  });
  const valueByLoc = (locations ?? []).map((_, i) =>
    rows.reduce((s, r) => s + Math.max(r.perLoc[i], 0) * Number(r.m.avg_unit_cost), 0),
  );
  const totalValue = valueByLoc.reduce((a, b) => a + b, 0);
  const scopeName = locationId ? (locations ?? []).find((l) => l.id === locationId)?.name : "all locations";

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Inventory</h1>
        <LiveRefresh tables={["stock_levels"]} />
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {(locations ?? []).map((l, i) => (
          <div key={l.id} className="card p-4">
            <p className="text-xs font-semibold uppercase text-muted">{l.name}</p>
            <p className="text-xl font-bold tabular-nums">{formatINR(valueByLoc[i].toFixed(0))}</p>
          </div>
        ))}
        <div className="card p-4">
          <p className="text-xs font-semibold uppercase text-muted">Total stock value</p>
          <p className="text-xl font-bold tabular-nums">{formatINR(totalValue.toFixed(0))}</p>
        </div>
      </div>
      <p className="-mt-2 text-xs text-muted">
        Valued at weighted-average purchase cost. Items below zero are valued at ₹0.
      </p>

      <form className="flex flex-wrap items-end gap-2">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">Status &amp; runway for</span>
          <select name="location" defaultValue={locationId ?? ""} className="field min-h-10 py-1 text-sm">
            <option value="">All locations (business-wide levels)</option>
            {(locations ?? []).map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn btn-secondary min-h-10 text-sm">
          Show
        </button>
      </form>

      <div className="card overflow-x-auto">
        <table className="w-full min-w-[52rem] text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs uppercase text-muted">
              <th className="sticky left-0 bg-surface p-3 font-semibold">Raw material</th>
              {(locations ?? []).map((l) => (
                <th key={l.id} className={`p-3 text-right font-semibold ${l.id === locationId ? "text-brand" : ""}`}>
                  {l.name}
                </th>
              ))}
              <th className="p-3 text-right font-semibold">Total</th>
              <th className="p-3 text-right font-semibold">Value</th>
              <th className="p-3 font-semibold">Status ({scopeName})</th>
              <th className="p-3 text-right font-semibold">Runway</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map(({ m, perLoc, total, value, status }) => {
              const unit = unitByCode.get(m.display_unit) ?? { code: m.display_unit, factor_to_base: 1 };
              return (
                <tr key={m.id} className="hover:bg-bg">
                  <td className="sticky left-0 bg-surface p-3 font-medium">
                    <Link href={`/admin/inventory/${m.id}`} className="hover:underline">
                      {m.name}
                    </Link>
                  </td>
                  {perLoc.map((q, i) => (
                    <td key={i} className={`p-3 text-right tabular-nums ${q < 0 ? "font-bold text-danger" : q === 0 ? "text-muted" : ""}`}>
                      {formatQuantity(q, unit)}
                    </td>
                  ))}
                  <td className="p-3 text-right font-bold tabular-nums">{formatQuantity(total, unit)}</td>
                  <td className="p-3 text-right tabular-nums">{formatINR(value.toFixed(0))}</td>
                  <td className="p-3">{status ? <StatusPill status={status.status} /> : <span className="text-muted">—</span>}</td>
                  <td className="p-3 text-right tabular-nums text-muted">
                    {status?.days_left != null ? `~${Number(status.days_left)} days` : status?.avg_daily_use == null ? "—" : ""}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
