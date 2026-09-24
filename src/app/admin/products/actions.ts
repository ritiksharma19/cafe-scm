"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export interface ProductResult {
  ok?: boolean;
  error?: string;
}

export async function updateProduct(_prev: ProductResult, formData: FormData): Promise<ProductResult> {
  const id = String(formData.get("id") ?? "");
  const price = Number(formData.get("selling_price"));
  const sortOrder = Number(formData.get("sort_order") ?? 0);
  if (!Number.isFinite(price) || price < 0) return { error: "Enter a valid price." };
  if (!Number.isInteger(sortOrder)) return { error: "Order must be a whole number." };

  // RLS allows this update for admins only; the audit trigger records the change.
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("products")
    .update({
      selling_price: Math.round(price * 100) / 100,
      sort_order: sortOrder,
      is_active: formData.get("is_active") === "on",
    })
    .eq("id", id)
    .select("id");
  if (error) return { error: error.message };
  if (!data?.length) return { error: "Not allowed or product not found." };

  revalidatePath("/admin/products");
  revalidatePath("/worker");
  return { ok: true };
}
