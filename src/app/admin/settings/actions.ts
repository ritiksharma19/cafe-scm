"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export interface SettingsResult {
  ok?: boolean;
  error?: string;
}

export async function saveSettings(_prev: SettingsResult, fd: FormData): Promise<SettingsResult> {
  const int = (k: string) => Number(fd.get(k));
  const row = {
    business_name: String(fd.get("business_name") ?? "").trim(),
    runway_window_days: int("runway_window_days"),
    min_history_days: int("min_history_days"),
    reorder_cover_days: int("reorder_cover_days"),
    worker_discount_limit_pct: int("worker_discount_limit_pct"),
    allow_negative_on_sale: fd.get("allow_negative_on_sale") === "on",
    allow_negative_other: fd.get("allow_negative_other") === "on",
  };
  if (!row.business_name) return { error: "Enter a business name." };
  if (row.min_history_days > row.runway_window_days) {
    return { error: "Minimum days of history cannot exceed the averaging window." };
  }

  // Admin-only by RLS; ranges enforced by table constraints; change is audited.
  const supabase = await createClient();
  const user = await getCurrentUser();
  if (!user) return { error: "Not allowed." };
  const { data, error } = await supabase.from("app_settings").update(row).eq("business_id", user.profile.business_id).select("business_id");
  if (error) return { error: error.message };
  if (!data?.length) return { error: "Not allowed." };
  revalidatePath("/admin", "layout");
  return { ok: true };
}
