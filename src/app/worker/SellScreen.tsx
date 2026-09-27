"use client";

import { useEffect, useMemo, useState } from "react";
import { formatINR } from "@/lib/format";
import { maxDiscount, PAYMENT_METHODS, paymentMethodLabel, type PaymentMethod } from "@/lib/money";
import { useOutboxSubmit } from "@/lib/offline/useOutboxSubmit";
import type { SaleResult } from "@/lib/sale";
import {
  addLine,
  addonsFor,
  changeLine,
  groupMenu,
  sizeLabel,
  toSaleItems,
  unitPrice,
  type CartLine,
  type MenuAddon,
  type MenuGroup,
  type MenuProduct,
} from "@/lib/sell";

export interface SellProduct extends MenuProduct {
  color: string | null;
  sort_order: number;
}

export type SellAddon = MenuAddon;

interface Toast {
  text: string;
  tone: "ok" | "queued";
  warning?: string;
}

// The sell screen shows the three everyday methods; "other" stays available to the owner's reports.
const METHODS = PAYMENT_METHODS.filter((m) => m.value !== "other");
const ALL = "__all__";

export function SellScreen({
  products,
  addons,
  todayOrders,
  todaySales,
  discountLimitPct,
}: {
  products: SellProduct[];
  addons: SellAddon[];
  todayOrders: number;
  todaySales: number;
  discountLimitPct: number;
}) {
  const [lines, setLines] = useState<CartLine[]>([]);
  const [lastOrder, setLastOrder] = useState<CartLine[] | null>(null);
  const [picking, setPicking] = useState<MenuGroup<SellProduct> | null>(null);
  const [showLines, setShowLines] = useState(false);
  const [payment, setPayment] = useState<PaymentMethod>("cash");
  const [discountText, setDiscountText] = useState("");
  const [showDiscount, setShowDiscount] = useState(false);
  const [category, setCategory] = useState(ALL);
  const [toast, setToast] = useState<Toast | null>(null);
  const [today, setToday] = useState({ orders: todayOrders, sales: todaySales });
  const { phase, submit: send, clearError, busy } = useOutboxSubmit("sale", "record_sale", "p_order_id");

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.warning ? 5000 : 2200);
    return () => clearTimeout(t);
  }, [toast]);

  const groups = useMemo(() => groupMenu(products), [products]);
  const productById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const addonById = useMemo(() => new Map(addons.map((a) => [a.id, a])), [addons]);
  const groupOf = useMemo(() => new Map(groups.flatMap((g) => g.options.map((o) => [o.id, g] as const))), [groups]);
  // A tile needs the picker when it has sizes or add-ons; otherwise one tap = one item.
  const needsPicker = (g: MenuGroup<SellProduct>) => g.options.length > 1 || g.options.some((o) => addonsFor(o, addons).length > 0);

  const categories = [...new Set(groups.map((g) => g.category?.trim()).filter((c): c is string => !!c))];
  const visible = category === ALL ? groups : groups.filter((g) => g.category?.trim() === category);

  const locked = busy;
  const priceOf = (l: CartLine) => unitPrice(l, productById, addonById);
  const itemCount = lines.reduce((n, l) => n + l.qty, 0);
  const gross = lines.reduce((sum, l) => sum + priceOf(l) * l.qty, 0);
  const discountLimit = maxDiscount(gross, discountLimitPct);
  const discount = Math.round(Number(discountText || 0) * 100) / 100;
  const discountError =
    !Number.isFinite(discount) || discount < 0
      ? "Enter a valid amount"
      : discount > discountLimit
        ? `Max discount ${formatINR(discountLimit)} (${discountLimitPct}%)`
        : null;
  const total = Math.max(0, gross - (discountError ? 0 : discount));

  const lineName = (l: CartLine) => {
    const p = productById.get(l.productId);
    const extras = Object.entries(l.addons).map(([id, q]) => `${q > 1 ? `${q}× ` : ""}${addonById.get(id)?.name ?? "?"}`);
    return `${p?.name ?? "?"}${extras.length ? ` + ${extras.join(", ")}` : ""}`;
  };
  const groupQty = (g: MenuGroup) => lines.filter((l) => groupOf.get(l.productId)?.key === g.key).reduce((n, l) => n + l.qty, 0);

  function touched() {
    if (phase.kind === "error") clearError();
  }

  function tapTile(g: MenuGroup<SellProduct>) {
    if (locked) return;
    touched();
    if (needsPicker(g)) {
      setPicking(g);
      return;
    }
    setLines((ls) => addLine(ls, g.options[0].id, {}, 1));
    navigator.vibrate?.(8);
  }

  function minusTile(g: MenuGroup<SellProduct>) {
    if (locked) return;
    touched();
    setLines((ls) => changeLine(ls, g.options[0].id, -1));
  }

  function reset() {
    setLines([]);
    setDiscountText("");
    setShowDiscount(false);
    setShowLines(false);
    setPayment("cash");
    clearError();
  }

  function repeatLast() {
    if (!lastOrder || locked) return;
    // Only products and add-ons still on sale.
    setLines(
      lastOrder
        .filter((l) => productById.has(l.productId) && Object.keys(l.addons).every((id) => addonById.has(id)))
        .map((l) => ({ ...l })),
    );
    navigator.vibrate?.(8);
  }

  async function submit() {
    if (itemCount === 0 || busy || discountError) return;
    const summary = `${lines.map((l) => `${lineName(l)} × ${l.qty}`).join(", ")} · ${formatINR(total)} ${paymentMethodLabel(payment)}${
      discount > 0 ? ` (−${formatINR(discount)})` : ""
    }`;
    // Saved on the phone first; sent now if online, otherwise synced later with the same id.
    const r = await send({ p_items: toSaleItems(lines), p_payment_method: payment, p_discount: discount }, summary);
    if (!r) return; // rejected: the error is shown and the order stays on screen to fix

    const items = `${itemCount} item${itemCount === 1 ? "" : "s"} · ${formatINR(total)} ${paymentMethodLabel(payment)}`;
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
    setLastOrder(lines);
    setLines([]);
    setDiscountText("");
    setShowDiscount(false);
    setShowLines(false);
    setPayment("cash");
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted">
        Today: <span className="font-semibold text-ink">{today.orders} orders</span> ·{" "}
        <span className="font-semibold text-ink">{formatINR(today.sales)}</span>
      </p>

      {categories.length > 1 && (
        <nav aria-label="Menu sections" className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
          {[ALL, ...categories].map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setCategory(c)}
              aria-pressed={category === c}
              className={`min-h-9 shrink-0 rounded-full border px-3.5 text-sm font-semibold ${
                category === c ? "border-brand bg-brand text-brand-ink" : "border-line bg-surface"
              }`}
            >
              {c === ALL ? "All" : c}
            </button>
          ))}
        </nav>
      )}

      <div className="grid grid-cols-3 gap-2">
        {visible.map((g) => {
          const qty = groupQty(g);
          const main = g.options[0];
          const picker = needsPicker(g);
          const prices = g.options.map((o) => Number(o.selling_price));
          return (
            <div key={g.key} className="relative">
              <button
                type="button"
                onClick={() => tapTile(g)}
                disabled={locked}
                aria-label={`${picker ? "Choose" : "Add"} ${g.name}${qty ? `, ${qty} in order` : ""}`}
                className={`flex min-h-[4.5rem] w-full flex-col items-start justify-between gap-1 rounded-xl border-2 py-2 pl-2.5 pr-1.5 text-left transition-colors active:scale-[0.97] disabled:opacity-60 ${
                  qty > 0 ? "border-brand bg-brand/5" : "border-line bg-surface"
                }`}
                style={main.color ? { borderLeftColor: main.color, borderLeftWidth: 5 } : undefined}
              >
                <span className={`line-clamp-2 text-sm font-bold leading-tight ${qty > 0 ? "pr-5" : ""}`}>{g.name}</span>
                <span className="text-xs text-muted">
                  {g.options.length > 1 ? `${formatINR(Math.min(...prices))}+` : formatINR(main.selling_price)}
                  {picker && <span className="ml-1 font-bold text-brand">⋯</span>}
                </span>
              </button>
              {qty > 0 && (
                <>
                  <span
                    aria-hidden
                    className="pointer-events-none absolute right-1 top-1 flex size-6 items-center justify-center rounded-full bg-brand text-xs font-extrabold text-brand-ink"
                  >
                    {qty}
                  </span>
                  {!picker && (
                    <button
                      type="button"
                      onClick={() => minusTile(g)}
                      disabled={locked}
                      aria-label={`Remove one ${g.name}`}
                      className="absolute bottom-1 right-1 flex size-8 items-center justify-center rounded-full border border-line bg-surface text-lg font-bold leading-none disabled:opacity-60"
                    >
                      −
                    </button>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>

      {/* Order bar sits just above the bottom tab bar. */}
      <div className="fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-10 border-t border-line bg-surface/95 backdrop-blur">
        <div className="mx-auto flex max-h-[60dvh] max-w-md flex-col gap-2 overflow-y-auto px-4 py-3">
          {phase.kind === "error" && (
            <div role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm font-medium text-danger">
              Not saved: {phase.message}
            </div>
          )}

          {showLines && lines.length > 0 && (
            <ul className="divide-y divide-line rounded-xl border border-line">
              {lines.map((l) => (
                <li key={l.key} className="flex items-center gap-2 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">{lineName(l)}</p>
                    <p className="text-xs text-muted tabular-nums">
                      {formatINR(priceOf(l))} × {l.qty} = {formatINR(priceOf(l) * l.qty)}
                    </p>
                  </div>
                  <button type="button" onClick={() => setLines((ls) => changeLine(ls, l.key, -1))} disabled={locked} aria-label={`One less ${lineName(l)}`} className="flex size-10 items-center justify-center rounded-full border border-line text-xl font-bold">
                    −
                  </button>
                  <span className="w-6 text-center font-bold tabular-nums">{l.qty}</span>
                  <button type="button" onClick={() => setLines((ls) => changeLine(ls, l.key, 1))} disabled={locked} aria-label={`One more ${lineName(l)}`} className="flex size-10 items-center justify-center rounded-full border border-line text-xl font-bold">
                    +
                  </button>
                </li>
              ))}
            </ul>
          )}

          {itemCount > 0 && (
            <div className="flex items-center gap-2">
              <div role="radiogroup" aria-label="Payment" className="grid flex-1 grid-cols-3 gap-1 rounded-xl bg-bg p-1">
                {METHODS.map((m) => (
                  <button
                    key={m.value}
                    type="button"
                    role="radio"
                    aria-checked={payment === m.value}
                    onClick={() => setPayment(m.value)}
                    disabled={locked}
                    className={`min-h-10 rounded-lg text-sm font-bold ${payment === m.value ? "bg-surface text-brand shadow-sm" : "text-muted"}`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
              {discountLimitPct > 0 && !showDiscount && (
                <button type="button" onClick={() => setShowDiscount(true)} disabled={locked} className="btn btn-secondary min-h-12 px-3 text-sm">
                  Discount
                </button>
              )}
            </div>
          )}

          {itemCount > 0 && showDiscount && (
            <label className="flex items-center gap-2">
              <span className="text-sm font-medium">Discount ₹</span>
              <input
                type="number"
                inputMode="decimal"
                min="0"
                step="1"
                autoFocus
                value={discountText}
                onChange={(e) => setDiscountText(e.target.value)}
                className="field min-h-10 w-28 py-1"
                aria-invalid={!!discountError}
              />
              <span className={`text-xs ${discountError ? "font-semibold text-danger" : "text-muted"}`}>
                {discountError ?? `up to ${formatINR(discountLimit)}`}
              </span>
            </label>
          )}

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setShowLines((s) => !s)}
              disabled={itemCount === 0}
              className="min-w-0 flex-1 text-left"
              aria-expanded={showLines}
            >
              <p className="text-lg font-bold tabular-nums">{formatINR(total)}</p>
              <p className="text-xs text-muted">
                {itemCount} item{itemCount === 1 ? "" : "s"}
                {discount > 0 && !discountError && <> · was {formatINR(gross)}</>}
                {itemCount > 0 && <span className="font-semibold text-brand"> · {showLines ? "hide" : "view"} order</span>}
              </p>
            </button>
            {itemCount > 0 ? (
              <button type="button" onClick={reset} disabled={locked} className="btn btn-secondary px-4">
                Clear
              </button>
            ) : (
              lastOrder && (
                <button type="button" onClick={repeatLast} disabled={locked} className="btn btn-secondary px-3 text-sm">
                  ↻ Repeat last
                </button>
              )
            )}
            <button
              type="button"
              onClick={submit}
              disabled={itemCount === 0 || busy || !!discountError}
              className="btn btn-primary min-h-14 flex-[1.4] text-lg"
            >
              {busy ? "Saving…" : itemCount > 0 && payment !== "cash" ? `Paid · ${paymentMethodLabel(payment)}` : "Submit order"}
            </button>
          </div>
        </div>
      </div>
      <div aria-hidden className={itemCount > 0 ? (showDiscount ? "h-44" : "h-36") : "h-24"} />

      {picking && (
        <OptionPicker
          group={picking}
          addons={addons}
          onClose={() => setPicking(null)}
          onAdd={(productId, chosen, qty) => {
            setLines((ls) => addLine(ls, productId, chosen, qty));
            setPicking(null);
            navigator.vibrate?.(8);
          }}
        />
      )}

      {toast && (
        <div
          role="status"
          className={`fixed inset-x-4 top-[max(4.5rem,calc(env(safe-area-inset-top)+4rem))] z-30 mx-auto max-w-md rounded-2xl px-4 py-3 text-brand-ink shadow-lg ${
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

/** Bottom sheet: pick a size, add-ons and quantity for one tile. */
function OptionPicker({
  group,
  addons,
  onClose,
  onAdd,
}: {
  group: MenuGroup<SellProduct>;
  addons: SellAddon[];
  onClose: () => void;
  onAdd: (productId: string, addons: Record<string, number>, qty: number) => void;
}) {
  const [productId, setProductId] = useState(group.options[0].id);
  const [chosen, setChosen] = useState<Record<string, number>>({});
  const [qty, setQty] = useState(1);
  const product = group.options.find((o) => o.id === productId) ?? group.options[0];
  const offered = addonsFor(product, addons);
  // Add-ons not offered with the newly picked size are dropped.
  const valid = Object.fromEntries(Object.entries(chosen).filter(([id, q]) => q > 0 && offered.some((a) => a.id === id)));
  const each = Number(product.selling_price) + offered.reduce((s, a) => s + Number(a.price) * (valid[a.id] ?? 0), 0);

  const setAddon = (id: string, q: number) => setChosen((c) => ({ ...c, [id]: Math.max(0, Math.min(10, q)) }));

  return (
    <div className="fixed inset-0 z-20 flex items-end bg-ink/40" role="dialog" aria-modal="true" aria-label={`Options for ${group.name}`} onClick={onClose}>
      <div
        className="mx-auto flex max-h-[85dvh] w-full max-w-md flex-col gap-4 overflow-y-auto rounded-t-3xl bg-surface p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-xl font-bold">{group.name}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="flex size-10 items-center justify-center rounded-full border border-line text-lg">
            ✕
          </button>
        </div>

        {group.options.length > 1 && (
          <div>
            <p className="mb-2 text-sm font-semibold text-muted">Size</p>
            <div role="radiogroup" className="grid grid-cols-2 gap-2">
              {group.options.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  role="radio"
                  aria-checked={o.id === productId}
                  onClick={() => setProductId(o.id)}
                  className={`flex min-h-14 flex-col items-start justify-center rounded-xl border-2 px-3 text-left ${
                    o.id === productId ? "border-brand bg-brand/5" : "border-line"
                  }`}
                >
                  <span className="font-bold">{sizeLabel(o, group)}</span>
                  <span className="text-sm text-muted">{formatINR(o.selling_price)}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {offered.length > 0 && (
          <div>
            <p className="mb-2 text-sm font-semibold text-muted">Add-ons</p>
            <ul className="flex flex-col gap-2">
              {offered.map((a) => {
                const q = valid[a.id] ?? 0;
                return (
                  <li key={a.id} className={`flex items-center gap-2 rounded-xl border-2 px-3 py-2 ${q > 0 ? "border-brand bg-brand/5" : "border-line"}`}>
                    <button type="button" onClick={() => setAddon(a.id, q > 0 ? 0 : 1)} className="min-w-0 flex-1 text-left" aria-pressed={q > 0}>
                      <span className="block font-semibold">{a.name}</span>
                      <span className="text-sm text-muted">+{formatINR(a.price)}</span>
                    </button>
                    {q > 0 && (
                      <>
                        <button type="button" onClick={() => setAddon(a.id, q - 1)} aria-label={`Less ${a.name}`} className="flex size-10 items-center justify-center rounded-full border border-line text-xl font-bold">
                          −
                        </button>
                        <span className="w-5 text-center font-bold tabular-nums">{q}</span>
                        <button type="button" onClick={() => setAddon(a.id, q + 1)} aria-label={`More ${a.name}`} className="flex size-10 items-center justify-center rounded-full border border-line text-xl font-bold">
                          +
                        </button>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => setQty((x) => Math.max(1, x - 1))} aria-label="One less" className="flex size-12 items-center justify-center rounded-full border border-line text-2xl font-bold">
              −
            </button>
            <span className="w-8 text-center text-xl font-bold tabular-nums">{qty}</span>
            <button type="button" onClick={() => setQty((x) => Math.min(99, x + 1))} aria-label="One more" className="flex size-12 items-center justify-center rounded-full border border-line text-2xl font-bold">
              +
            </button>
          </div>
          <button type="button" onClick={() => onAdd(product.id, valid, qty)} className="btn btn-primary min-h-14 flex-1 text-lg">
            Add · {formatINR(each * qty)}
          </button>
        </div>
      </div>
    </div>
  );
}
