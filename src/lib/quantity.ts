/**
 * Quantities are stored in the material's base unit (g / ml / pcs) as Postgres numeric,
 * which arrives in JS as a string. Conversion here is for DISPLAY only; all arithmetic
 * that changes stock happens in the database.
 */

export interface UnitInfo {
  code: string;
  factor_to_base: number | string;
}

const nf = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 3 });

/** Formats a base-unit quantity in the given display unit, e.g. 2500 g → "2.5 kg". */
export function formatQuantity(baseQty: number | string, display: UnitInfo): string {
  const factor = Number(display.factor_to_base);
  const value = Number(baseQty) / (factor > 0 ? factor : 1);
  return `${nf.format(value)} ${display.code}`;
}

/** Converts an entered quantity (e.g. 2 kg) to the base unit (2000 g), rounded to 3 decimals. */
export function toBaseQuantity(qty: number, unit: UnitInfo): number {
  return Math.round(qty * Number(unit.factor_to_base) * 1000) / 1000;
}
