import "server-only";
import type { StockStatus } from "@/components/StatusPill";
import { createClient } from "@/lib/supabase/server";

// Typed wrappers around the admin-only analytics RPCs (see migration 20260927000001).
// Postgres numeric arrives as string (or number inside jsonb); callers convert for display.

export interface StockStatusRow {
  material_id: string;
  name: string;
  base_unit: string;
  display_unit: string;
  quantity: string;
  avg_daily_use: string | null;
  days_of_data: number;
  days_left: string | null;
  min_level: string | null;
  reorder_level: string | null;
  target_level: string | null;
  lead_time_days: number;
  status: StockStatus;
  suggested_reorder: string | null;
  unit_cost: string;
  stock_value: string;
}

export interface PeriodTotals {
  orders: number;
  items: number;
  sales: number;
  wastage_cost: number;
  consumption_cost: number;
  purchases: number;
}

export interface DashboardSummary {
  current: PeriodTotals;
  previous: PeriodTotals;
  carts: { location_id: string; name: string; orders: number; items: number; sales: number; wastage_cost: number; negative_items: number }[];
  pending_requests: number;
  in_transit: number;
  oldest_in_transit: string | null;
  stale_in_transit: number;
  counts_to_review: number;
  negative_stock: number;
}

export interface MaterialFlowRow {
  material_id: string;
  name: string;
  base_unit: string;
  display_unit: string;
  consumed: string;
  consumed_cost: string;
  wasted: string;
  wasted_cost: string;
  purchased: string;
  purchased_cost: string;
  transfer_in: string;
  transfer_out: string;
  count_adjust: string;
  count_adjust_cost: string;
  current_qty: string;
}

export interface DailyRow {
  day: string;
  orders: number;
  items: number;
  sales: string;
  consumption_cost: string;
  wastage_cost: string;
  purchase_cost: string;
}

export interface ProductCostRow {
  product_id: string;
  name: string;
  selling_price: string;
  cost_now: string;
  cost_then: string | null;
  then_complete: boolean;
  ingredients: { material: string; base_unit: string; qty_now: number | null; qty_then: number | null; cost_now: number; cost_then: number | null }[];
}

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as T;
}

const period = (from: Date, to: Date, locationId?: string | null) => ({
  p_from: from.toISOString(),
  p_to: to.toISOString(),
  ...(locationId !== undefined ? { p_location_id: locationId || null } : {}),
});

export const getStockStatus = (locationId: string | null = null) =>
  rpc<StockStatusRow[]>("stock_status", { p_location_id: locationId });
export const getDashboardSummary = (from: Date, to: Date) => rpc<DashboardSummary>("dashboard_summary", period(from, to));
export const getProductSales = (from: Date, to: Date, locationId: string | null) =>
  rpc<{ product_id: string; name: string; quantity: number; sales: string; orders: number }[]>("product_sales", period(from, to, locationId));
export const getMaterialFlow = (from: Date, to: Date, locationId: string | null) =>
  rpc<MaterialFlowRow[]>("material_flow", period(from, to, locationId));
export const getDailyTrend = (from: Date, to: Date, locationId: string | null) =>
  rpc<DailyRow[]>("daily_trend", period(from, to, locationId));
export const getHourlyOrders = (from: Date, to: Date, locationId: string | null) =>
  rpc<{ hour: number; orders: number; items: number }[]>("hourly_orders", period(from, to, locationId));
export const getProductCosts = (compareAt: Date) => rpc<ProductCostRow[]>("product_costs", { p_compare_at: compareAt.toISOString() });
export const getPurchasesByMaterial = (from: Date, to: Date) =>
  rpc<
    {
      material_id: string;
      name: string;
      base_unit: string;
      display_unit: string;
      quantity: string;
      value: string;
      receipts: number;
      last_unit_cost: string | null;
      last_date: string | null;
      prev_unit_cost: string | null;
    }[]
  >("purchases_by_material", period(from, to));
export const getPurchasesBySupplier = (from: Date, to: Date) =>
  rpc<{ supplier_id: string | null; name: string; receipts: number; value: string; materials: string[]; last_date: string }[]>(
    "purchases_by_supplier",
    period(from, to),
  );

/** "+12%" / "−5%" / null when there is no base to compare with. */
export function pctChange(now: number, before: number): string | null {
  if (before === 0) return null;
  const pct = Math.round(((now - before) / before) * 100);
  return `${pct > 0 ? "+" : pct < 0 ? "−" : "±"}${Math.abs(pct)}%`;
}
