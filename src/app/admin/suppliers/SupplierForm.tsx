"use client";

import { useActionState } from "react";
import { saveSupplier, type SupplierResult } from "./actions";
import type { SupplierRow } from "./page";

export function SupplierForm({ supplier }: { supplier?: SupplierRow }) {
  const [state, action, pending] = useActionState<SupplierResult, FormData>(saveSupplier, {});
  return (
    <form action={action} className="flex flex-col gap-3">
      {supplier && <input type="hidden" name="id" value={supplier.id} />}
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Name</span>
          <input name="name" defaultValue={supplier?.name} className="field" required />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Phone</span>
          <input name="phone" type="tel" defaultValue={supplier?.phone ?? ""} className="field" />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Notes</span>
          <input name="notes" defaultValue={supplier?.notes ?? ""} className="field" />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-4">
        {supplier && (
          <label className="flex min-h-11 items-center gap-2">
            <input type="checkbox" name="is_active" defaultChecked={supplier.is_active} className="size-5 accent-brand" />
            <span className="text-sm font-medium">Active</span>
          </label>
        )}
        <button type="submit" disabled={pending} className={supplier ? "btn btn-secondary" : "btn btn-primary"}>
          {pending ? "Saving…" : supplier ? "Save" : "Add supplier"}
        </button>
        {state.error && <p className="text-sm font-medium text-danger">{state.error}</p>}
        {state.ok && <p className="text-sm font-medium text-ok">Saved.</p>}
      </div>
    </form>
  );
}
