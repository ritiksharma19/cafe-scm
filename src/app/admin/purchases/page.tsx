import { ActionForm } from "@/components/ActionForm";
import { ReceiptForm } from "@/components/stock/ReceiptForm";
import { loadCatalog } from "@/lib/catalog";
import { formatDateTime, formatINR } from "@/lib/format";
import { formatQuantity } from "@/lib/quantity";
import { createClient } from "@/lib/supabase/server";
import { voidReceipt } from "../stock-actions";

export const metadata = { title: "Purchases" };

interface ReceiptRow {
  id: string;
  occurred_at: string;
  status: "posted" | "voided";
  total_cost: string;
  invoice_ref: string | null;
  notes: string | null;
  void_reason: string | null;
  location: { name: string } | null;
  supplier: { name: string } | null;
  receiver: { full_name: string } | null;
  purchase_receipt_items: {
    id: string;
    quantity: string;
    line_cost: string | null;
    material: { name: string; display_unit: string } | null;
  }[];
}

export default async function PurchasesPage() {
  const supabase = await createClient();
  const [catalog, { data: receipts, error }] = await Promise.all([
    loadCatalog(),
    supabase
      .from("purchase_receipts")
      .select(
        "id, occurred_at, status, total_cost, invoice_ref, notes, void_reason, location:locations(name), supplier:suppliers(name), receiver:profiles!purchase_receipts_received_by_fkey(full_name), purchase_receipt_items(id, quantity, line_cost, material:raw_materials(name, display_unit))",
      )
      .order("occurred_at", { ascending: false })
      .limit(60)
      .returns<ReceiptRow[]>(),
  ]);
  const unitByCode = new Map(catalog.units.map((u) => [u.code, u]));

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold">Purchases</h1>
      <div className="grid gap-6 lg:grid-cols-[1fr_1.3fr]">
        <section className="flex flex-col gap-3">
          <h2 className="font-bold">Record a purchase</h2>
          <ReceiptForm catalog={catalog} chooseLocation />
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="font-bold">Recent receipts</h2>
          {error && <p className="text-danger">Could not load receipts: {error.message}</p>}
          {receipts?.length === 0 && <p className="card p-4 text-muted">No purchases recorded yet.</p>}
          <ul className="flex flex-col gap-2">
            {(receipts ?? []).map((r) => (
              <li key={r.id} className={`card ${r.status === "voided" ? "opacity-70" : ""}`}>
                <details>
                  <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 p-4">
                    <span className="text-sm font-semibold">{formatDateTime(r.occurred_at)}</span>
                    <span className="text-sm text-muted">{r.location?.name}</span>
                    <span className="min-w-0 flex-1 text-sm">
                      {r.purchase_receipt_items.map((i) => i.material?.name).join(", ")}
                    </span>
                    {r.status === "voided" && (
                      <span className="rounded-full bg-danger/10 px-2 py-0.5 text-xs font-bold text-danger">VOIDED</span>
                    )}
                    <span className="font-semibold tabular-nums">{Number(r.total_cost) > 0 ? formatINR(r.total_cost) : "—"}</span>
                  </summary>
                  <div className="flex flex-col gap-3 border-t border-line p-4 text-sm">
                    <p className="text-muted">
                      By {r.receiver?.full_name ?? "?"}
                      {r.supplier && ` · ${r.supplier.name}`}
                      {r.invoice_ref && ` · Bill ${r.invoice_ref}`}
                      {r.notes && ` · ${r.notes}`}
                    </p>
                    <ul className="divide-y divide-line">
                      {r.purchase_receipt_items.map((i) => {
                        const code = i.material?.display_unit ?? "";
                        const unit = unitByCode.get(code) ?? { code, factor_to_base: 1 };
                        return (
                          <li key={i.id} className="flex justify-between gap-3 py-1.5">
                            <span>{i.material?.name}</span>
                            <span className="tabular-nums">
                              {formatQuantity(i.quantity, unit)}
                              {i.line_cost !== null && <span className="ml-3 text-muted">{formatINR(i.line_cost)}</span>}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                    {r.status === "voided" ? (
                      <p className="text-danger">Voided: {r.void_reason}</p>
                    ) : (
                      <ActionForm action={voidReceipt} id={r.id} label="Void receipt" tone="danger" reason={{ placeholder: "Reason", required: true }} />
                    )}
                  </div>
                </details>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
