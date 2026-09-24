"use client";

import { useActionState, useState } from "react";
import type { Unit } from "@/lib/units";
import { saveLocationLevels, saveMaterial, type MaterialResult } from "./actions";

export interface MaterialRow {
  id: string;
  name: string;
  base_unit: string;
  display_unit: string;
  min_level: string;
  reorder_level: string;
  target_level: string | null;
  lead_time_days: number;
  default_supplier_id: string | null;
  avg_unit_cost: string;
  is_active: boolean;
}

function Feedback({ state }: { state: MaterialResult }) {
  if (state.error) return <p className="text-sm font-medium text-danger">{state.error}</p>;
  if (state.ok) return <p className="text-sm font-medium text-ok">{state.ok}</p>;
  return null;
}

/** Base-unit number → display-unit string for form defaults ("" for zero/empty). */
const shown = (v: string | null, factor: number) => (v === null || Number(v) === 0 ? "" : String(Number(v) / factor));

export function MaterialForm({
  material,
  units,
  suppliers,
}: {
  material?: MaterialRow;
  units: Unit[];
  suppliers: { id: string; name: string }[];
}) {
  const [state, action, pending] = useActionState<MaterialResult, FormData>(saveMaterial, {});
  const [base, setBase] = useState(material?.base_unit ?? "g");
  const choices = units.filter((u) => u.base_code === base);
  const [displayUnit, setDisplayUnit] = useState(material?.display_unit ?? choices[0]?.code ?? base);
  const factor = Number(units.find((u) => u.code === displayUnit)?.factor_to_base ?? 1);

  return (
    <form action={action} className="flex flex-col gap-3">
      {material && <input type="hidden" name="id" value={material.id} />}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Name</span>
          <input name="name" defaultValue={material?.name} className="field" required />
        </label>
        {!material && (
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">Measured in</span>
            <select
              name="base_unit"
              value={base}
              onChange={(e) => {
                setBase(e.target.value);
                setDisplayUnit(units.find((u) => u.base_code === e.target.value)?.code ?? e.target.value);
              }}
              className="field"
            >
              <option value="g">Weight (g / kg)</option>
              <option value="ml">Volume (ml / l)</option>
              <option value="pcs">Pieces</option>
            </select>
          </label>
        )}
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Show quantities in</span>
          <select name="display_unit" value={displayUnit} onChange={(e) => setDisplayUnit(e.target.value)} className="field">
            {choices.map((u) => (
              <option key={u.code} value={u.code}>
                {u.name} ({u.code})
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Default supplier</span>
          <select name="default_supplier_id" defaultValue={material?.default_supplier_id ?? ""} className="field">
            <option value="">None</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          ["min_level", "Minimum (critical)", material?.min_level ?? null],
          ["reorder_level", "Reorder level (low)", material?.reorder_level ?? null],
          ["target_level", "Target stock", material?.target_level ?? null],
        ].map(([name, label, value]) => (
          <label key={name} className="block">
            <span className="mb-1.5 block text-sm font-medium">
              {label} <span className="font-normal text-muted">({displayUnit})</span>
            </span>
            <input name={name!} defaultValue={shown(value, factor)} inputMode="decimal" className="field" placeholder="—" />
          </label>
        ))}
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Lead time (days)</span>
          <input name="lead_time_days" defaultValue={material?.lead_time_days ?? 1} inputMode="numeric" className="field" />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-4">
        {material && (
          <label className="flex min-h-11 items-center gap-2">
            <input type="checkbox" name="is_active" defaultChecked={material.is_active} className="size-5 accent-brand" />
            <span className="text-sm font-medium">Active</span>
          </label>
        )}
        <button type="submit" disabled={pending} className={material ? "btn btn-secondary" : "btn btn-primary"}>
          {pending ? "Saving…" : material ? "Save" : "Add material"}
        </button>
        <Feedback state={state} />
      </div>
    </form>
  );
}

export function LocationLevelsForm({
  materialId,
  unit,
  locations,
  current,
}: {
  materialId: string;
  unit: { code: string; factor: number };
  locations: { id: string; name: string }[];
  current: Record<string, { min_level: string; reorder_level: string; target_level: string | null }>;
}) {
  const [state, action, pending] = useActionState<MaterialResult, FormData>(saveLocationLevels, {});
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="material_id" value={materialId} />
      <input type="hidden" name="factor" value={unit.factor} />
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase text-muted">
            <th className="pb-1 font-semibold">Location</th>
            <th className="pb-1 font-semibold">Minimum ({unit.code})</th>
            <th className="pb-1 font-semibold">Reorder ({unit.code})</th>
            <th className="pb-1 font-semibold">Target ({unit.code})</th>
          </tr>
        </thead>
        <tbody>
          {locations.map((l) => {
            const c = current[l.id];
            return (
              <tr key={l.id}>
                <td className="py-1 pr-2">
                  <input type="hidden" name="location_id" value={l.id} />
                  {l.name}
                </td>
                {(["min", "reorder", "target"] as const).map((k) => (
                  <td key={k} className="py-1 pr-2">
                    <input
                      name={`${k}_${l.id}`}
                      inputMode="decimal"
                      defaultValue={shown(c ? (k === "min" ? c.min_level : k === "reorder" ? c.reorder_level : c.target_level) : null, unit.factor)}
                      className="field h-10 min-h-10"
                      placeholder="—"
                      aria-label={`${l.name} ${k}`}
                    />
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className="btn btn-secondary min-h-10 text-sm">
          {pending ? "Saving…" : "Save location levels"}
        </button>
        <Feedback state={state} />
      </div>
    </form>
  );
}
