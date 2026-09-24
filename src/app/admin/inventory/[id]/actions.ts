"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export interface AdjustResult {
  ok?: string;
  error?: string;
}

export async function adjustStock(_prev: AdjustResult, fd: FormData): Promise<AdjustResult> {
  const materialId = String(fd.get("material_id") ?? "");
  const locationId = String(fd.get("location_id") ?? "");
  const factor = Number(fd.get("factor") ?? 1);
  const qty = Number(String(fd.get("qty") ?? "").trim().replace(",", ".").replace("−", "-"));
  const notes = String(fd.get("notes") ?? "").trim();
  if (!Number.isFinite(qty) || qty === 0) return { error: "Enter a non-zero quantity." };
  if (!notes) return { error: "A reason is required." };

  // admin_adjust_stock() is admin-only and blocks negative stock unless allowed in Settings.
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("admin_adjust_stock", {
    p_location_id: locationId,
    p_material_id: materialId,
    p_qty_delta: Math.round(qty * factor * 1000) / 1000,
    p_type: "MANUAL_ADJUSTMENT",
    p_notes: notes,
  });
  if (error) return { error: error.message };
  revalidatePath(`/admin/inventory/${materialId}`);
  revalidatePath("/admin/inventory");
  return { ok: `Recorded. New balance: ${Number(data) / factor}` };
}
