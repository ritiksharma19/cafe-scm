"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { formatQuantity } from "@/lib/quantity";
import { useRpcSubmit } from "@/lib/useRpcSubmit";
import { SubmitStatus } from "./SubmitStatus";

export interface CountMaterial {
  id: string;
  name: string;
  unit: { code: string; factor_to_base: number | string };
}

interface CountResult {
  status: string;
  count_status: "draft" | "posted";
  variances: { material: string; expected: number; counted: number; variance: number }[];
}

/**
 * Blind count: expected quantities are NOT shown while counting, so people count what is
 * really there. Only filled-in lines are submitted.
 */
export function CountForm({ materials, locationId }: { materials: CountMaterial[]; locationId?: string }) {
  const router = useRouter();
  const rpc = useRpcSubmit<CountResult>("submit_stock_count", "p_count_id");
  const [values, setValues] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [result, setResult] = useState<CountResult | null>(null);

  const unitOf = new Map(materials.map((m) => [m.name, m.unit]));

  async function submit() {
    const items: { material_id: string; counted_qty: number }[] = [];
    for (const m of materials) {
      const text = values[m.id]?.trim();
      if (!text) continue;
      const n = Number(text.replace(",", "."));
      if (!Number.isFinite(n) || n < 0) return setFormError(`Check the count for ${m.name}.`);
      items.push({ material_id: m.id, counted_qty: Math.round(n * Number(m.unit.factor_to_base) * 1000) / 1000 });
    }
    if (items.length === 0) return setFormError("Enter at least one count.");
    setFormError(null);
    const r = await rpc.submit({ p_items: items, p_notes: notes || null, p_location_id: locationId ?? null });
    if (!r) return;
    setResult(r);
    setValues({});
    setNotes("");
    router.refresh();
  }

  if (result) {
    return (
      <div className="flex flex-col gap-3">
        <div role="status" className="rounded-xl bg-ok px-4 py-3 font-bold text-brand-ink">
          ✓ {result.count_status === "posted" ? "Count posted — stock updated." : "Count sent to the owner for approval."}
        </div>
        {result.variances.length === 0 ? (
          <p className="card p-4">Everything matched the expected stock.</p>
        ) : (
          <ul className="card divide-y divide-line">
            {result.variances.map((v) => {
              const unit = unitOf.get(v.material) ?? { code: "", factor_to_base: 1 };
              return (
                <li key={v.material} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                  <span className="font-medium">{v.material}</span>
                  <span className="text-right tabular-nums">
                    expected {formatQuantity(v.expected, unit)} · counted {formatQuantity(v.counted, unit)}
                    <span className={`ml-2 font-bold ${v.variance < 0 ? "text-danger" : "text-ok"}`}>
                      {v.variance > 0 ? "+" : ""}
                      {formatQuantity(v.variance, unit)}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <button type="button" onClick={() => setResult(null)} className="btn btn-secondary">
          New count
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <ul className="card divide-y divide-line">
        {materials.map((m) => (
          <li key={m.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
            <label htmlFor={`count-${m.id}`} className="min-w-0 flex-1 font-medium">
              {m.name}
            </label>
            <input
              id={`count-${m.id}`}
              inputMode="decimal"
              value={values[m.id] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [m.id]: e.target.value }))}
              disabled={rpc.locked}
              className="field h-11 min-h-11 w-24 text-right tabular-nums"
            />
            <span className="w-12 text-sm text-muted">{m.unit.code}</span>
          </li>
        ))}
      </ul>
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
        <button type="button" onClick={submit} disabled={rpc.phase.kind === "sending"} className="btn btn-primary min-h-14 flex-1 text-lg">
          {rpc.phase.kind === "sending" ? "Saving…" : rpc.phase.kind === "unconfirmed" ? "Retry" : "Submit count"}
        </button>
      </div>
    </div>
  );
}
