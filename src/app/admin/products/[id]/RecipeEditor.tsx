"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { LinesEditor, useLines, type StockLine } from "@/components/stock/LinesEditor";
import type { Catalog } from "@/lib/catalog";
import { isDefinitiveFailure } from "@/lib/sale";
import { createClient } from "@/lib/supabase/client";
import { unitChoices } from "@/lib/units";

export interface RecipeLine {
  material_id: string;
  quantity: string; // base units
  entered_qty: string | null;
  entered_unit: string | null;
}

/** Edits the ingredients of ONE product. Saving creates a new recipe version. */
export function RecipeEditor({ productId, catalog, current }: { productId: string; catalog: Catalog; current: RecipeLine[] }) {
  const router = useRouter();
  const initial: StockLine[] = current.flatMap((r, i) => {
    const material = catalog.materials.find((m) => m.id === r.material_id);
    if (!material) return [];
    const choices = unitChoices(material, catalog.units, catalog.conversions);
    const unit = choices.find((c) => c.code === r.entered_unit) ?? choices.find((c) => c.code === material.base_unit) ?? choices[0];
    const base = Number(r.quantity);
    return [{ key: `init-${i}`, material, unit, entered: base / unit.factor, base, cost: null }];
  });
  const lines = useLines(catalog, { initial });
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function save() {
    const items = lines.collect();
    if (!items) return;
    const ids = items.map((l) => l.material.id);
    if (new Set(ids).size !== ids.length) {
      setMessage({ ok: false, text: "Each ingredient can appear only once — remove the duplicate." });
      return;
    }
    setBusy(true);
    setMessage(null);
    const { error } = await createClient().rpc("save_recipe", {
      p_product_id: productId,
      p_items: items.map((l) => ({ material_id: l.material.id, quantity: l.base, entered_qty: l.entered, entered_unit: l.unit.code })),
      p_notes: notes || null,
    });
    setBusy(false);
    if (error) {
      setMessage({ ok: false, text: isDefinitiveFailure(error) ? error.message : "No reply — check the connection and try again." });
      return;
    }
    lines.clearAll();
    lines.setLines(items.map((l, i) => ({ ...l, key: `saved-${i}` })));
    setNotes("");
    setMessage({ ok: true, text: "New recipe version saved. Sales from now on use it; past orders keep their recipe." });
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">Quantities are per ONE product sold.</p>
      <LinesEditor state={lines} disabled={busy} addLabel="Add ingredient" />
      <label className="block">
        <span className="mb-1.5 block text-sm font-medium">What changed? — optional</span>
        <input value={notes} onChange={(e) => setNotes(e.target.value)} className="field" placeholder="e.g. bigger patty" />
      </label>
      {message && <p className={`text-sm font-medium ${message.ok ? "text-ok" : "text-danger"}`}>{message.text}</p>}
      <button type="button" onClick={save} disabled={busy} className="btn btn-primary self-start">
        {busy ? "Saving…" : "Save as new version"}
      </button>
    </div>
  );
}
