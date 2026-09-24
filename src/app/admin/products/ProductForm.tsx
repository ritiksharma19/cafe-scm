"use client";

import { useActionState } from "react";
import { updateProduct, type ProductResult } from "./actions";

export function ProductForm({
  id,
  price,
  sortOrder,
  active,
}: {
  id: string;
  price: string;
  sortOrder: number;
  active: boolean;
}) {
  const [state, action, pending] = useActionState<ProductResult, FormData>(updateProduct, {});
  return (
    <form action={action} className="flex flex-wrap items-end gap-3">
      <input type="hidden" name="id" value={id} />
      <label className="block w-32">
        <span className="mb-1.5 block text-sm font-medium">Price (₹)</span>
        <input
          name="selling_price"
          type="number"
          inputMode="decimal"
          min="0"
          step="0.01"
          defaultValue={Number(price)}
          className="field"
          required
        />
      </label>
      <label className="block w-24">
        <span className="mb-1.5 block text-sm font-medium">Order</span>
        <input name="sort_order" type="number" inputMode="numeric" step="1" defaultValue={sortOrder} className="field" />
      </label>
      <label className="flex min-h-12 items-center gap-2">
        <input type="checkbox" name="is_active" defaultChecked={active} className="size-5 accent-brand" />
        <span className="text-sm font-medium">On sale</span>
      </label>
      <button type="submit" className="btn btn-secondary" disabled={pending}>
        {pending ? "Saving…" : "Save"}
      </button>
      {state.error && <p className="w-full text-sm font-medium text-danger">{state.error}</p>}
      {state.ok && <p className="w-full text-sm font-medium text-ok">Saved.</p>}
    </form>
  );
}
