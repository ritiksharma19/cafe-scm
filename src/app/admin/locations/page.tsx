import Link from "next/link";
import { formatINR } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import type { Location } from "@/lib/types";
import { AddCartForm, EditLocationForm } from "./forms";

export const metadata = { title: "Carts & locations" };

export default async function LocationsPage() {
  const supabase = await createClient();
  const [{ data: locations, error }, { data: workers }, { data: levels }] = await Promise.all([
    supabase.from("locations").select("id, code, name, type, sort_order, is_active").order("sort_order").returns<Location[]>(),
    supabase.from("profiles").select("location_id, full_name").eq("role", "worker").eq("is_active", true).returns<{ location_id: string; full_name: string }[]>(),
    supabase
      .from("stock_levels")
      .select("location_id, quantity, material:raw_materials(avg_unit_cost)")
      .neq("quantity", 0)
      .returns<{ location_id: string; quantity: string; material: { avg_unit_cost: string } | null }[]>(),
  ]);

  const staff = new Map<string, string[]>();
  for (const w of workers ?? []) staff.set(w.location_id, [...(staff.get(w.location_id) ?? []), w.full_name]);
  const value = new Map<string, number>();
  const items = new Map<string, number>();
  for (const l of levels ?? []) {
    value.set(l.location_id, (value.get(l.location_id) ?? 0) + Math.max(0, Number(l.quantity)) * Number(l.material?.avg_unit_cost ?? 0));
    items.set(l.location_id, (items.get(l.location_id) ?? 0) + 1);
  }
  const cartCount = (locations ?? []).filter((l) => l.type === "cart").length;

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-2xl font-bold">Carts &amp; locations</h1>
        <p className="mt-1 text-sm text-muted">
          Every cart is a stock location with its own workers, sales and stock. Central Storage is where purchases usually arrive.
          Nothing is ever deleted: an unused cart is deactivated, and its history stays in reports.
        </p>
      </div>

      <section className="card p-5">
        <h2 className="mb-1 font-bold">Add a cart</h2>
        <p className="mb-3 text-sm text-muted">
          Then add a worker for it under{" "}
          <Link href="/admin/users" className="font-semibold text-brand hover:underline">
            Users
          </Link>{" "}
          and send it opening stock from Central Storage (Transfers).
        </p>
        <AddCartForm suggestion={`Cart ${cartCount + 1}`} />
      </section>

      {error && <p className="text-danger">Could not load locations: {error.message}</p>}

      <div className="flex flex-col gap-3">
        {(locations ?? []).map((l) => {
          const people = staff.get(l.id) ?? [];
          return (
            <article key={l.id} className={`card flex flex-col gap-4 p-5 ${l.is_active ? "" : "opacity-70"}`}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <h2 className="text-lg font-bold">{l.name}</h2>
                <span className="rounded-full bg-bg px-2 py-0.5 text-xs font-bold uppercase">{l.type === "central" ? "Central" : "Cart"}</span>
                <span className="text-xs text-muted">{l.code}</span>
                {!l.is_active && <span className="rounded-full bg-danger/10 px-2 py-0.5 text-xs font-bold text-danger">INACTIVE</span>}
              </div>
              <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
                <div>
                  <dt className="text-xs text-muted">Workers</dt>
                  <dd className="font-medium">{people.length ? people.join(", ") : l.type === "cart" && l.is_active ? <span className="text-warn">None yet</span> : "—"}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">Stock value</dt>
                  <dd className="font-medium tabular-nums">
                    {formatINR((value.get(l.id) ?? 0).toFixed(0))} · {items.get(l.id) ?? 0} items
                  </dd>
                </div>
                <div className="flex items-end gap-3">
                  <Link href={`/admin/inventory?location=${l.id}`} className="text-sm font-semibold text-brand hover:underline">
                    Stock →
                  </Link>
                  <Link href={`/admin/analytics?location=${l.id}`} className="text-sm font-semibold text-brand hover:underline">
                    Profit →
                  </Link>
                </div>
              </dl>
              <EditLocationForm location={l} />
            </article>
          );
        })}
      </div>
      <p className="text-xs text-muted">
        To deactivate a cart: move or disable its workers, send its remaining stock back to Central Storage, and receive or cancel
        transfers on the way. The app checks all three.
      </p>
    </div>
  );
}
