"use client";

import { useActionState } from "react";
import type { ActionState } from "@/app/admin/stock-actions";

/**
 * A small form bound to a server action: hidden id, optional reason/note field, one button.
 * Used for void / cancel / approve / reject actions across the admin screens.
 */
export function ActionForm({
  action,
  id,
  label,
  reason,
  tone = "secondary",
}: {
  action: (prev: ActionState, fd: FormData) => Promise<ActionState>;
  id: string;
  label: string;
  reason?: { placeholder: string; required?: boolean };
  tone?: "primary" | "secondary" | "danger";
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const btn =
    tone === "primary" ? "btn btn-primary" : tone === "danger" ? "btn btn-secondary text-danger" : "btn btn-secondary";

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="id" value={id} />
      <div className="flex flex-wrap gap-2">
        {reason && (
          <input
            name="reason"
            placeholder={reason.placeholder}
            required={reason.required}
            aria-label={reason.placeholder}
            className="field min-w-40 flex-1"
          />
        )}
        <button type="submit" disabled={pending} className={`${btn} min-h-12 text-sm`}>
          {pending ? "Working…" : label}
        </button>
      </div>
      {state.error && <p className="text-sm font-medium text-danger">{state.error}</p>}
      {state.ok && <p className="text-sm font-medium text-ok">{state.ok}</p>}
    </form>
  );
}
