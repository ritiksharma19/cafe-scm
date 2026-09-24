"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export interface SupplierResult {
  ok?: boolean;
  error?: string;
}

export async function saveSupplier(_prev: SupplierResult, fd: FormData): Promise<SupplierResult> {
  const id = String(fd.get("id") ?? "");
  const name = String(fd.get("name") ?? "").trim();
  if (!name) return { error: "Enter a name." };
  const row = {
    name,
    phone: String(fd.get("phone") ?? "").trim() || null,
    notes: String(fd.get("notes") ?? "").trim() || null,
    ...(id ? { is_active: fd.get("is_active") === "on" } : {}),
  };

  // RLS: admin only; audited by trigger.
  const supabase = await createClient();
  const { data, error } = id
    ? await supabase.from("suppliers").update(row).eq("id", id).select("id")
    : await supabase.from("suppliers").insert(row).select("id");
  if (error) return { error: error.code === "23505" ? `A supplier called "${name}" already exists.` : error.message };
  if (!data?.length) return { error: "Not allowed." };

  revalidatePath("/admin/suppliers");
  return { ok: true };
}
