"use client";

import { useEffect, useState } from "react";
import { formatINR } from "@/lib/format";
import { useOutboxSubmit } from "@/lib/offline/useOutboxSubmit";
import type { SaleResult } from "@/lib/sale";

export interface SellProduct {
  id: string;
  name: string;
  selling_price: string;
  color: string | null;
  sort_order: number;
}

interface Toast {
  text: string;
  tone: "ok" | "queued";
  warning?: string;
}

export function SellScreen({
  products,
  todayOrders,
  todaySales,
}: {
  products: SellProduct[];
  todayOrders: number;
  todaySales: number;
}) {
  const [cart, setCart] = useState<Record<string, number>>({});
  const [toast, setToast] = useState<Toast | null>(null);
  const [today, setToday] = useState({ orders: todayOrders, sales: todaySales });
  const { phase, submit: send, clearError, busy } = useOutboxSubmit("sale", "record_sale", "p_order_id");

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.warning ? 5000 : 2200);
    return () => clearTimeout(t);
  }, [toast]);

  const locked = busy;
  const lines = products.filter((p) => cart[p.id] > 0);
  const itemCount = lines.reduce((n, p) => n + cart[p.id], 0);
  const total = lines.reduce((sum, p) => sum + Number(p.selling_price) * cart[p.id], 0);

  function change(productId: string, delta: number) {
    if (locked) return;
    if (phase.kind === "error") clearError();
    setCart((c) => {
      const next = Math.max(0, Math.min(999, (c[productId] ?? 0) + delta));
      return { ...c, [productId]: next };
    });
    if (delta > 0) navigator.vibrate?.(8);
  }

  function reset() {
    setCart({});
    clearError();
  }

  async function submit() {
    if (itemCount === 0 || busy) return;
    const summary = `${lines.map((p) => `${p.name} × ${cart[p.id]}`).join(", ")} · ${formatINR(total)}`;
    // Saved on the phone first; sent now if online, otherwise synced later with the same id.
    const r = await send({ p_items: lines.map((p) => ({ product_id: p.id, quantity: cart[p.id] })) }, summary);
    if (!r) return; // rejected: the error is shown and the order stays on screen to fix

    const items = `${itemCount} item${itemCount === 1 ? "" : "s"} · ${formatINR(total)}`;
    if (r.outcome === "synced") {
      const result = r.data as SaleResult;
      if (result.status === "created") setToday((t) => ({ orders: t.orders + 1, sales: t.sales + Number(result.total_amount) }));
      setToast({
        tone: "ok",
        text: `Order saved · ${items}`,
        warning: result.negative_materials.length
          ? `Stock is below zero for ${result.negative_materials.join(", ")}. Tell the owner.`
          : undefined,
      });
    } else {
      setToday((t) => ({ orders: t.orders + 1, sales: t.sales + total }));
      setToast({ tone: "queued", text: `Saved on this phone · ${items}`, warning: "It will sync automatically when the connection is back." });
    }
    navigator.vibrate?.([15, 40, 15]);
    setCart({});
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted">
        Today: <span className="font-semibold text-ink">{today.orders} orders</span> ·{" "}
        <span className="font-semibold text-ink">{formatINR(today.sales)}</span>
      </p>

      <div className="grid grid-cols-2 gap-3">
        {products.map((p) => {
          const qty = cart[p.id] ?? 0;
          return (
            <div key={p.id} className="relative">
              <button
                type="button"
                onClick={() => change(p.id, 1)}
                disabled={locked}
                aria-label={`Add ${p.name}${qty ? `, ${qty} in order` : ""}`}
                className={`flex min-h-28 w-full flex-col items-start justify-between rounded-2xl border-2 p-4 text-left transition-colors active:scale-[0.98] disabled:opacity-60 ${
                  qty > 0 ? "border-brand bg-brand/5" : "border-line bg-surface"
                }`}
                style={p.color ? { borderLeftColor: p.color, borderLeftWidth: 8 } : undefined}
              >
                <span className="text-lg font-bold leading-tight">{p.name}</span>
                <span className="text-sm text-muted">{formatINR(p.selling_price)}</span>
              </button>
              {qty > 0 && (
                <>
                  <span
                    aria-hidden
                    className="pointer-events-none absolute right-3 top-3 flex size-10 items-center justify-center rounded-full bg-brand text-lg font-extrabold text-brand-ink"
                  >
                    {qty}
                  </span>
                  <button
                    type="button"
                    onClick={() => change(p.id, -1)}
                    disabled={locked}
                    aria-label={`Remove one ${p.name}`}
                    className="absolute bottom-2 right-2 flex size-11 items-center justify-center rounded-full border border-line bg-surface text-2xl font-bold leading-none disabled:opacity-60"
                  >
                    −
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>

      {/* Order bar sits just above the bottom tab bar. */}
      <div className="fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-10 border-t border-line bg-surface/95 backdrop-blur">
        <div className="mx-auto flex max-w-md flex-col gap-2 px-4 py-3">
          {phase.kind === "error" && (
            <div role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm font-medium text-danger">
              Not saved: {phase.message}
            </div>
          )}
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-lg font-bold tabular-nums">{formatINR(total)}</p>
              <p className="text-xs text-muted">
                {itemCount} item{itemCount === 1 ? "" : "s"}
              </p>
            </div>
            {itemCount > 0 && (
              <button type="button" onClick={reset} disabled={locked} className="btn btn-secondary px-4">
                Clear
              </button>
            )}
            <button
              type="button"
              onClick={submit}
              disabled={itemCount === 0 || busy}
              className="btn btn-primary min-h-14 flex-[1.4] text-lg"
            >
              {busy ? "Saving…" : "Submit order"}
            </button>
          </div>
        </div>
      </div>
      <div aria-hidden className="h-24" />

      {toast && (
        <div
          role="status"
          className={`fixed inset-x-4 top-[max(4.5rem,calc(env(safe-area-inset-top)+4rem))] z-20 mx-auto max-w-md rounded-2xl px-4 py-3 text-brand-ink shadow-lg ${
            toast.tone === "ok" ? "bg-ok" : "bg-warn"
          }`}
        >
          <p className="text-base font-bold">✓ {toast.text}</p>
          {toast.warning && <p className="mt-1 rounded-lg bg-white/15 px-2 py-1 text-sm">{toast.warning}</p>}
        </div>
      )}
    </div>
  );
}
