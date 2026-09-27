import { requirePlatformAdmin } from "@/lib/auth";
import { formatDateTime, formatINR } from "@/lib/format";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { AddOwnerForm, CreateBusinessForm, EditBusinessForm, type PlatformBusiness } from "./forms";

export const metadata = { title: "Businesses" };

interface Row extends PlatformBusiness {
  created_at: string;
  carts: number;
  users: number;
  orders_30d: number;
  sales_30d: string;
  last_order_at: string | null;
}

export default async function PlatformPage() {
  const me = await requirePlatformAdmin();
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("platform_businesses");
  const rows = data as Row[] | null;

  // Owner logins of every business (service role; this page is platform-admin only).
  const { data: owners } = await createAdminClient()
    .from("profiles")
    .select("business_id, full_name, username, is_active")
    .eq("role", "admin")
    .returns<{ business_id: string; full_name: string; username: string; is_active: boolean }[]>();
  const ownersOf = (id: string) => (owners ?? []).filter((o) => o.business_id === id);

  const active = (rows ?? []).filter((b) => b.status === "active");
  const revenue = active.reduce((s, b) => s + Number(b.sales_30d), 0);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-2xl font-bold">Businesses</h1>
        <p className="mt-1 text-sm text-muted">
          Every customer of the app. Each business sees only its own data. Suspending a business blocks all its logins until you
          reactivate it — nothing is deleted.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          ["Businesses", String(rows?.length ?? 0)],
          ["Active", String(active.length)],
          ["Active carts", String(active.reduce((s, b) => s + Number(b.carts), 0))],
          ["Their sales, 30 days", formatINR(revenue.toFixed(0))],
        ].map(([label, value]) => (
          <div key={label} className="card p-4">
            <p className="text-xs font-semibold uppercase text-muted">{label}</p>
            <p className="text-xl font-bold tabular-nums">{value}</p>
          </div>
        ))}
      </div>

      <section className="card p-5">
        <h2 className="mb-1 font-bold">New business</h2>
        <p className="mb-3 text-sm text-muted">Creates the business with Central Storage, its first carts and an owner login.</p>
        <CreateBusinessForm />
      </section>

      {error && <p className="text-danger">Could not load businesses: {error.message}</p>}

      <div className="flex flex-col gap-3">
        {(rows ?? []).map((b) => (
          <article key={b.id} className={`card flex flex-col gap-4 p-5 ${b.status === "suspended" ? "border-danger/40" : ""}`}>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h2 className="text-lg font-bold">{b.name}</h2>
              <span className="rounded-full bg-bg px-2 py-0.5 text-xs font-bold tracking-wider">{b.code}</span>
              {b.status === "suspended" && <span className="rounded-full bg-danger/10 px-2 py-0.5 text-xs font-bold text-danger">SUSPENDED</span>}
              {b.id === me.profile.business_id && <span className="text-xs text-muted">(yours)</span>}
            </div>
            <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-5">
              <div>
                <dt className="text-xs text-muted">Carts</dt>
                <dd className="font-medium tabular-nums">
                  {b.carts}
                  {b.cart_limit !== null && ` / ${b.cart_limit}`}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Users</dt>
                <dd className="font-medium tabular-nums">{b.users}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Orders · sales (30 days)</dt>
                <dd className="font-medium tabular-nums">
                  {b.orders_30d} · {formatINR(Number(b.sales_30d).toFixed(0))}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Last order</dt>
                <dd className="font-medium">{b.last_order_at ? formatDateTime(b.last_order_at) : "—"}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Owners</dt>
                <dd className="font-medium">
                  {ownersOf(b.id)
                    .map((o) => `${o.full_name} (@${o.username})${o.is_active ? "" : " – disabled"}`)
                    .join(", ") || <span className="text-warn">none yet</span>}
                </dd>
              </div>
            </dl>
            <EditBusinessForm business={b} own={b.id === me.profile.business_id} />
            <details>
              <summary className="cursor-pointer text-sm font-semibold text-brand">Add an owner login</summary>
              <div className="mt-3">
                <AddOwnerForm businessId={b.id} />
              </div>
            </details>
          </article>
        ))}
      </div>
    </div>
  );
}
