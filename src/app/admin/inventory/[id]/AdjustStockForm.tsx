"use client";

import { useActionState } from "react";
import type { Location } from "@/lib/types";
import { adjustStock, type AdjustResult } from "./actions";

export function AdjustStockForm({
  materialId,
  locations,
  unit,
}: {
  materialId: string;
  locations: Location[];
  unit: { code: string; factor: number };
}) {
  const [state, action, pending] = useActionState<AdjustResult, FormData>(adjustStock, {});
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="material_id" value={materialId} />
      <input type="hidden" name="factor" value={unit.factor} />
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Location</span>
          <select name="location_id" className="field" required>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Change ({unit.code}, use − to remove)</span>
          <input name="qty" inputMode="decimal" placeholder="e.g. -1.5" className="field" required />
        </label>
      </div>
      <label className="block">
        <span className="mb-1.5 block text-sm font-medium">Reason</span>
        <input name="notes" className="field" placeholder="Required" required />
      </label>
      <button type="submit" disabled={pending} className="btn btn-secondary self-start">
        {pending ? "Saving…" : "Record adjustment"}
      </button>
      {state.error && <p className="text-sm font-medium text-danger">{state.error}</p>}
      {state.ok && <p className="text-sm font-medium text-ok">{state.ok}</p>}
    </form>
  );
}
