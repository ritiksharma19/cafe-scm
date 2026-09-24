"use client";

import { useState } from "react";
import { formatINR } from "@/lib/format";
import { parseQty, toBase, unitChoices, type Conversion, type Material, type Unit, type UnitChoice } from "@/lib/units";
import { MaterialPicker } from "./MaterialPicker";
import { QuantityField } from "./QuantityField";

export interface StockLine {
  key: string;
  material: Material;
  unit: UnitChoice;
  entered: number;
  base: number;
  cost: number | null; // ₹ paid for the whole line
}

export interface LinesCatalog {
  materials: Material[];
  units: Unit[];
  conversions: Conversion[];
}

/** State for a multi-item stock document: added lines plus the line being typed. */
export function useLines(catalog: LinesCatalog, opts: { withCost?: boolean } = {}) {
  const [lines, setLines] = useState<StockLine[]>([]);
  const [material, setMaterial] = useState<Material | null>(null);
  const [qty, setQty] = useState("");
  const [unit, setUnit] = useState<UnitChoice | null>(null);
  const [cost, setCost] = useState("");
  const [draftError, setDraftError] = useState<string | null>(null);

  const choices = material ? unitChoices(material, catalog.units, catalog.conversions) : [];
  const draftStarted = material !== null || qty.trim() !== "";

  function pickMaterial(m: Material) {
    setMaterial(m);
    setUnit(unitChoices(m, catalog.units, catalog.conversions)[0] ?? null);
    setDraftError(null);
  }

  function fail(message: string): null {
    setDraftError(message);
    return null;
  }

  /** Validates the draft line. Returns it, or null (and sets an error) if incomplete. */
  function draftLine(): StockLine | null {
    if (!material) return fail("Choose a raw material.");
    const entered = parseQty(qty);
    if (entered === null || !unit) return fail("Enter a quantity above zero.");
    let lineCost: number | null = null;
    if (opts.withCost && cost.trim() !== "") {
      const c = Number(cost.replace(",", "."));
      if (!Number.isFinite(c) || c < 0) return fail("Enter a valid price, or leave it empty.");
      lineCost = Math.round(c * 100) / 100;
    }
    return { key: `${material.id}-${Date.now()}`, material, unit, entered, base: toBase(entered, unit), cost: lineCost };
  }

  function clearDraft() {
    setMaterial(null);
    setQty("");
    setUnit(null);
    setCost("");
    setDraftError(null);
  }

  function addDraft(): boolean {
    const line = draftLine();
    if (!line) return false;
    setLines((l) => [...l, line]);
    clearDraft();
    return true;
  }

  /** All lines to submit: added lines plus the draft if one was started. Null if the draft is invalid. */
  function collect(): StockLine[] | null {
    if (!draftStarted) {
      if (lines.length === 0) return fail("Add at least one item.");
      return lines;
    }
    const line = draftLine();
    return line ? [...lines, line] : null;
  }

  function clearAll() {
    setLines([]);
    clearDraft();
  }

  return {
    catalog, withCost: !!opts.withCost, lines, setLines, material, pickMaterial, qty, setQty, unit, setUnit,
    cost, setCost, choices, draftError, addDraft, collect, clearAll,
  };
}

export type LinesState = ReturnType<typeof useLines>;

export function formatLine(l: StockLine): string {
  return `${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 3 }).format(l.entered)} ${l.unit.code}`;
}

export function LinesEditor({ state, disabled, addLabel = "Add another item" }: { state: LinesState; disabled?: boolean; addLabel?: string }) {
  return (
    <div className="flex flex-col gap-4">
      {state.lines.length > 0 && (
        <ul className="card divide-y divide-line">
          {state.lines.map((l) => (
            <li key={l.key} className="flex items-center gap-3 px-4 py-3">
              <span className="min-w-0 flex-1 font-medium">{l.material.name}</span>
              <span className="tabular-nums font-semibold">{formatLine(l)}</span>
              {l.cost !== null && <span className="text-sm text-muted tabular-nums">{formatINR(l.cost)}</span>}
              <button
                type="button"
                disabled={disabled}
                onClick={() => state.setLines((ls) => ls.filter((x) => x.key !== l.key))}
                aria-label={`Remove ${l.material.name}`}
                className="flex size-10 items-center justify-center rounded-full text-xl text-muted hover:bg-bg"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="card flex flex-col gap-4 p-4">
        <MaterialPicker materials={state.catalog.materials} value={state.material} onChange={state.pickMaterial} disabled={disabled} />
        {state.material && (
          <QuantityField
            value={state.qty}
            onChange={state.setQty}
            unit={state.unit}
            onUnitChange={state.setUnit}
            choices={state.choices}
            disabled={disabled}
          />
        )}
        {state.material && state.withCost && (
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">
              Price paid (₹) <span className="font-normal text-muted">— optional, total for this item</span>
            </span>
            <input
              value={state.cost}
              onChange={(e) => state.setCost(e.target.value)}
              inputMode="decimal"
              placeholder="e.g. 450"
              disabled={disabled}
              className="field"
            />
          </label>
        )}
        {state.draftError && <p className="text-sm font-medium text-danger">{state.draftError}</p>}
        {state.material && (
          <button type="button" onClick={state.addDraft} disabled={disabled} className="btn btn-secondary">
            + {addLabel}
          </button>
        )}
      </div>
    </div>
  );
}
