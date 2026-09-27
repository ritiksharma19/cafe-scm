"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { formatINR } from "@/lib/format";
import { EXPENSE_CATEGORIES, PAYMENT_METHODS, type ExpenseCategory, type PaymentMethod } from "@/lib/money";
import { useRpcSubmit } from "@/lib/useRpcSubmit";
import { SubmitStatus, SuccessBanner } from "./SubmitStatus";

// Things a cart typically pays for out of the cash box. Rent and salaries are the owner's.
const CART_CATEGORIES: ExpenseCategory[] = ["gas_fuel", "packaging", "maintenance", "transport", "utilities", "other"];

/** Worker records a small cash expense paid at the cart (e.g. ice, gas refill). Online only. */
export function ExpenseEntry() {
  const router = useRouter();
  const rpc = useRpcSubmit<{ status: string; amount: number }>("record_expense", "p_expense_id");
  const [category, setCategory] = useState<ExpenseCategory | null>(null);
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [paidBy, setPaidBy] = useState<PaymentMethod>("cash");
  const [done, setDone] = useState<string | null>(null);
  const [invalid, setInvalid] = useState<string | null>(null);

  async function save() {
    const value = Math.round(Number(amount) * 100) / 100;
    if (!category) return setInvalid("Choose what it was for.");
    if (!Number.isFinite(value) || value <= 0) return setInvalid("Enter the amount.");
    if (category === "other" && !description.trim()) return setInvalid("Write what it was for.");
    setInvalid(null);
    const r = await rpc.submit({
      p_category: category,
      p_amount: value,
      p_description: description.trim() || null,
      p_payment_method: paidBy,
    });
    if (!r) return;
    setDone(`Expense saved · ${formatINR(value)}`);
    setCategory(null);
    setAmount("");
    setDescription("");
    setPaidBy("cash");
    router.refresh();
  }

  const cats = EXPENSE_CATEGORIES.filter((c) => CART_CATEGORIES.includes(c.value));

  return (
    <div className="flex flex-col gap-4">
      {done && <SuccessBanner text={done} onDone={() => setDone(null)} />}
      <fieldset disabled={rpc.locked} className="flex flex-col gap-4">
        <div>
          <p className="mb-1.5 text-sm font-medium">What for?</p>
          <div className="grid grid-cols-2 gap-2">
            {cats.map((c) => (
              <button
                key={c.value}
                type="button"
                onClick={() => setCategory(c.value)}
                aria-pressed={category === c.value}
                className={`min-h-12 rounded-xl border-2 px-3 text-left text-sm font-semibold ${
                  category === c.value ? "border-brand bg-brand/5 text-brand" : "border-line bg-surface"
                }`}
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Amount (₹)</span>
          <input type="number" inputMode="decimal" min="0" step="1" value={amount} onChange={(e) => setAmount(e.target.value)} className="field text-lg" />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Note {category === "other" ? "" : "(optional)"}</span>
          <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={200} className="field" placeholder="e.g. ice, cylinder refill" />
        </label>
        <div>
          <p className="mb-1.5 text-sm font-medium">Paid by</p>
          <div className="grid grid-cols-3 gap-1 rounded-xl bg-bg p-1">
            {PAYMENT_METHODS.filter((m) => m.value !== "other").map((m) => (
              <button
                key={m.value}
                type="button"
                onClick={() => setPaidBy(m.value)}
                aria-pressed={paidBy === m.value}
                className={`min-h-10 rounded-lg text-sm font-bold ${paidBy === m.value ? "bg-surface text-brand shadow-sm" : "text-muted"}`}
              >
                {m.label}
              </button>
            ))}
          </div>
          <p className="mt-1 text-xs text-muted">Cash expenses are taken off “Cash to hand over” in Today&apos;s activity.</p>
        </div>
      </fieldset>
      {invalid && <p className="text-sm font-medium text-danger">{invalid}</p>}
      <SubmitStatus phase={rpc.phase} />
      <div className="flex gap-2">
        {rpc.phase.kind === "unconfirmed" && (
          <button type="button" onClick={rpc.reset} className="btn btn-secondary">
            Discard
          </button>
        )}
        <button type="button" onClick={save} disabled={rpc.phase.kind === "sending"} className="btn btn-primary min-h-14 flex-1 text-lg">
          {rpc.phase.kind === "sending" ? "Saving…" : rpc.phase.kind === "unconfirmed" ? "Retry" : "Save expense"}
        </button>
      </div>
    </div>
  );
}
