import { createClient } from "@/lib/supabase/server";
import type { Location, Profile } from "@/lib/types";
import { CreateWorkerForm, EditWorkerForm, ResetPinForm } from "./forms";

export const metadata = { title: "Users" };

export default async function UsersPage() {
  const supabase = await createClient();
  const [{ data: profiles }, { data: locations }] = await Promise.all([
    supabase
      .from("profiles")
      .select("id, username, full_name, role, location_id, is_active, created_at")
      .order("role")
      .order("full_name")
      .returns<Profile[]>(),
    supabase.from("locations").select("id, code, name, type, sort_order, is_active").order("sort_order").returns<Location[]>(),
  ]);

  const carts = (locations ?? []).filter((l) => l.type === "cart" && l.is_active);
  const locationName = new Map((locations ?? []).map((l) => [l.id, l.name]));

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold">Users</h1>

      <section className="card p-5">
        <h2 className="mb-4 font-bold">Add worker</h2>
        <CreateWorkerForm carts={carts} />
      </section>

      <section className="flex flex-col gap-3">
        {(profiles ?? []).map((p) => (
          <article key={p.id} className="card p-5">
            <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1">
              <h2 className="text-lg font-bold">{p.full_name}</h2>
              <span className="text-sm text-muted">@{p.username}</span>
              <span className="rounded-full bg-bg px-2 py-0.5 text-xs font-bold uppercase">{p.role}</span>
              {!p.is_active && (
                <span className="rounded-full bg-danger/10 px-2 py-0.5 text-xs font-bold text-danger">DISABLED</span>
              )}
              {p.location_id && <span className="text-sm text-muted">· {locationName.get(p.location_id)}</span>}
            </div>
            {p.role === "worker" ? (
              <div className="grid gap-5 lg:grid-cols-[2fr_1fr]">
                <EditWorkerForm profile={p} carts={carts} />
                <ResetPinForm userId={p.id} />
              </div>
            ) : (
              <p className="text-sm text-muted">Admin accounts are managed from the Supabase dashboard.</p>
            )}
          </article>
        ))}
      </section>
    </div>
  );
}
