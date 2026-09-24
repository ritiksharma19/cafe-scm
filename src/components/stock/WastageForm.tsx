"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Catalog } from "@/lib/catalog";
import { formatINR } from "@/lib/format";
import { parseQty, toBase, unitChoices, type Material, type UnitChoice } from "@/lib/units";
import { useRpcSubmit } from "@/lib/useRpcSubmit";
import { WASTAGE_REASONS } from "@/lib/wastage";
import { MaterialPicker } from "./MaterialPicker";
import { QuantityField } from "./QuantityField";
import { SubmitStatus, SuccessBanner } from "./SubmitStatus";

export function WastageForm({ catalog }: { catalog: Catalog }) {
  const router = useRouter();
  const rpc = useRpcSubmit<{ status: string; cost: number }>("record_wastage", "p_wastage_id");
  const [material, setMaterial] = useState<Material | null>(null);
  const [qty, setQty] = useState("");
  const [unit, setUnit] = useState<UnitChoice | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const choices = material ? unitChoices(material, catalog.units, catalog.conversions) : [];

  async function submit() {
    const entered = parseQty(qty);
    if (!material) return setFormError("Choose a raw material.");
    if (entered === null || !unit) return setFormError("Enter a quantity above zero.");
    if (!reason) return setFormError("Choose a reason.");
    if (reason === "other" && !notes.trim()) return setFormError("Add a short note for “Other”.");
    setFormError(null);

    const result = await rpc.submit(
      {
        p_material_id: material.id,
        p_quantity: toBase(entered, unit),
        p_reason: reason,
        p_notes: notes || null,
        p_entered_qty: entered,
        p_entered_unit: unit.code,
      },
      { withOccurredAt: true },
    );
    if (!result) return;
    setDone(`Wastage recorded · ${material.name} ${entered} ${unit.code}${result.cost > 0 ? ` · ${formatINR(result.cost)}` : ""}`);
    setMaterial(null);
    setQty("");
    setUnit(null);
    setReason(null);
    setNotes("");
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      {done && <SuccessBanner text={done} onDone={() => setDone(null)} />}
      <div className="card flex flex-col gap-4 p-4">
        <MaterialPicker
          materials={catalog.materials}
          value={material}
          onChange={(m) => {
            setMaterial(m);
            setUnit(unitChoices(m, catalog.units, catalog.conversions)[0] ?? null);
          }}
          disabled={rpc.locked}
        />
        {material && (
          <QuantityField value={qty} onChange={setQty} unit={unit} onUnitChange={setUnit} choices={choices} disabled={rpc.locked} />
        )}
        <div>
          <span className="mb-1.5 block text-sm font-medium">Reason</span>
          <div role="radiogroup" aria-label="Reason" className="grid grid-cols-3 gap-2">
            {WASTAGE_REASONS.map((r) => (
              <button
                key={r.value}
                type="button"
                role="radio"
                aria-checked={reason === r.value}
                disabled={rpc.locked}
                onClick={() => setReason(r.value)}
                className={`min-h-12 rounded-xl border px-2 text-sm font-semibold ${
                  reason === r.value ? "border-brand bg-brand text-brand-ink" : "border-line bg-surface"
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">
            Note {reason !== "other" && <span className="font-normal text-muted">— optional</span>}
          </span>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} className="field" disabled={rpc.locked} />
        </label>
        {formError && <p className="text-sm font-medium text-danger">{formError}</p>}
      </div>

      <SubmitStatus phase={rpc.phase} />
      <div className="flex gap-2">
        {rpc.phase.kind === "unconfirmed" && (
          <button type="button" onClick={rpc.reset} className="btn btn-secondary">
            Discard
          </button>
        )}
        <button type="button" onClick={submit} disabled={rpc.phase.kind === "sending"} className="btn btn-primary min-h-14 flex-1 text-lg">
          {rpc.phase.kind === "sending" ? "Saving…" : rpc.phase.kind === "unconfirmed" ? "Retry" : "Record wastage"}
        </button>
      </div>
    </div>
  );
}
