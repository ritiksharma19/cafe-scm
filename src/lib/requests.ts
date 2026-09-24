import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { Unit } from "@/lib/units";

export type RequestStatus = "pending" | "approved" | "fulfilled" | "rejected" | "cancelled";

export interface RequestRow {
  id: string;
  location_id: string;
  location_name: string;
  requested_by_name: string;
  status: RequestStatus;
  needed_by: string | null;
  notes: string | null;
  resolution_note: string | null;
  created_at: string;
  items: { material_id: string; name: string; quantity: string; unit: { code: string; factor_to_base: number | string } }[];
}

interface Raw {
  id: string;
  location_id: string;
  status: RequestStatus;
  needed_by: string | null;
  notes: string | null;
  resolution_note: string | null;
  created_at: string;
  location: { name: string } | null;
  requester: { full_name: string } | null;
  stock_request_items: { material_id: string; quantity: string; material: { name: string; display_unit: string } | null }[];
}

/** Stock requests visible to the caller (RLS: own cart, or all for admin). */
export async function loadRequests(filter: { statuses?: RequestStatus[]; limit?: number } = {}): Promise<RequestRow[]> {
  const supabase = await createClient();
  let q = supabase
    .from("stock_requests")
    .select(
      "id, location_id, status, needed_by, notes, resolution_note, created_at, location:locations(name), requester:profiles!stock_requests_requested_by_fkey(full_name), stock_request_items(material_id, quantity, material:raw_materials(name, display_unit))",
    )
    .order("created_at", { ascending: false })
    .limit(filter.limit ?? 50);
  if (filter.statuses) q = q.in("status", filter.statuses);

  const [{ data, error }, { data: units }] = await Promise.all([
    q.returns<Raw[]>(),
    supabase.from("units").select("code, name, base_code, factor_to_base").returns<Unit[]>(),
  ]);
  if (error) throw new Error(`Could not load requests: ${error.message}`);
  const unitByCode = new Map((units ?? []).map((u) => [u.code, u]));

  return (data ?? []).map((r) => ({
    id: r.id,
    location_id: r.location_id,
    location_name: r.location?.name ?? "?",
    requested_by_name: r.requester?.full_name ?? "?",
    status: r.status,
    needed_by: r.needed_by,
    notes: r.notes,
    resolution_note: r.resolution_note,
    created_at: r.created_at,
    items: r.stock_request_items.map((i) => {
      const code = i.material?.display_unit ?? "pcs";
      return {
        material_id: i.material_id,
        name: i.material?.name ?? "?",
        quantity: i.quantity,
        unit: { code, factor_to_base: unitByCode.get(code)?.factor_to_base ?? 1 },
      };
    }),
  }));
}

export const REQUEST_STATUS_STYLE: Record<RequestStatus, string> = {
  pending: "bg-warn/10 text-warn",
  approved: "bg-brand/10 text-brand",
  fulfilled: "bg-ok/10 text-ok",
  rejected: "bg-danger/10 text-danger",
  cancelled: "bg-bg text-muted",
};

export const REQUEST_STATUS_LABEL: Record<RequestStatus, string> = {
  pending: "WAITING",
  approved: "ON THE WAY",
  fulfilled: "DONE",
  rejected: "REJECTED",
  cancelled: "CANCELLED",
};
