import { formatINR } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import type { Location } from "@/lib/types";
import type { Unit } from "@/lib/units";
import { LocationLevelsForm, MaterialForm, type MaterialRow } from "./forms";

export const metadata = { title: "Raw materials" };

export default async function MaterialsPage() {
  const supabase = await createClient();
  const [{ data: materials }, { data: units }, { data: suppliers }, { data: locations }, { data: levels }] = await Promise.all([
    supabase
      .from("raw_materials")
      .select("id, name, base_unit, display_unit, min_level, reorder_level, target_level, lead_time_days, default_supplier_id, avg_unit_cost, is_active")
      .order("is_active", { ascending: false })
      .order("name")
      .returns<MaterialRow[]>(),
    supabase.from("units").select("code, name, base_code, factor_to_base").order("sort_order").returns<Unit[]>(),
    supabase.from("suppliers").select("id, name").eq("is_active", true).order("name").returns<{ id: string; name: string }[]>(),
    supabase.from("locations").select("id, code, name, type, sort_order, is_active").eq("is_active", true).order("sort_order").returns<Location[]>(),
    supabase
      .from("location_material_settings")
      .select("location_id, material_id, min_level, reorder_level, target_level")
      .returns<{ location_id: string; material_id: string; min_level: string; reorder_level: string; target_level: string | null }[]>(),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold">Raw materials</h1>
        <p className="mt-1 text-sm text-muted">
          Business-wide levels drive the dashboard alerts. Optional per-location levels drive each cart&apos;s alerts. Costs
          update automatically from priced purchases (weighted average).
        </p>
      </div>

      <section className="card p-5">
        <h2 className="mb-4 font-bold">Add raw material</h2>
        <MaterialForm units={units ?? []} suppliers={suppliers ?? []} />
      </section>

      <section className="flex flex-col gap-3">
        {(materials ?? []).map((m) => {
          const unit = (units ?? []).find((u) => u.code === m.display_unit);
          const factor = Number(unit?.factor_to_base ?? 1);
          const current = Object.fromEntries((levels ?? []).filter((l) => l.material_id === m.id).map((l) => [l.location_id, l]));
          return (
            <article key={m.id} className={`card ${m.is_active ? "" : "opacity-70"}`}>
              <details>
                <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-4 gap-y-1 p-4">
                  <span className="min-w-0 flex-1 font-bold">
                    {m.name}
                    {!m.is_active && <span className="ml-2 text-xs text-danger">INACTIVE</span>}
                  </span>
                  <span className="text-sm text-muted">
                    Cost {formatINR((Number(m.avg_unit_cost) * factor).toFixed(2))}/{m.display_unit}
                  </span>
                  <span className="text-sm text-muted">
                    Reorder at {Number(m.reorder_level) > 0 ? `${Number(m.reorder_level) / factor} ${m.display_unit}` : "—"}
                  </span>
                </summary>
                <div className="flex flex-col gap-5 border-t border-line p-4">
                  <MaterialForm material={m} units={units ?? []} suppliers={suppliers ?? []} />
                  <div>
                    <h3 className="mb-2 text-sm font-bold">Per-location levels (optional)</h3>
                    <LocationLevelsForm
                      materialId={m.id}
                      unit={{ code: m.display_unit, factor }}
                      locations={locations ?? []}
                      current={current}
                    />
                  </div>
                </div>
              </details>
            </article>
          );
        })}
      </section>
    </div>
  );
}
