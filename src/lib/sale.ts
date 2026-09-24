export interface SaleResult {
  status: "created" | "duplicate";
  order_id: string;
  item_count: number;
  total_amount: number;
  negative_materials: string[];
}

/**
 * A Postgres/PostgREST error means the server answered and the transaction rolled back:
 * the order was definitely NOT saved. Anything else (fetch failure, timeout, 5xx gateway)
 * leaves the outcome unknown, so the client must retry with the SAME order id.
 */
export function isDefinitiveFailure(error: { code?: string } | null | undefined): boolean {
  if (!error?.code) return false;
  return /^[0-9A-Z]{5}$/.test(error.code) || error.code.startsWith("PGRST");
}
