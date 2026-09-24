"use client";

import { useActionState } from "react";
import { saveSettings, type SettingsResult } from "./actions";

export interface Settings {
  business_name: string;
  timezone: string;
  currency: string;
  runway_window_days: number;
  min_history_days: number;
  reorder_cover_days: number;
  allow_negative_on_sale: boolean;
  allow_negative_other: boolean;
}

export function SettingsForm({ settings }: { settings: Settings }) {
  const [state, action, pending] = useActionState<SettingsResult, FormData>(saveSettings, {});
  const num = (name: keyof Settings, label: string, help: string, min: number, max: number) => (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium">{label}</span>
      <input name={name} type="number" min={min} max={max} step={1} defaultValue={settings[name] as number} className="field w-32" required />
      <span className="mt-1 block text-xs text-muted">{help}</span>
    </label>
  );
  const check = (name: keyof Settings, label: string, help: string) => (
    <label className="flex items-start gap-3">
      <input type="checkbox" name={name} defaultChecked={settings[name] as boolean} className="mt-1 size-5 accent-brand" />
      <span>
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-xs text-muted">{help}</span>
      </span>
    </label>
  );

  return (
    <form action={action} className="flex flex-col gap-5">
      <section className="card flex flex-col gap-4 p-5">
        <h2 className="font-bold">Business</h2>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Name</span>
          <input name="business_name" defaultValue={settings.business_name} className="field" required />
        </label>
        <p className="text-sm text-muted">
          Time zone {settings.timezone} · currency {settings.currency}
        </p>
      </section>

      <section className="card flex flex-col gap-4 p-5">
        <h2 className="font-bold">Stock runway &amp; reordering</h2>
        {num("runway_window_days", "Average daily use over the last … days", "Rolling window for “days left”. 7 or 14 works well.", 1, 90)}
        {num("min_history_days", "Minimum days of history", "Below this, the app shows “insufficient data” instead of an estimate.", 1, 90)}
        {num("reorder_cover_days", "Suggested order covers … days", "Suggested order = daily use × (lead time + these days) − stock, unless a target stock is set.", 1, 60)}
      </section>

      <section className="card flex flex-col gap-4 p-5">
        <h2 className="font-bold">Negative stock</h2>
        {check(
          "allow_negative_on_sale",
          "Allow sales to take stock below zero (recommended)",
          "The food is already served, and offline sales may arrive late. Negative items are flagged on the dashboard. Off = the sale is refused.",
        )}
        {check(
          "allow_negative_other",
          "Allow wastage, transfers and adjustments below zero",
          "Normally off: these are blocked when stock is insufficient.",
        )}
      </section>

      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className="btn btn-primary">
          {pending ? "Saving…" : "Save settings"}
        </button>
        {state.error && <p className="text-sm font-medium text-danger">{state.error}</p>}
        {state.ok && <p className="text-sm font-medium text-ok">Saved.</p>}
      </div>
    </form>
  );
}
