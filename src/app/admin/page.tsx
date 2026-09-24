import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import type { Location, Profile } from "@/lib/types";

export const metadata = { title: "Dashboard" };

export default async function AdminDashboard() {
  const supabase = await createClient();
  const [{ data: locations }, { data: profiles }, { count: productCount }, { count: materialCount }] =
    await Promise.all([
      supabase.from("locations").select("id, code, name, type, sort_order, is_active").order("sort_order").returns<Location[]>(),
      supabase.from("profiles").select("id, full_name, username, role, location_id, is_active").returns<Profile[]>(),
      supabase.from("products").select("id", { count: "exact", head: true }),
      supabase.from("raw_materials").select("id", { count: "exact", head: true }),
    ]);

  const workersAt = (locationId: string) =>
    (profiles ?? []).filter((p) => p.role === "worker" && p.is_active && p.location_id === locationId);
  const carts = (locations ?? []).filter((l) => l.type === "cart");

  const setup = [
    { done: carts.every((c) => workersAt(c.id).length > 0), label: "Every cart has a worker", href: "/admin/users" },
    { done: (materialCount ?? 0) > 0, label: "Raw materials imported", href: null },
    { done: (productCount ?? 0) > 0, label: "Products and recipes imported", href: null },  ];

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold">Dashboard</h1>

      <section className="card p-5">
        <h2 className="mb-3 font-bold">Setup</h2>
        <ul className="flex flex-col gap-2">
          {setup.map((s) => (
            <li key={s.label} className="flex items-center gap-3">
              <span
                className={`inline-flex h-6 min-w-12 items-center justify-center rounded-full px-2 text-xs font-bold ${
                  s.done ? "bg-ok/10 text-ok" : "bg-warn/10 text-warn"
                }`}
              >
                {s.done ? "DONE" : "TO DO"}
              </span>
              {s.href && !s.done ? (
                <Link href={s.href} className="font-medium underline underline-offset-2">
                  {s.label}
                </Link>
              ) : (
                <span className="font-medium">{s.label}</span>
              )}
              {!s.href && !s.done && <span className="text-sm text-muted">(sample data: <code>npm run seed:sample</code> · Excel import screen: Phase 5)</span>}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="mb-3 font-bold">Locations</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {(locations ?? []).map((loc) => {
            const workers = workersAt(loc.id);
            return (
              <div key={loc.id} className="card p-4">
                <p className="text-xs font-bold uppercase tracking-wide text-muted">{loc.type === "central" ? "Storage" : "Cart"}</p>
                <p className="text-lg font-bold">{loc.name}</p>
                <p className="mt-2 text-sm text-muted">
                  {loc.type === "central"
                    ? "Managed by admin"
                    : workers.length > 0
                      ? workers.map((w) => w.full_name).join(", ")
                      : "No worker assigned"}
                </p>
              </div>
            );
          })}
        </div>
      </section>

      <p className="text-sm text-muted">Sales, stock alerts and runway appear here from Phase 4.</p>
    </div>
  );
}
