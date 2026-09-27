// Labels for payment methods and expense categories (enums in migration 20260930000001).

export const PAYMENT_METHODS = [
  { value: "cash", label: "Cash" },
  { value: "upi", label: "UPI" },
  { value: "card", label: "Card" },
  { value: "other", label: "Other" },
] as const;

export type PaymentMethod = (typeof PAYMENT_METHODS)[number]["value"];

export const EXPENSE_CATEGORIES = [
  { value: "rent", label: "Rent" },
  { value: "salaries", label: "Salaries & wages" },
  { value: "utilities", label: "Electricity & water" },
  { value: "gas_fuel", label: "Gas & fuel" },
  { value: "packaging", label: "Packaging & disposables" },
  { value: "maintenance", label: "Repairs & cleaning" },
  { value: "transport", label: "Transport" },
  { value: "marketing", label: "Marketing" },
  { value: "fees_taxes", label: "Fees, licences & taxes" },
  { value: "other", label: "Other" },
] as const;

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number]["value"];

const paymentLabel = new Map<string, string>(PAYMENT_METHODS.map((p) => [p.value, p.label]));
const categoryLabel = new Map<string, string>(EXPENSE_CATEGORIES.map((c) => [c.value, c.label]));

export const paymentMethodLabel = (v: string) => paymentLabel.get(v) ?? v;
export const expenseCategoryLabel = (v: string) => categoryLabel.get(v) ?? v;

/** "72.5%" / "−12%" / "—" when there is no base (no sales). */
export function formatPct(pct: number | string | null | undefined): string {
  if (pct === null || pct === undefined) return "—";
  const n = Number(pct);
  return `${n < 0 ? "−" : ""}${Math.abs(n).toLocaleString("en-IN", { maximumFractionDigits: 1 })}%`;
}

/** Largest discount (₹) a worker may give on an order of `gross` ₹ — same rounding as record_sale. */
export function maxDiscount(gross: number, limitPct: number): number {
  return Math.round(gross * limitPct) / 100;
}
