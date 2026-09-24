"use client";

import { useEffect, useRef, useState } from "react";
import { formatINR } from "@/lib/format";
import { newId } from "@/lib/ids";
import { isDefinitiveFailure, type SaleResult } from "@/lib/sale";
import { createClient } from "@/lib/supabase/client";

export interface SellProduct {
  id: string;
  name: string;
  selling_price: string;
  color: string | null;
  sort_order: number;
}

type Phase =
  | { kind: "idle" }
  | { kind: "sending" }
  // Server never answered: the order may or may not be saved. Keep it locked and retry with the same id.
  | { kind: "unconfirmed"; message: string }
  | { kind: "error"; message: string };

interface Toast {
  text: string;
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
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [toast, setToast] = useState<Toast | null>(null);
  const [today, setToday] = useState({ orders: todayOrders, sales: todaySales });
  const orderId = useRef<string | null>(null);
  const occurredAt = useRef<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.warning ? 5000 : 2200);
    return () => clearTimeout(t);
  }, [toast]);

  const locked = phase.kind === "sending" || phase.kind === "unconfirmed";
  const lines = products.filter((p) => cart[p.id] > 0);
  const itemCount = lines.reduce((n, p) => n + cart[p.id], 0);
  const total = lines.reduce((sum, p) => sum + Number(p.selling_price) * cart[p.id], 0);

  function change(productId: string, delta: number) {
    if (locked) return;
    if (phase.kind === "error") setPhase({ kind: "idle" });
    setCart((c) => {
      const next = Math.max(0, Math.min(999, (c[productId] ?? 0) + delta));
      return { ...c, [productId]: next };
    });
    if (delta > 0) navigator.vibrate?.(8);
  }

  function reset() {
    setCart({});
    orderId.current = null;
    occurredAt.current = null;
    setPhase({ kind: "idle" });
  }

  async function submit() {
    if (itemCount === 0 || phase.kind === "sending") return;
    // Same id on every retry of this order → the server can never record it twice.
    orderId.current ??= newId();
    occurredAt.current ??= new Date().toISOString();
    setPhase({ kind: "sending" });

    const supabase = createClient();
    const { data, error } = await supabase.rpc("record_sale", {
      p_order_id: orderId.current,
      p_items: lines.map((p) => ({ product_id: p.id, quantity: cart[p.id] })),
      p_occurred_at: occurredAt.current,
    });

    if (error) {
      if (isDefinitiveFailure(error)) {
        // Rolled back on the server: nothing saved. A fresh id is used next time.
        orderId.current = null;
        occurredAt.current = null;
        setPhase({ kind: "error", message: error.message });
      } else {
        setPhase({
          kind: "unconfirmed",
          message: navigator.onLine ? "No reply from the server." : "No internet connection.",
        });
      }
      return;
    }

    const result = data as SaleResult;
    if (result.status === "created") {
      setToday((t) => ({ orders: t.orders + 1, sales: t.sales + Number(result.total_amount) }));
    }
    setToast({
      text: `Order saved · ${result.item_count} item${result.item_count === 1 ? "" : "s"} · ${formatINR(result.total_amount)}`,
      warning: result.negative_materials.length
        ? `Stock is below zero for ${result.negative_materials.join(", ")}. Tell the owner.`
        : undefined,
    });
    navigator.vibrate?.([15, 40, 15]);
    reset();
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
          {phase.kind === "unconfirmed" && (
            <div role="alert" className="rounded-lg bg-warn/10 px-3 py-2 text-sm font-medium text-warn">
              Not confirmed yet — {phase.message} Tap <b>Retry</b>. It will not be counted twice.
            </div>
          )}
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
            {phase.kind === "unconfirmed" ? (
              <button type="button" onClick={reset} className="btn btn-secondary px-3 text-sm">
                Discard
              </button>
            ) : (
              itemCount > 0 && (
                <button type="button" onClick={reset} disabled={locked} className="btn btn-secondary px-4">
                  Clear
                </button>
              )
            )}
            <button
              type="button"
              onClick={submit}
              disabled={itemCount === 0 || phase.kind === "sending"}
              className="btn btn-primary min-h-14 flex-[1.4] text-lg"
            >
              {phase.kind === "sending" ? "Saving…" : phase.kind === "unconfirmed" ? "Retry" : "Submit order"}
            </button>
          </div>
        </div>
      </div>
      <div aria-hidden className="h-24" />

      {toast && (
        <div
          role="status"
          className="fixed inset-x-4 top-[max(4.5rem,calc(env(safe-area-inset-top)+4rem))] z-20 mx-auto max-w-md rounded-2xl bg-ok px-4 py-3 text-brand-ink shadow-lg"
        >
          <p className="text-base font-bold">✓ {toast.text}</p>
          {toast.warning && <p className="mt-1 rounded-lg bg-white/15 px-2 py-1 text-sm">{toast.warning}</p>}
        </div>
      )}
    </div>
  );
}
