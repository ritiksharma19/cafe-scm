"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { LinesEditor, useLines, type StockLine } from "@/components/stock/LinesEditor";
import type { Catalog } from "@/lib/catalog";
import { isDefinitiveFailure } from "@/lib/sale";
import { createClient } from "@/lib/supabase/client";
import { unitChoices } from "@/lib/units";

export interface AddonData {
  id: string | null;
  name: string;
  price: string;
  is_active: boolean;
  items: { material_id: string; quantity: string; entered_unit: string | null }[];
  product_ids: string[];
}

export interface ProductOption {
  id: string;
  name: string;
  category: string | null;
}

/** Creates or edits one add-on: price, ingredients per add-on, and which products offer it. */
export function AddonEditor({ addon, catalog, products }: { addon: AddonData; catalog: Catalog; products: ProductOption[] }) {
  const router = useRouter();
  const initial: StockLine[] = addon.items.flatMap((r, i) => {
    const material = catalog.materials.find((m) => m.id === r.material_id);
    if (!material) return [];
    const choices = unitChoices(material, catalog.units, catalog.conversions);
    const unit = choices.find((c) => c.code === r.entered_unit) ?? choices.find((c) => c.code === material.base_unit) ?? choices[0];
    const base = Number(r.quantity);
    return [{ key: `init-${i}`, material, unit, entered: base / unit.factor, base, cost: null }];
  });
  const lines = useLines(catalog, { initial });
  const [name, setName] = useState(addon.name);
  const [price, setPrice] = useState(addon.price);
  const [active, setActive] = useState(addon.is_active);
  const [selected, setSelected] = useState<Set<string>>(new Set(addon.product_ids));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  function toggle(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function save() {
    // Ingredients are optional (e.g. a free "less spicy" option); only validate lines that exist.
    const items = lines.lines.length || lines.material ? lines.collect() : [];
    if (!items) return;
    const ids = items.map((l) => l.material.id);
    if (new Set(ids).size !== ids.length) {
      setMessage({ ok: false, text: "Each ingredient can appear only once — remove the duplicate." });
      return;
    }
    setBusy(true);
    setMessage(null);
    const { error } = await createClient().rpc("save_addon", {
      p_id: addon.id,
      p_name: name,
      p_price: Number(price || 0),
      p_is_active: active,
      p_items: items.map((l) => ({ material_id: l.material.id, quantity: l.base, entered_qty: l.entered, entered_unit: l.unit.code })),
      p_product_ids: [...selected],
    });
    setBusy(false);
    if (error) {
      setMessage({ ok: false, text: isDefinitiveFailure(error) ? error.message : "No reply — check the connection and try again." });
      return;
    }
    setMessage({ ok: true, text: "Saved. Workers see it on the Sell screen for the ticked products." });
    if (!addon.id) {
      setName("");
      setPrice("");
      setSelected(new Set());
      lines.clearAll();
    }
    router.refresh();
  }

  const byCategory = new Map<string, ProductOption[]>();
  for (const p of products) byCategory.set(p.category || "Other", [...(byCategory.get(p.category || "Other") ?? []), p]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="block min-w-48 flex-1">
          <span className="mb-1.5 block text-sm font-medium">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} className="field" placeholder="e.g. Extra cheese" maxLength={40} />
        </label>
        <label className="block w-32">
          <span className="mb-1.5 block text-sm font-medium">Price (₹)</span>
          <input value={price} onChange={(e) => setPrice(e.target.value)} type="number" inputMode="decimal" min="0" step="0.5" className="field" />
        </label>
        <label className="flex min-h-12 items-center gap-2">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="size-5 accent-brand" />
          <span className="text-sm font-medium">On sale</span>
        </label>
      </div>

      <div>
        <p className="mb-1 text-sm font-medium">Ingredients used by ONE add-on</p>
        <p className="mb-2 text-xs text-muted">Deducted from stock each time it is sold. Leave empty for free options like “less spicy”.</p>
        <LinesEditor state={lines} disabled={busy} addLabel="Add ingredient" />
      </div>

      <div>
        <p className="mb-2 text-sm font-medium">Offered with</p>
        {products.length === 0 ? (
          <p className="text-sm text-muted">No products yet.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {[...byCategory.entries()].map(([cat, list]) => (
              <div key={cat}>
                {byCategory.size > 1 && <p className="mb-1 text-xs font-semibold uppercase text-muted">{cat}</p>}
                <div className="flex flex-wrap gap-2">
                  {list.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => toggle(p.id)}
                      aria-pressed={selected.has(p.id)}
                      className={`min-h-10 rounded-full border px-3 text-sm font-semibold ${
                        selected.has(p.id) ? "border-brand bg-brand text-brand-ink" : "border-line bg-surface"
                      }`}
                    >
                      {selected.has(p.id) ? "✓ " : ""}
                      {p.name}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            <p className="text-xs text-muted">Sizes of a ticked product (e.g. Burger Double) offer it too.</p>
          </div>
        )}
      </div>

      {message && <p className={`text-sm font-medium ${message.ok ? "text-ok" : "text-danger"}`}>{message.text}</p>}
      <button type="button" onClick={save} disabled={busy} className="btn btn-primary self-start">
        {busy ? "Saving…" : addon.id ? "Save add-on" : "Create add-on"}
      </button>
    </div>
  );
}
