"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
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
      category: String(formData.get("category") ?? "").trim() || null,
      variant_label: String(formData.get("variant_label") ?? "").trim() || null,
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

export async function createProduct(_prev: ProductResult, formData: FormData): Promise<ProductResult> {
  const name = String(formData.get("name") ?? "").trim();
  const category = String(formData.get("category") ?? "").trim() || null;
  const price = Number(formData.get("selling_price") ?? 0);
  if (!name) return { error: "Enter a name." };
  if (!Number.isFinite(price) || price < 0) return { error: "Enter a valid price." };

  const supabase = await createClient();
  const { data: last } = await supabase.from("products").select("sort_order").order("sort_order", { ascending: false }).limit(1);
  const { data, error } = await supabase
    .from("products")
    .insert({ name, category, selling_price: Math.round(price * 100) / 100, sort_order: (last?.[0]?.sort_order ?? 0) + 1 })
    .select("id")
    .single();
  if (error) return { error: error.code === "23505" ? `"${name}" already exists.` : error.message };

  revalidatePath("/admin/products");
  redirect(`/admin/products/${data.id}`);
}

/** Adds a size (e.g. Large) to a product; the size starts with a copy of its recipe. */
export async function createSize(_prev: ProductResult, formData: FormData): Promise<ProductResult> {
  const price = Number(formData.get("selling_price"));
  if (!Number.isFinite(price) || price < 0) return { error: "Enter a valid price." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_variant", {
    p_base_id: String(formData.get("base_id") ?? ""),
    p_label: String(formData.get("label") ?? "").trim(),
    p_price: Math.round(price * 100) / 100,
  });
  if (error) return { error: error.code === "23505" ? "A product with that name already exists." : error.message };
  revalidatePath("/admin/products");
  revalidatePath("/worker");
  redirect(`/admin/products/${data as string}?size=1`);
}
