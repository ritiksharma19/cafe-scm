import { createClient } from "@/lib/supabase/server";
import { SupplierForm } from "./SupplierForm";

export const metadata = { title: "Suppliers" };

export interface SupplierRow {
  id: string;
  name: string;
  phone: string | null;
  notes: string | null;
  is_active: boolean;
}

export default async function SuppliersPage() {
  const supabase = await createClient();
  const { data: suppliers, error } = await supabase
    .from("suppliers")
    .select("id, name, phone, notes, is_active")
    .order("is_active", { ascending: false })
    .order("name")
    .returns<SupplierRow[]>();

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold">Suppliers</h1>
      <section className="card p-5">
        <h2 className="mb-4 font-bold">Add supplier</h2>
        <SupplierForm />
      </section>
      {error && <p className="text-danger">Could not load suppliers: {error.message}</p>}
      <section className="flex flex-col gap-3">
        {(suppliers ?? []).map((s) => (
          <article key={s.id} className={`card p-5 ${s.is_active ? "" : "opacity-70"}`}>
            <SupplierForm supplier={s} />
          </article>
        ))}
        {suppliers?.length === 0 && <p className="card p-4 text-muted">No suppliers yet.</p>}
      </section>
    </div>
  );
}
