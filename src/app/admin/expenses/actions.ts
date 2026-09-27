"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import type { ActionState } from "@/app/admin/stock-actions";
import { createClient } from "@/lib/supabase/server";

// Authorised and validated by record_expense() / void_expense() in the database.

export async function addExpense(_p: ActionState, fd: FormData): Promise<ActionState> {
  const amount = Number(fd.get("amount"));
  if (!Number.isFinite(amount) || amount <= 0) return { error: "Enter an amount greater than zero." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("record_expense", {
    p_expense_id: randomUUID(),
    p_category: String(fd.get("category") ?? ""),
    p_amount: Math.round(amount * 100) / 100,
    p_spent_on: String(fd.get("spent_on") ?? "") || null,
    p_description: String(fd.get("description") ?? "").trim() || null,
    p_payment_method: String(fd.get("payment_method") ?? "cash"),
    p_location_id: String(fd.get("location_id") ?? "") || null,
  });
  if (error) return { error: error.message };
  revalidatePath("/admin/expenses");
  revalidatePath("/admin/analytics");
  revalidatePath("/admin");
  return { ok: "Expense saved." };
}

export async function voidExpense(_p: ActionState, fd: FormData): Promise<ActionState> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("void_expense", {
    p_expense_id: String(fd.get("id") ?? ""),
    p_reason: String(fd.get("reason") ?? "").trim(),
  });
  if (error) return { error: error.message };
  revalidatePath("/admin/expenses");
  revalidatePath("/admin/analytics");
  return { ok: "Expense voided." };
}
