import Link from "next/link";
import { notFound } from "next/navigation";
import { LiveRefresh } from "@/components/LiveRefresh";
import { RangeFilter } from "@/components/RangeFilter";
import { StatusPill } from "@/components/StatusPill";
import { getStockStatus } from "@/lib/analytics";
import { formatDateTime, formatINR } from "@/lib/format";
import { loadMovements, MOVEMENT_LABELS } from "@/lib/movements";
import { formatQuantity, type UnitInfo } from "@/lib/quantity";
import { resolveRange } from "@/lib/range";
import { createClient } from "@/lib/supabase/server";
import type { Location } from "@/lib/types";
import { AdjustStockForm } from "./AdjustStockForm";

export const metadata = { title: "Material history" };

interface Material {
  id: string;
  name: string;
  base_unit: string;
  display_unit: string;
  avg_unit_cost: string;
  lead_time_days: number;
}

export default async function MaterialHistoryPage({ params, searchParams }: PageProps<"/admin/inventory/[id]">) {
  const { id } = await params;
  const sp = await searchParams;
  const range = resolveRange(sp, new Date(), "7d");
  const supabase = await createClient();

  const [{ data: material }, { data: locations }, { data: levels }, { data: units }, { data: prices }] = await Promise.all([
    supabase.from("raw_materials").select("id, name, base_unit, display_unit, avg_unit_cost, lead_time_days").eq("id", id).maybeSingle<Material>(),
    supabase.from("locations").select("id, code, name, type, sort_order, is_active").order("sort_order").returns<Location[]>(),
    supabase.from("stock_levels").select("location_id, quantity").eq("material_id", id).returns<{ location_id: string; quantity: string }[]>(),
    supabase.from("units").select("code, factor_to_base").returns<UnitInfo[]>(),
    supabase
      .from("purchase_receipt_items")
      .select("unit_cost, quantity, receipt:purchase_receipts!inner(occurred_at, status, supplier:suppliers(name))")
      .eq("material_id", id)
      .eq("receipt.status", "posted")
      .not("unit_cost", "is", null)
      .order("created_at", { ascending: false })
      .limit(10)
      .returns<{ unit_cost: string; quantity: string; receipt: { occurred_at: string; supplier: { name: string } | null } }[]>(),
  ]);
  if (!material) notFound();

  const locationId = typeof sp.location === "string" && (locations ?? []).some((l) => l.id === sp.location) ? sp.location : null;
  const [movements, status] = await Promise.all([
    loadMovements({ materialId: id, from: range.from, to: range.to, locationId }),
    getStockStatus(null),
  ]);
  const st = status.find((s) => s.material_id === id);
  const unit = (units ?? []).find((u) => u.code === material.display_unit) ?? { code: material.display_unit, factor_to_base: 1 };
  const factor = Number(unit.factor_to_base);
  const locName = new Map((locations ?? []).map((l) => [l.id, l.name]));
  const qtyAt = new Map((levels ?? []).map((l) => [l.location_id, Number(l.quantity)]));
  const total = [...qtyAt.values()].reduce((a, b) => a + b, 0);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href="/admin/inventory" className="text-sm font-semibold text-brand">
            ← Inventory
          </Link>
          <h1 className="text-2xl font-bold">{material.name}</h1>
        </div>
        <LiveRefresh tables={["stock_levels"]} />
      </div>

      <section className="grid grid-cols-2 gap-3 md:grid-cols-6">
        {(locations ?? []).map((l) => {
          const q = qtyAt.get(l.id) ?? 0;
          return (
            <div key={l.id} className="card p-4">
              <p className="text-xs font-semibold uppercase text-muted">{l.name}</p>
              <p className={`text-xl font-bold tabular-nums ${q < 0 ? "text-danger" : ""}`}>{formatQuantity(q, unit)}</p>
            </div>
          );
        })}
        <div className="card p-4">
          <p className="text-xs font-semibold uppercase text-muted">Total</p>
          <p className="text-xl font-bold tabular-nums">{formatQuantity(total, unit)}</p>
        </div>
        <div className="card p-4">
          <p className="text-xs font-semibold uppercase text-muted">Status</p>
          <div className="mt-1">{st ? <StatusPill status={st.status} /> : "—"}</div>
          <p className="mt-1 text-xs text-muted">
            {st?.avg_daily_use
              ? `${formatQuantity(st.avg_daily_use, unit)}/day · ${st.days_left !== null ? `~${Number(st.days_left)} days left` : ""}`
              : "Insufficient data for a runway estimate"}
          </p>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="card p-4">
          <h2 className="mb-2 font-bold">Purchase prices</h2>
          <p className="mb-2 text-xs text-muted">
            Weighted-average cost now: <b>{formatINR((Number(material.avg_unit_cost) * factor).toFixed(2))}</b> per {unit.code}
          </p>
          {(prices ?? []).length === 0 ? (
            <p className="text-sm text-muted">No priced purchases yet.</p>
          ) : (
            <table className="w-full text-sm">
              <tbody className="divide-y divide-line">
                {(prices ?? []).map((p, i) => {
                  const perUnit = Number(p.unit_cost) * factor;
                  const next = prices![i + 1];
                  const change = next ? perUnit - Number(next.unit_cost) * factor : null;
                  return (
                    <tr key={i}>
                      <td className="py-1.5">{formatDateTime(p.receipt.occurred_at)}</td>
                      <td className="py-1.5 text-muted">{p.receipt.supplier?.name ?? ""}</td>
                      <td className="py-1.5 text-right tabular-nums">
                        {formatINR(perUnit.toFixed(2))}/{unit.code}
                        {change !== null && Math.abs(change) >= 0.01 && (
                          <span className="ml-2 text-xs text-muted">
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
        </div>
        <div className="card p-4">
          <h2 className="mb-2 font-bold">Adjust stock</h2>
          <p className="mb-3 text-xs text-muted">
            For corrections outside the normal workflows. Recorded in the ledger and audit log with your note.
          </p>
          <AdjustStockForm materialId={material.id} locations={(locations ?? []).filter((l) => l.is_active)} unit={{ code: unit.code, factor }} />
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-bold">Movement history</h2>
        <RangeFilter path={`/admin/inventory/${id}`} range={range} locations={locations ?? []} locationId={locationId ?? undefined} />
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[44rem] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase text-muted">
                <th className="p-3 font-semibold">When</th>
                <th className="p-3 font-semibold">Location</th>
                <th className="p-3 font-semibold">What</th>
                <th className="p-3 font-semibold">Detail</th>
                <th className="p-3 text-right font-semibold">Qty</th>
                <th className="p-3 font-semibold">By</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {movements.map((m) => {
                const q = Number(m.qty_delta);
                return (
                  <tr key={m.id}>
                    <td className="whitespace-nowrap p-3">{formatDateTime(m.occurred_at)}</td>
                    <td className="p-3">{locName.get(m.location_id)}</td>
                    <td className="p-3">{MOVEMENT_LABELS[m.movement_type] ?? m.movement_type}</td>
                    <td className="p-3 text-muted">{[m.detail, m.notes].filter(Boolean).join(" · ")}</td>
                    <td className={`whitespace-nowrap p-3 text-right font-semibold tabular-nums ${q > 0 ? "text-ok" : ""}`}>
                      {q > 0 ? "+" : ""}
                      {formatQuantity(q, unit)}
                    </td>
                    <td className="p-3 text-muted">{m.who ?? "—"}</td>
                  </tr>
                );
              })}
              {movements.length === 0 && (
                <tr>
                  <td colSpan={6} className="p-4 text-muted">
                    No movements in this period.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
