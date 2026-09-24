import "server-only";
import type { TransferView } from "@/components/stock/IncomingTransfer";
import { createClient } from "@/lib/supabase/server";
import type { Unit } from "@/lib/units";

export interface TransferRow extends TransferView {
  status: "in_transit" | "received" | "cancelled";
  from_location_id: string;
  to_location_id: string;
  received_at: string | null;
  items: (TransferView["items"][number] & { qty_received: string | null })[];
}

interface RawTransfer {
  id: string;
  status: TransferRow["status"];
  from_location_id: string;
  to_location_id: string;
  dispatched_at: string;
  received_at: string | null;
  notes: string | null;
  from: { name: string } | null;
  to: { name: string } | null;
  stock_transfer_items: {
    material_id: string;
    qty_sent: string;
    qty_received: string | null;
    material: { name: string; display_unit: string } | null;
  }[];
}

/** Transfers visible to the caller (RLS: own cart as source/destination, or all for admin). */
export async function loadTransfers(filter: {
  status?: TransferRow["status"];
  toLocationId?: string;
  limit?: number;
}): Promise<TransferRow[]> {
  const supabase = await createClient();
  let q = supabase
    .from("stock_transfers")
    .select(
      "id, status, from_location_id, to_location_id, dispatched_at, received_at, notes, from:locations!stock_transfers_from_location_id_fkey(name), to:locations!stock_transfers_to_location_id_fkey(name), stock_transfer_items(material_id, qty_sent, qty_received, material:raw_materials(name, display_unit))",
    )
    .order("dispatched_at", { ascending: false })
    .limit(filter.limit ?? 50);
  if (filter.status) q = q.eq("status", filter.status);
  if (filter.toLocationId) q = q.eq("to_location_id", filter.toLocationId);

  const [{ data, error }, { data: units }] = await Promise.all([
    q.returns<RawTransfer[]>(),
    supabase.from("units").select("code, name, base_code, factor_to_base").returns<Unit[]>(),
  ]);
  if (error) throw new Error(`Could not load transfers: ${error.message}`);
  const unitByCode = new Map((units ?? []).map((u) => [u.code, u]));

  return (data ?? []).map((t) => ({
    id: t.id,
    status: t.status,
    from_location_id: t.from_location_id,
    to_location_id: t.to_location_id,
    from_name: t.from?.name ?? "?",
    to_name: t.to?.name ?? "?",
    dispatched_at: t.dispatched_at,
    received_at: t.received_at,
    notes: t.notes,
    items: t.stock_transfer_items.map((i) => {
      const code = i.material?.display_unit ?? "pcs";
      const unit = unitByCode.get(code);
      return {
        material_id: i.material_id,
        name: i.material?.name ?? "?",
        qty_sent: i.qty_sent,
        qty_received: i.qty_received,
        unit: { code, factor_to_base: unit?.factor_to_base ?? 1 },
      };
    }),
  }));
}
