"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Catalog } from "@/lib/catalog";
import { useRpcSubmit } from "@/lib/useRpcSubmit";
import { LinesEditor, useLines } from "./LinesEditor";
import { SubmitStatus, SuccessBanner } from "./SubmitStatus";

export function RequestForm({ catalog }: { catalog: Catalog }) {
  const router = useRouter();
  const lines = useLines(catalog);
  const rpc = useRpcSubmit<{ status: string }>("create_stock_request", "p_request_id");
  const [neededBy, setNeededBy] = useState("");
  const [notes, setNotes] = useState("");
  const [done, setDone] = useState(false);

  async function send() {
    const items = lines.collect();
    if (!items) return;
    const r = await rpc.submit({
      p_items: items.map((l) => ({ material_id: l.material.id, quantity: l.base })),
      p_needed_by: neededBy || null,
      p_notes: notes || null,
    });
    if (!r) return;
    setDone(true);
    lines.clearAll();
    setNeededBy("");
    setNotes("");
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      {done && <SuccessBanner text="Request sent to the owner" onDone={() => setDone(false)} />}
      <LinesEditor state={lines} disabled={rpc.locked} />
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Needed by</span>
          <input type="date" value={neededBy} onChange={(e) => setNeededBy(e.target.value)} className="field" disabled={rpc.locked} />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Note</span>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} className="field" disabled={rpc.locked} />
        </label>
      </div>
      <SubmitStatus phase={rpc.phase} />
      <div className="flex gap-2">
        {rpc.phase.kind === "unconfirmed" && (
          <button type="button" onClick={rpc.reset} className="btn btn-secondary">
            Discard
          </button>
        )}
        <button type="button" onClick={send} disabled={rpc.phase.kind === "sending"} className="btn btn-primary min-h-14 flex-1 text-lg">
          {rpc.phase.kind === "sending" ? "Sending…" : rpc.phase.kind === "unconfirmed" ? "Retry" : "Send request"}
        </button>
      </div>
    </div>
  );
}
