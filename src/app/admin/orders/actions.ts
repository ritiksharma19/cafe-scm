"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export interface VoidResult {
  error?: string;
}

export async function voidOrder(_prev: VoidResult, formData: FormData): Promise<VoidResult> {
  const orderId = String(formData.get("order_id") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!reason) return { error: "Enter a reason." };

  // Authorization is enforced by void_order() in the database (admin only).
  const supabase = await createClient();
  const { error } = await supabase.rpc("void_order", { p_order_id: orderId, p_reason: reason });
  if (error) return { error: error.message };

  revalidatePath("/admin/orders");
  return {};
}
