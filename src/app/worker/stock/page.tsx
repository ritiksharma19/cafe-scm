import Link from "next/link";
import { IncomingTransfer } from "@/components/stock/IncomingTransfer";
import { requireRole } from "@/lib/auth";
import { formatQuantity, type UnitInfo } from "@/lib/quantity";
import { createClient } from "@/lib/supabase/server";
import { loadTransfers } from "@/lib/transfers";

export const metadata = { title: "Stock" };

interface StockRow {
  quantity: string;
  material: { id: string; name: string; display_unit: string } | null;
}

export default async function StockPage() {
  const { location } = await requireRole("worker");
  const supabase = await createClient();

  const [{ data: rows, error }, { data: units }, incoming] = await Promise.all([
    supabase
      .from("stock_levels")
      .select("quantity, material:raw_materials(id, name, display_unit)")
      .eq("location_id", location?.id ?? "")
      .returns<StockRow[]>(),
    supabase.from("units").select("code, factor_to_base").returns<UnitInfo[]>(),
    loadTransfers({ status: "in_transit", toLocationId: location?.id ?? "" }),
  ]);

  const unitByCode = new Map((units ?? []).map((u) => [u.code, u]));
  const items = (rows ?? [])
    .filter((r) => r.material)
    .sort((a, b) => a.material!.name.localeCompare(b.material!.name));

  return (
    <div className="flex flex-col gap-4">
      {incoming.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-bold">Incoming stock ({incoming.length})</h2>
          {incoming.map((t) => (
            <IncomingTransfer key={t.id} transfer={t} />
          ))}
        </section>
      )}

      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-bold">Stock at {location?.name}</h1>
        <Link href="/worker/stock/count" className="btn btn-secondary min-h-11 px-4 text-sm">
          Count stock
        </Link>
      </div>
      {error && <p className="text-danger">Could not load stock. Check the connection and reopen this tab.</p>}
      {!error && items.length === 0 && <p className="card p-5 text-muted">No stock recorded at this cart yet.</p>}
      {items.length > 0 && (
        <ul className="card divide-y divide-line">
          {items.map(({ quantity, material }) => {
            const unit = unitByCode.get(material!.display_unit) ?? { code: material!.display_unit, factor_to_base: 1 };
            const negative = Number(quantity) < 0;
            return (
              <li key={material!.id} className="flex items-center justify-between gap-3 px-4 py-3.5">
                <span className="font-medium">{material!.name}</span>
                <span className={`tabular-nums font-semibold ${negative ? "text-danger" : ""}`}>
                  {formatQuantity(quantity, unit)}
                  {negative && <span className="ml-1.5 text-xs font-bold">CHECK</span>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
