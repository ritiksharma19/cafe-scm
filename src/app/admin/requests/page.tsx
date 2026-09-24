import { ActionForm } from "@/components/ActionForm";
import { LiveRefresh } from "@/components/LiveRefresh";
import { formatDateTime } from "@/lib/format";
import { formatQuantity } from "@/lib/quantity";
import { loadRequests, REQUEST_STATUS_LABEL, REQUEST_STATUS_STYLE } from "@/lib/requests";
import { createClient } from "@/lib/supabase/server";
import { markRequestFulfilled, rejectRequest, sendRequestFromCentral } from "../stock-actions";

export const metadata = { title: "Stock requests" };

export default async function AdminRequestsPage() {
  const supabase = await createClient();
  const [open, closed, { data: centralStock }] = await Promise.all([
    loadRequests({ statuses: ["pending", "approved"], limit: 100 }),
    loadRequests({ statuses: ["fulfilled", "rejected", "cancelled"], limit: 30 }),
    supabase
      .from("stock_levels")
      .select("material_id, quantity, location:locations!inner(type)")
      .eq("location.type", "central")
      .returns<{ material_id: string; quantity: string }[]>(),
  ]);
  const atCentral = new Map((centralStock ?? []).map((s) => [s.material_id, Number(s.quantity)]));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3"><h1 className="text-2xl font-bold">Stock requests</h1><LiveRefresh tables={["stock_requests", "stock_transfers"]} /></div>

      <section className="flex flex-col gap-3">
        <h2 className="font-bold">Open ({open.length})</h2>
        {open.length === 0 && <p className="card p-4 text-muted">No open requests.</p>}
        <div className="grid gap-3 lg:grid-cols-2">
          {open.map((r) => (
            <article key={r.id} className="card flex flex-col gap-3 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-bold">
                  {r.location_name} <span className="font-normal text-muted">· {r.requested_by_name}</span>
                </p>
                <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${REQUEST_STATUS_STYLE[r.status]}`}>
                  {REQUEST_STATUS_LABEL[r.status]}
                </span>
              </div>
              <p className="text-xs text-muted">
                {formatDateTime(r.created_at)}
                {r.needed_by && ` · needed by ${r.needed_by}`}
              </p>
              <ul className="divide-y divide-line text-sm">
                {r.items.map((i) => {
                  const available = atCentral.get(i.material_id) ?? 0;
                  const enough = available >= Number(i.quantity);
                  return (
                    <li key={i.material_id} className="flex justify-between gap-3 py-1.5">
                      <span>{i.name}</span>
                      <span className="tabular-nums">
                        <b>{formatQuantity(i.quantity, i.unit)}</b>
                        <span className={`ml-2 text-xs ${enough ? "text-muted" : "font-bold text-danger"}`}>
                          Central has {formatQuantity(available, i.unit)}
                        </span>
                      </span>
                    </li>
                  );
                })}
              </ul>
              {r.notes && <p className="text-sm">“{r.notes}”</p>}
              {r.status === "pending" ? (
                <div className="flex flex-col gap-2">
                  <ActionForm action={sendRequestFromCentral} id={r.id} label="Send from Central Storage" tone="primary" />
                  <ActionForm action={markRequestFulfilled} id={r.id} label="Mark done (bought locally)" reason={{ placeholder: "Note — optional" }} />
                  <ActionForm action={rejectRequest} id={r.id} label="Reject" tone="danger" reason={{ placeholder: "Reason", required: true }} />
                </div>
              ) : (
                <p className="text-sm text-muted">On the way — completes when the cart taps “Received”.</p>
              )}
            </article>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-bold">Recently closed</h2>
        <ul className="card divide-y divide-line">
          {closed.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
              <span>
                <b>{r.location_name}</b> · {r.items.map((i) => `${i.name} ${formatQuantity(i.quantity, i.unit)}`).join(", ")}
                {r.resolution_note && <span className="text-muted"> — {r.resolution_note}</span>}
              </span>
              <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${REQUEST_STATUS_STYLE[r.status]}`}>
                {REQUEST_STATUS_LABEL[r.status]}
              </span>
            </li>
          ))}
          {closed.length === 0 && <li className="p-4 text-muted">Nothing yet.</li>}
        </ul>
      </section>
    </div>
  );
}
