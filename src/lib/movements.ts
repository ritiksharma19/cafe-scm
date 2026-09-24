import "server-only";
import { createClient } from "@/lib/supabase/server";

export const MOVEMENT_LABELS: Record<string, string> = {
  OPENING_BALANCE: "Opening stock",
  PURCHASE: "Purchase / receipt",
  PURCHASE_REVERSAL: "Receipt voided",
  SALE_CONSUMPTION: "Used in sale",
  SALE_REVERSAL: "Sale voided",
  TRANSFER_OUT: "Transfer out",
  TRANSFER_IN: "Transfer in",
  TRANSFER_CANCEL: "Transfer cancelled",
  WASTAGE: "Wastage",
  WASTAGE_REVERSAL: "Wastage voided",
  COUNT_ADJUSTMENT: "Stock count correction",
  MANUAL_ADJUSTMENT: "Admin adjustment",
};

export interface MovementView {
  id: string;
  occurred_at: string;
  location_id: string;
  qty_delta: string;
  movement_type: string;
  unit_cost: string | null;
  notes: string | null;
  who: string | null;
  detail: string | null; // e.g. "Burger × 3", "Central Storage → Cart 1", "Spoiled"
}

interface Raw {
  id: string;
  occurred_at: string;
  location_id: string;
  qty_delta: string;
  movement_type: string;
  unit_cost: string | null;
  notes: string | null;
  ref_type: string;
  ref_id: string | null;
  creator: { full_name: string } | null;
}

/** Ledger rows for one material, each explained by the document that caused it. */
export async function loadMovements(opts: {
  materialId: string;
  from: Date;
  to: Date;
  locationId?: string | null;
  limit?: number;
}): Promise<MovementView[]> {
  const supabase = await createClient();
  let q = supabase
    .from("stock_movements")
    .select("id, occurred_at, location_id, qty_delta, movement_type, unit_cost, notes, ref_type, ref_id, creator:profiles!stock_movements_created_by_fkey(full_name)")
    .eq("material_id", opts.materialId)
    .gte("occurred_at", opts.from.toISOString())
    .lt("occurred_at", opts.to.toISOString())
    .order("occurred_at", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(opts.limit ?? 300);
  if (opts.locationId) q = q.eq("location_id", opts.locationId);
  const { data, error } = await q.returns<Raw[]>();
  if (error) throw new Error(`Could not load movements: ${error.message}`);
  const rows = data ?? [];

  const idsOf = (type: string) => [...new Set(rows.filter((r) => r.ref_type === type && r.ref_id).map((r) => r.ref_id!))];
  const [orderItems, transferItems, wastage, receiptItems] = await Promise.all([
    idsOf("order_item").length
      ? supabase.from("order_items").select("id, quantity, product:products(name)").in("id", idsOf("order_item"))
          .returns<{ id: string; quantity: number; product: { name: string } | null }[]>()
      : { data: [] },
    idsOf("transfer_item").length
      ? supabase
          .from("stock_transfer_items")
          .select("id, transfer:stock_transfers(from:locations!stock_transfers_from_location_id_fkey(name), to:locations!stock_transfers_to_location_id_fkey(name))")
          .in("id", idsOf("transfer_item"))
          .returns<{ id: string; transfer: { from: { name: string } | null; to: { name: string } | null } | null }[]>()
      : { data: [] },
    idsOf("wastage").length
      ? supabase.from("wastage").select("id, reason").in("id", idsOf("wastage")).returns<{ id: string; reason: string }[]>()
      : { data: [] },
    idsOf("receipt_item").length
      ? supabase
          .from("purchase_receipt_items")
          .select("id, receipt:purchase_receipts(invoice_ref, supplier:suppliers(name))")
          .in("id", idsOf("receipt_item"))
          .returns<{ id: string; receipt: { invoice_ref: string | null; supplier: { name: string } | null } | null }[]>()
      : { data: [] },
  ]);

  const detail = new Map<string, string>();
  for (const o of orderItems.data ?? []) detail.set(o.id, `${o.product?.name ?? "?"} × ${o.quantity}`);
  for (const t of transferItems.data ?? []) detail.set(t.id, `${t.transfer?.from?.name ?? "?"} → ${t.transfer?.to?.name ?? "?"}`);
  for (const w of wastage.data ?? []) detail.set(w.id, w.reason.replace("_", " "));
  for (const r of receiptItems.data ?? []) {
    const parts = [r.receipt?.supplier?.name, r.receipt?.invoice_ref ? `bill ${r.receipt.invoice_ref}` : null].filter(Boolean);
    if (parts.length) detail.set(r.id, parts.join(" · "));
  }

  return rows.map((r) => ({
    id: r.id,
    occurred_at: r.occurred_at,
    location_id: r.location_id,
    qty_delta: r.qty_delta,
    movement_type: r.movement_type,
    unit_cost: r.unit_cost,
    notes: r.notes,
    who: r.creator?.full_name ?? null,
    detail: r.ref_id ? (detail.get(r.ref_id) ?? null) : null,
  }));
}
