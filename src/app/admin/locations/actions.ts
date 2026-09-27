"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/app/admin/stock-actions";
import { createClient } from "@/lib/supabase/server";

// Authorised and validated by admin_save_location() in the database.
async function save(args: { p_id: string | null; p_name: string; p_sort_order: number | null; p_is_active: boolean }, ok: string): Promise<ActionState> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_save_location", args);
  if (error) return { error: error.message };
  revalidatePath("/admin", "layout");
  return { ok };
}

export async function addCart(_p: ActionState, fd: FormData): Promise<ActionState> {
  const name = String(fd.get("name") ?? "").trim();
  if (!name) return { error: "Enter a name." };
  return save({ p_id: null, p_name: name, p_sort_order: null, p_is_active: true }, `Added ${name}. Next: add a worker for it under Users.`);
}

export async function updateLocation(_p: ActionState, fd: FormData): Promise<ActionState> {
  const sort = Number(fd.get("sort_order"));
  if (!Number.isInteger(sort)) return { error: "Order must be a whole number." };
  return save(
    {
      p_id: String(fd.get("id") ?? ""),
      p_name: String(fd.get("name") ?? "").trim(),
      p_sort_order: sort,
      p_is_active: fd.get("is_active") === "on",
    },
    "Saved.",
  );
}
