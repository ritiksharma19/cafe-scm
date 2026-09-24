import { ActionForm } from "@/components/ActionForm";
import { CountForm } from "@/components/stock/CountForm";
import { loadCatalog } from "@/lib/catalog";
import { formatDateTime, formatINR } from "@/lib/format";
import { formatQuantity } from "@/lib/quantity";
import { createClient } from "@/lib/supabase/server";
import { approveCount, rejectCount } from "../stock-actions";

export const metadata = { title: "Stock counts" };

interface CountRow {
  id: string;
  counted_at: string;
  status: "draft" | "posted" | "rejected";
  notes: string | null;
  review_note: string | null;
  location: { name: string } | null;
  counter: { full_name: string } | null;
  stock_count_items: {
    material_id: string;
    expected_qty: string;
    counted_qty: string;
    variance: string;
    material: { name: string; display_unit: string; avg_unit_cost: string } | null;
  }[];
}

export default async function CountsPage({ searchParams }: PageProps<"/admin/counts">) {
  const params = await searchParams;
  const supabase = await createClient();
  const [catalog, { data: counts, error }] = await Promise.all([
    loadCatalog(),
    supabase
      .from("stock_counts")
      .select(
        "id, counted_at, status, notes, review_note, location:locations(name), counter:profiles!stock_counts_counted_by_fkey(full_name), stock_count_items(material_id, expected_qty, counted_qty, variance, material:raw_materials(name, display_unit, avg_unit_cost))",
      )
      .order("counted_at", { ascending: false })
      .limit(40)
      .returns<CountRow[]>(),
  ]);
  const unitByCode = new Map(catalog.units.map((u) => [u.code, u]));
  const unitFor = (code: string) => unitByCode.get(code) ?? { code, factor_to_base: 1 };
  const locationId =
    typeof params.location === "string" && catalog.locations.some((l) => l.id === params.location)
      ? params.location
      : (catalog.locations.find((l) => l.type === "central")?.id ?? "");
  const countMaterials = catalog.materials.map((m) => ({ id: m.id, name: m.name, unit: unitFor(m.display_unit) }));
  const drafts = (counts ?? []).filter((c) => c.status === "draft");
  const reviewed = (counts ?? []).filter((c) => c.status !== "draft");

  const CountCard = ({ c }: { c: CountRow }) => {
    const differing = c.stock_count_items.filter((i) => Number(i.variance) !== 0);
    const value = differing.reduce((s, i) => s + Number(i.variance) * Number(i.material?.avg_unit_cost ?? 0), 0);
    return (
      <article className="card flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="font-bold">
            {c.location?.name} <span className="font-normal text-muted">· {c.counter?.full_name}</span>
          </p>
          <span className="text-xs text-muted">{formatDateTime(c.counted_at)}</span>
        </div>
        <p className="text-sm">
          {c.stock_count_items.length} items counted · {differing.length} differ
          {differing.length > 0 && (
            <span className={`ml-2 font-semibold ${value < 0 ? "text-danger" : "text-ok"}`}>
              Inventory variance {value < 0 ? "−" : "+"}
              {formatINR(Math.abs(value).toFixed(2))}
            </span>
          )}
        </p>
        {differing.length > 0 && (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase text-muted">
                <th className="pb-1 font-semibold">Material</th>
                <th className="pb-1 text-right font-semibold">Expected</th>
                <th className="pb-1 text-right font-semibold">Counted</th>
                <th className="pb-1 text-right font-semibold">Variance</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {differing.map((i) => {
                const u = unitFor(i.material?.display_unit ?? "");
                return (
                  <tr key={i.material_id}>
                    <td className="py-1.5">{i.material?.name}</td>
                    <td className="py-1.5 text-right tabular-nums">{formatQuantity(i.expected_qty, u)}</td>
                    <td className="py-1.5 text-right tabular-nums">{formatQuantity(i.counted_qty, u)}</td>
                    <td className={`py-1.5 text-right font-semibold tabular-nums ${Number(i.variance) < 0 ? "text-danger" : "text-ok"}`}>
                      {Number(i.variance) > 0 ? "+" : ""}
                      {formatQuantity(i.variance, u)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {c.notes && <p className="text-sm">“{c.notes}”</p>}
        {c.status === "draft" ? (
          <div className="flex flex-col gap-2">
            <ActionForm action={approveCount} id={c.id} label="Approve & correct stock" tone="primary" reason={{ placeholder: "Note — optional" }} />
            <ActionForm action={rejectCount} id={c.id} label="Reject" tone="danger" reason={{ placeholder: "Reason", required: true }} />
          </div>
        ) : (
          <p className={`text-sm font-semibold ${c.status === "posted" ? "text-ok" : "text-danger"}`}>
            {c.status === "posted" ? "Approved — stock corrected" : "Rejected"}
            {c.review_note && <span className="font-normal text-muted"> · {c.review_note}</span>}
          </p>
        )}
      </article>
    );
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold">Stock counts</h1>
        <p className="mt-1 text-sm text-muted">
          Variance = counted − expected at the moment of counting. It is labelled “inventory variance” only; causes can
          include recipe differences, unrecorded wastage or counting errors.
        </p>
      </div>
      {error && <p className="text-danger">Could not load counts: {error.message}</p>}

      <section className="flex flex-col gap-3">
        <h2 className="font-bold">Waiting for approval ({drafts.length})</h2>
        {drafts.length === 0 && <p className="card p-4 text-muted">No counts waiting.</p>}
        <div className="grid gap-3 lg:grid-cols-2">
          {drafts.map((c) => (
            <CountCard key={c.id} c={c} />
          ))}
        </div>
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <div className="flex flex-col gap-3">
          <h2 className="font-bold">Count a location yourself</h2>
          <form className="flex items-end gap-2">
            <label className="block flex-1">
              <span className="mb-1.5 block text-sm font-medium">Location</span>
              <select name="location" defaultValue={locationId} className="field">
                {catalog.locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className="btn btn-secondary">
              Choose
            </button>
          </form>
          <p className="text-xs text-muted">Admin counts are applied immediately.</p>
          <CountForm key={locationId} materials={countMaterials} locationId={locationId} />
        </div>
        <div className="flex flex-col gap-3">
          <h2 className="font-bold">Recently reviewed</h2>
          {reviewed.length === 0 && <p className="card p-4 text-muted">Nothing yet.</p>}
          {reviewed.map((c) => (
            <CountCard key={c.id} c={c} />
          ))}
        </div>
      </section>
    </div>
  );
}
