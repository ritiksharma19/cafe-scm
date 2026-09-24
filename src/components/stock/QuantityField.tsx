"use client";

import type { UnitChoice } from "@/lib/units";

/** Numeric keypad input with unit chips (kg / g, l / ml, pcs / dozen / pack…). */
export function QuantityField({
  value,
  onChange,
  unit,
  onUnitChange,
  choices,
  disabled,
  label = "Quantity",
}: {
  value: string;
  onChange: (v: string) => void;
  unit: UnitChoice | null;
  onUnitChange: (u: UnitChoice) => void;
  choices: UnitChoice[];
  disabled?: boolean;
  label?: string;
}) {
  return (
    <div>
      <span className="mb-1.5 block text-sm font-medium">{label}</span>
      <div className="flex gap-2">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          inputMode="decimal"
          enterKeyHint="done"
          placeholder="0"
          disabled={disabled}
          aria-label={label}
          className="field min-w-0 flex-1 text-xl font-bold tabular-nums"
        />
        <div role="radiogroup" aria-label="Unit" className="flex shrink-0 gap-1.5">
          {choices.map((c) => (
            <button
              key={c.code}
              type="button"
              role="radio"
              aria-checked={unit?.code === c.code}
              disabled={disabled}
              onClick={() => onUnitChange(c)}
              className={`min-h-12 min-w-12 rounded-xl border px-3 text-sm font-bold ${
                unit?.code === c.code ? "border-brand bg-brand text-brand-ink" : "border-line bg-surface text-ink"
              }`}
            >
              {c.code}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
