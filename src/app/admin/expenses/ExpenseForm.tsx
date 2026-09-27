"use client";

import { useActionState, useRef } from "react";
import type { ActionState } from "@/app/admin/stock-actions";
import { EXPENSE_CATEGORIES, PAYMENT_METHODS } from "@/lib/money";
import { addExpense } from "./actions";

export function ExpenseForm({ locations, today }: { locations: { id: string; name: string }[]; today: string }) {
  const form = useRef<HTMLFormElement>(null);
  const [state, action, pending] = useActionState<ActionState, FormData>(async (prev, fd) => {
    const r = await addExpense(prev, fd);
    if (r.ok) {
      // Keep date / location / category for the next entry; clear the rest.
      const f = form.current;
      if (f) (["amount", "description"] as const).forEach((n) => ((f.elements.namedItem(n) as HTMLInputElement).value = ""));
    }
    return r;
  }, {});

  return (
    <form ref={form} action={action} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <label className="block">
        <span className="mb-1.5 block text-sm font-medium">Category</span>
        <select name="category" className="field" required defaultValue="">
          <option value="" disabled>
            Choose…
          </option>
          {EXPENSE_CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="mb-1.5 block text-sm font-medium">Amount (₹)</span>
        <input name="amount" type="number" inputMode="decimal" min="0.01" step="0.01" className="field" required />
      </label>
      <label className="block">
        <span className="mb-1.5 block text-sm font-medium">Date</span>
        <input name="spent_on" type="date" max={today} defaultValue={today} className="field" required />
      </label>
      <label className="block">
        <span className="mb-1.5 block text-sm font-medium">For</span>
        <select name="location_id" className="field" defaultValue="">
          <option value="">Whole business (shared)</option>
          {locations.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="mb-1.5 block text-sm font-medium">Paid by</span>
        <select name="payment_method" className="field" defaultValue="cash">
          {PAYMENT_METHODS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="mb-1.5 block text-sm font-medium">Description</span>
        <input name="description" className="field" placeholder="e.g. September rent" maxLength={200} />
      </label>
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2 lg:col-span-3">
        <button type="submit" disabled={pending} className="btn btn-primary">
          {pending ? "Saving…" : "Add expense"}
        </button>
        {state.error && <p className="text-sm font-medium text-danger">{state.error}</p>}
        {state.ok && <p className="text-sm font-medium text-ok">{state.ok}</p>}
      </div>
    </form>
  );
}
