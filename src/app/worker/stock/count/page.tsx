import Link from "next/link";
import { CountForm } from "@/components/stock/CountForm";
import { requireRole } from "@/lib/auth";
import { loadCatalog } from "@/lib/catalog";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Count stock" };

export default async function CountPage() {
  const { location } = await requireRole("worker");
  const supabase = await createClient();
  const [catalog, { data: stocked }] = await Promise.all([
    loadCatalog(),
    supabase.from("stock_levels").select("material_id").eq("location_id", location?.id ?? "").returns<{ material_id: string }[]>(),
  ]);

  // Materials this cart has ever held come first; everything else follows.
  const held = new Set((stocked ?? []).map((s) => s.material_id));
  const unitByCode = new Map(catalog.units.map((u) => [u.code, u]));
  const materials = [...catalog.materials]
    .sort((a, b) => Number(held.has(b.id)) - Number(held.has(a.id)) || a.name.localeCompare(b.name))
    .map((m) => ({ id: m.id, name: m.name, unit: { code: m.display_unit, factor_to_base: unitByCode.get(m.display_unit)?.factor_to_base ?? 1 } }));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <h1 className="text-xl font-bold">Count stock</h1>
        <Link href="/worker/stock" className="text-sm font-semibold text-brand">
          Back
        </Link>
      </div>
      <p className="text-sm text-muted">
        Count what is physically at the cart and fill in only the items you counted. The owner approves the count
        before stock is corrected.
      </p>
      <CountForm materials={materials} />
    </div>
  );
}
