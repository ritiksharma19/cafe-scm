"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Catalog } from "@/lib/catalog";
import { useRpcSubmit } from "@/lib/useRpcSubmit";
import { LinesEditor, useLines } from "./LinesEditor";
import { SubmitStatus, SuccessBanner } from "./SubmitStatus";

/**
 * Sends stock between locations. Workers send from their own cart (fixedFromId);
 * the admin chooses both ends. Stock leaves the source now and arrives when received.
 */
export function TransferForm({ catalog, fixedFromId }: { catalog: Catalog; fixedFromId?: string }) {
  const router = useRouter();
  const lines = useLines(catalog);
  const rpc = useRpcSubmit<{ status: string }>("create_transfer", "p_transfer_id");
  const central = catalog.locations.find((l) => l.type === "central");
  const [fromId, setFromId] = useState(fixedFromId ?? central?.id ?? "");
  const [toId, setToId] = useState(
    fixedFromId ? (central?.id ?? "") : (catalog.locations.find((l) => l.type === "cart")?.id ?? ""),
  );
  const [notes, setNotes] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const name = (id: string) => catalog.locations.find((l) => l.id === id)?.name ?? "?";

  async function send() {
    if (fromId === toId) return setFormError("Choose two different locations.");
    setFormError(null);
    const items = lines.collect();
    if (!items) return;
    const r = await rpc.submit({
      p_from_location_id: fromId,
      p_to_location_id: toId,
      p_items: items.map((l) => ({ material_id: l.material.id, quantity: l.base })),
      p_notes: notes || null,
      p_request_id: null,
    });
    if (!r) return;
    setDone(`Sent ${items.length} item${items.length === 1 ? "" : "s"} from ${name(fromId)} to ${name(toId)}`);
    lines.clearAll();
    setNotes("");
    router.refresh();
  }

  const locationSelect = (label: string, value: string, onChange: (v: string) => void) => (
    <label className="block flex-1">
      <span className="mb-1.5 block text-sm font-medium">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="field" disabled={rpc.locked}>
        {catalog.locations.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div className="flex flex-col gap-4">
      {done && <SuccessBanner text={done} onDone={() => setDone(null)} />}
      <div className="flex flex-col gap-3 sm:flex-row">
        {fixedFromId ? (
          <p className="flex-1 text-sm">
            <span className="mb-1.5 block font-medium">From</span>
            <span className="field flex items-center font-semibold">{name(fixedFromId)}</span>
          </p>
        ) : (
          locationSelect("From", fromId, setFromId)
        )}
        {locationSelect("To", toId, setToId)}
      </div>
      <LinesEditor state={lines} disabled={rpc.locked} />
      <label className="block">
        <span className="mb-1.5 block text-sm font-medium">Note — optional</span>
        <input value={notes} onChange={(e) => setNotes(e.target.value)} className="field" disabled={rpc.locked} />
      </label>
      {formError && <p className="text-sm font-medium text-danger">{formError}</p>}
      <SubmitStatus phase={rpc.phase} />
      <div className="flex gap-2">
        {rpc.phase.kind === "unconfirmed" && (
          <button type="button" onClick={rpc.reset} className="btn btn-secondary">
            Discard
          </button>
        )}
        <button type="button" onClick={send} disabled={rpc.phase.kind === "sending"} className="btn btn-primary min-h-14 flex-1 text-lg">
          {rpc.phase.kind === "sending" ? "Sending…" : rpc.phase.kind === "unconfirmed" ? "Retry" : "Send stock"}
        </button>
      </div>
    </div>
  );
}
