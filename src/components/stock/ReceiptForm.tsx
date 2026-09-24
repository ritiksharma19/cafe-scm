"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Catalog } from "@/lib/catalog";
import { formatINR } from "@/lib/format";
import { useRpcSubmit } from "@/lib/useRpcSubmit";
import { LinesEditor, useLines } from "./LinesEditor";
import { SubmitStatus, SuccessBanner } from "./SubmitStatus";

interface ReceiptResult {
  status: "created" | "duplicate";
  total_cost: number;
  lines?: number;
}

/** Worker: receives into their own cart. Admin (chooseLocation): picks any location, e.g. Central Storage. */
export function ReceiptForm({ catalog, chooseLocation = false }: { catalog: Catalog; chooseLocation?: boolean }) {
  const router = useRouter();
  const lines = useLines(catalog, { withCost: true });
  const rpc = useRpcSubmit<ReceiptResult>("record_receipt", "p_receipt_id");
  const [locationId, setLocationId] = useState(
    chooseLocation ? (catalog.locations.find((l) => l.type === "central")?.id ?? "") : "",
  );
  const [supplierId, setSupplierId] = useState("");
  const [invoice, setInvoice] = useState("");
  const [notes, setNotes] = useState("");
  const [showMore, setShowMore] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  async function confirm() {
    const items = lines.collect();
    if (!items) return;
    const result = await rpc.submit(
      {
        p_items: items.map((l) => ({
          material_id: l.material.id,
          quantity: l.base,
          entered_qty: l.entered,
          entered_unit: l.unit.code,
          line_cost: l.cost,
        })),
        p_supplier_id: supplierId || null,
        p_invoice_ref: invoice || null,
        p_notes: notes || null,
        p_location_id: chooseLocation ? locationId : null,
      },
      { withOccurredAt: true },
    );
    if (!result) return;
    const count = items.length;
    setDone(
      `Stock received · ${count} item${count === 1 ? "" : "s"}${result.total_cost > 0 ? ` · ${formatINR(result.total_cost)}` : ""}`,
    );
    lines.clearAll();
    setSupplierId("");
    setInvoice("");
    setNotes("");
    setShowMore(false);
    navigator.vibrate?.([15, 40, 15]);
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      {done && <SuccessBanner text={done} onDone={() => setDone(null)} />}

      {chooseLocation && (
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Received at</span>
          <select value={locationId} onChange={(e) => setLocationId(e.target.value)} className="field">
            {catalog.locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
      )}

      <LinesEditor state={lines} disabled={rpc.locked} />

      <button type="button" onClick={() => setShowMore((s) => !s)} className="self-start text-sm font-semibold text-brand">
        {showMore ? "Hide" : "Add"} supplier / bill details
      </button>
      {showMore && (
        <div className="card flex flex-col gap-3 p-4">
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">Supplier</span>
            <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} className="field" disabled={rpc.locked}>
              <option value="">Not specified</option>
              {catalog.suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">Bill / invoice number</span>
            <input value={invoice} onChange={(e) => setInvoice(e.target.value)} className="field" disabled={rpc.locked} />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">Notes</span>
            <input value={notes} onChange={(e) => setNotes(e.target.value)} className="field" disabled={rpc.locked} />
          </label>
        </div>
      )}

      <SubmitStatus phase={rpc.phase} />
      <div className="flex gap-2">
        {rpc.phase.kind === "unconfirmed" && (
          <button type="button" onClick={rpc.reset} className="btn btn-secondary">
            Discard
          </button>
        )}
        <button
          type="button"
          onClick={confirm}
          disabled={rpc.phase.kind === "sending"}
          className="btn btn-primary min-h-14 flex-1 text-lg"
        >
          {rpc.phase.kind === "sending" ? "Saving…" : rpc.phase.kind === "unconfirmed" ? "Retry" : "Confirm receipt"}
        </button>
      </div>
    </div>
  );
}
