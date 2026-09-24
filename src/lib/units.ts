/** Catalog shapes shared by server loaders and client forms. */
export interface Material {
  id: string;
  name: string;
  base_unit: string;
  display_unit: string;
  is_active: boolean;
}

export interface Unit {
  code: string;
  name: string;
  base_code: string;
  factor_to_base: string | number;
}

export interface Conversion {
  material_id: string;
  unit_label: string;
  factor_to_base: string | number;
}

export interface UnitChoice {
  code: string;
  factor: number;
}

/**
 * Units a quantity of this material can be entered in: every unit that converts to its
 * base unit (g ↔ kg, ml ↔ l, pcs ↔ dozen) plus its own packaging (e.g. "pack" = 6 pcs).
 * The display unit comes first so it is the default.
 */
export function unitChoices(material: Material, units: Unit[], conversions: Conversion[] = []): UnitChoice[] {
  const choices: UnitChoice[] = units
    .filter((u) => u.base_code === material.base_unit)
    .map((u) => ({ code: u.code, factor: Number(u.factor_to_base) }));
  for (const c of conversions) {
    if (c.material_id === material.id && !choices.some((x) => x.code === c.unit_label)) {
      choices.push({ code: c.unit_label, factor: Number(c.factor_to_base) });
    }
  }
  return choices.sort((a, b) => Number(b.code === material.display_unit) - Number(a.code === material.display_unit));
}

/** Entered quantity → base-unit quantity, rounded to 3 decimals (matches numeric(14,3)). */
export function toBase(qty: number, choice: UnitChoice): number {
  return Math.round(qty * choice.factor * 1000) / 1000;
}

/** Parses a user-typed quantity ("2", "2.5", "2,5"). Returns null if not a positive number. */
export function parseQty(text: string): number | null {
  const n = Number(text.trim().replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : null;
}
