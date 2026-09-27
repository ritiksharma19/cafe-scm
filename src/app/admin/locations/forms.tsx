"use client";

import { useActionState } from "react";
import type { ActionState } from "@/app/admin/stock-actions";
import type { Location } from "@/lib/types";
import { addCart, updateLocation } from "./actions";

export function AddCartForm({ suggestion }: { suggestion: string }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(addCart, {});
  return (
    <form action={action} className="flex flex-wrap items-end gap-3">
      <label className="block min-w-56 flex-1">
        <span className="mb-1.5 block text-sm font-medium">Cart / outlet name</span>
        <input name="name" className="field" placeholder={suggestion} maxLength={40} required />
      </label>
      <button type="submit" disabled={pending} className="btn btn-primary">
        {pending ? "Adding…" : "Add cart"}
      </button>
      {state.error && <p className="w-full text-sm font-medium text-danger">{state.error}</p>}
      {state.ok && <p className="w-full text-sm font-medium text-ok">{state.ok}</p>}
    </form>
  );
}

export function EditLocationForm({ location }: { location: Location }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(updateLocation, {});
  return (
    <form action={action} className="flex flex-wrap items-end gap-3">
      <input type="hidden" name="id" value={location.id} />
      <label className="block min-w-48 flex-1">
        <span className="mb-1.5 block text-sm font-medium">Name</span>
        <input name="name" defaultValue={location.name} className="field" maxLength={40} required />
      </label>
      <label className="block w-24">
        <span className="mb-1.5 block text-sm font-medium">Order</span>
        <input name="sort_order" type="number" inputMode="numeric" step="1" defaultValue={location.sort_order} className="field" />
      </label>
      {location.type === "cart" && (
        <label className="flex min-h-12 items-center gap-2">
          <input type="checkbox" name="is_active" defaultChecked={location.is_active} className="size-5 accent-brand" />
          <span className="text-sm font-medium">Active</span>
        </label>
      )}
      {location.type === "central" && <input type="hidden" name="is_active" value="on" />}
      <button type="submit" disabled={pending} className="btn btn-secondary">
        {pending ? "Saving…" : "Save"}
      </button>
      {state.error && <p className="w-full text-sm font-medium text-danger">{state.error}</p>}
      {state.ok && <p className="w-full text-sm font-medium text-ok">{state.ok}</p>}
    </form>
  );
}
