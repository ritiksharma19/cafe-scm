"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export interface ActionState {
  ok?: string;
  error?: string;
}

// Every function below is authorised by the database (admin-only RPCs). These actions
// only translate form fields into RPC calls.

async function call(fn: string, args: Record<string, unknown>, paths: string[], ok: string): Promise<ActionState> {
  const supabase = await createClient();
  const { error } = await supabase.rpc(fn, args);
  if (error) return { error: error.message };
  for (const p of paths) revalidatePath(p);
  return { ok };
}

const text = (fd: FormData, key: string) => String(fd.get(key) ?? "").trim();

export async function cancelTransfer(_p: ActionState, fd: FormData) {
  return call("cancel_transfer", { p_transfer_id: text(fd, "id"), p_reason: text(fd, "reason") }, ["/admin/transfers"], "Cancelled; stock returned.");
}

export async function voidReceipt(_p: ActionState, fd: FormData) {
  return call("void_receipt", { p_receipt_id: text(fd, "id"), p_reason: text(fd, "reason") }, ["/admin/purchases"], "Receipt voided.");
}

export async function voidWastage(_p: ActionState, fd: FormData) {
  return call("void_wastage", { p_wastage_id: text(fd, "id"), p_reason: text(fd, "reason") }, ["/admin/wastage"], "Wastage voided.");
}

export async function rejectRequest(_p: ActionState, fd: FormData) {
  return call(
    "update_stock_request",
    { p_request_id: text(fd, "id"), p_status: "rejected", p_note: text(fd, "reason") },
    ["/admin/requests", "/admin"],
    "Request rejected.",
  );
}

export async function markRequestFulfilled(_p: ActionState, fd: FormData) {
  return call(
    "update_stock_request",
    { p_request_id: text(fd, "id"), p_status: "fulfilled", p_note: text(fd, "reason") || "Bought locally" },
    ["/admin/requests", "/admin"],
    "Marked as done.",
  );
}

export async function approveCount(_p: ActionState, fd: FormData) {
  return call(
    "review_stock_count",
    { p_count_id: text(fd, "id"), p_approve: true, p_note: text(fd, "reason") || null },
    ["/admin/counts"],
    "Count approved; stock corrected.",
  );
}

export async function rejectCount(_p: ActionState, fd: FormData) {
  return call(
    "review_stock_count",
    { p_count_id: text(fd, "id"), p_approve: false, p_note: text(fd, "reason") },
    ["/admin/counts"],
    "Count rejected.",
  );
}

/** Sends exactly what a cart requested from Central Storage, as one transfer. */
export async function sendRequestFromCentral(_p: ActionState, fd: FormData): Promise<ActionState> {
  const supabase = await createClient();
  const requestId = text(fd, "id");
  const [{ data: request, error }, { data: central }] = await Promise.all([
    supabase
      .from("stock_requests")
      .select("location_id, stock_request_items(material_id, quantity)")
      .eq("id", requestId)
      .single<{ location_id: string; stock_request_items: { material_id: string; quantity: string }[] }>(),
    supabase.from("locations").select("id").eq("type", "central").single<{ id: string }>(),
  ]);
  if (error || !request || !central) return { error: error?.message ?? "Request not found." };

  return call(
    "create_transfer",
    {
      p_transfer_id: randomUUID(),
      p_from_location_id: central.id,
      p_to_location_id: request.location_id,
      p_items: request.stock_request_items.map((i) => ({ material_id: i.material_id, quantity: Number(i.quantity) })),
      p_notes: "For stock request",
      p_request_id: requestId,
    },
    ["/admin/requests", "/admin/transfers", "/admin"],
    "Sent from Central Storage. The cart confirms when it arrives.",
  );
}
