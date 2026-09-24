"use client";

import { useActionState } from "react";
import { voidOrder, type VoidResult } from "./actions";

export function VoidOrderForm({ orderId }: { orderId: string }) {
  const [state, action, pending] = useActionState<VoidResult, FormData>(voidOrder, {});
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="order_id" value={orderId} />
      <label className="block">
        <span className="mb-1.5 block text-sm font-medium">Void this order</span>
        <input name="reason" className="field" placeholder="Reason, e.g. entered twice" required />
      </label>
      {state.error && <p className="text-sm font-medium text-danger">{state.error}</p>}
      <button type="submit" className="btn btn-secondary text-danger" disabled={pending}>
        {pending ? "Voiding…" : "Void and return stock"}
      </button>
    </form>
  );
}
