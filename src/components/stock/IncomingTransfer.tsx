"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { formatDateTime } from "@/lib/format";
import { formatQuantity } from "@/lib/quantity";
import { isDefinitiveFailure } from "@/lib/sale";
import { createClient } from "@/lib/supabase/client";
import { parseQty } from "@/lib/units";

export interface TransferItemView {
  material_id: string;
  name: string;
  qty_sent: string;
  unit: { code: string; factor_to_base: number | string };
}

export interface TransferView {
  id: string;
  from_name: string;
  to_name: string;
  dispatched_at: string;
  notes: string | null;
  items: TransferItemView[];
}

/** An in-transit transfer the viewer can receive. Receiving is idempotent per transfer. */
export function IncomingTransfer({ transfer }: { transfer: TransferView }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [received, setReceived] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function receive(adjusted: boolean) {
    setError(null);
    const items: { material_id: string; qty_received: number }[] = [];
    if (adjusted) {
      for (const i of transfer.items) {
        const text = received[i.material_id];
        if (text === undefined || text.trim() === "") continue;
        const n = text.trim() === "0" ? 0 : parseQty(text);
        if (n === null) return setError(`Check the quantity for ${i.name}.`);
        const base = Math.round(n * Number(i.unit.factor_to_base) * 1000) / 1000;
        if (base > Number(i.qty_sent)) return setError(`${i.name}: cannot receive more than was sent.`);
        items.push({ material_id: i.material_id, qty_received: base });
      }
    }
    setBusy(true);
    const { error: rpcError } = await createClient().rpc("receive_transfer", {
      p_transfer_id: transfer.id,
      p_items: adjusted ? items : null,
    });
    setBusy(false);
    if (rpcError) {
      setError(isDefinitiveFailure(rpcError) ? rpcError.message : "No reply — check the connection and tap again. It will not be counted twice.");
      return;
    }
    router.refresh();
  }

  return (
    <article className="card flex flex-col gap-3 border-brand p-4">
      <div>
        <p className="font-bold">From {transfer.from_name}</p>
        <p className="text-xs text-muted">Sent {formatDateTime(transfer.dispatched_at)}</p>
        {transfer.notes && <p className="mt-1 text-sm">{transfer.notes}</p>}
      </div>
      <ul className="divide-y divide-line text-sm">
        {transfer.items.map((i) => (
          <li key={i.material_id} className="flex items-center justify-between gap-3 py-2">
            <span className="font-medium">{i.name}</span>
            {editing ? (
              <span className="flex items-center gap-2">
                <input
                  inputMode="decimal"
                  aria-label={`${i.name} received`}
                  placeholder={String(Number(i.qty_sent) / Number(i.unit.factor_to_base))}
                  value={received[i.material_id] ?? ""}
                  onChange={(e) => setReceived((r) => ({ ...r, [i.material_id]: e.target.value }))}
                  className="field h-11 min-h-11 w-24 text-right"
                />
                <span className="w-10 text-muted">{i.unit.code}</span>
              </span>
            ) : (
              <span className="tabular-nums font-semibold">{formatQuantity(i.qty_sent, i.unit)}</span>
            )}
          </li>
        ))}
      </ul>
      {editing && <p className="text-xs text-muted">Enter what actually arrived. Leave blank if it all arrived.</p>}
      {error && <p className="text-sm font-medium text-danger">{error}</p>}
      <div className="flex gap-2">
        <button type="button" onClick={() => setEditing((e) => !e)} disabled={busy} className="btn btn-secondary px-3 text-sm">
          {editing ? "Back" : "Something missing?"}
        </button>
        <button type="button" onClick={() => receive(editing)} disabled={busy} className="btn btn-primary flex-1">
          {busy ? "Saving…" : editing ? "Confirm received" : "Received all"}
        </button>
      </div>
    </article>
  );
}
