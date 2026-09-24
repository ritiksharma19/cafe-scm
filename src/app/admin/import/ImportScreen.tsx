"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { formatINR } from "@/lib/format";
import { previewImport, type ExistingCatalog, type ImportPreview } from "@/lib/import-preview";
import { formatQuantityCell, parseRecipeSheet } from "@/lib/recipe-sheet";
import { isDefinitiveFailure } from "@/lib/sale";
import { createClient } from "@/lib/supabase/client";

const MAX_BYTES = 5 * 1024 * 1024;

type Workbook = { name: string; sheets: Record<string, unknown[][]> };

const q = (v: number | null, unit: string) => (v === null ? "—" : String(formatQuantityCell(v, unit)));

export function ImportScreen({ existing }: { existing: ExistingCatalog }) {
  const router = useRouter();
  const [book, setBook] = useState<Workbook | null>(null);
  const [sheetName, setSheetName] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Record<string, number> | null>(null);

  const preview: ImportPreview | null = book && sheetName ? previewImport(parseRecipeSheet(book.sheets[sheetName]), existing) : null;
  const nothingToDo =
    preview !== null &&
    preview.counts.newMaterials + preview.counts.newProducts + preview.counts.changedRecipes + preview.counts.priceChanges === 0;

  async function onFile(file: File | undefined) {
    setError(null);
    setResult(null);
    setBook(null);
    if (!file) return;
    if (file.size > MAX_BYTES) return setError("That file is larger than 5 MB — is it the right one?");
    try {
      const XLSX = await import("xlsx");
      const wb = XLSX.read(await file.arrayBuffer());
      const sheets: Workbook["sheets"] = {};
      for (const name of wb.SheetNames) {
        sheets[name] = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, defval: "", blankrows: true });
      }
      setBook({ name: file.name, sheets });
      setSheetName(wb.SheetNames[0] ?? "");
    } catch {
      setError("Could not read this file. Use .xlsx, .xls or .csv.");
    }
  }

  async function runImport() {
    if (!preview || preview.blocking.length) return;
    setBusy(true);
    setError(null);
    const { data, error: rpcError } = await createClient().rpc("import_recipe_sheet", { p_sheet: preview.payload });
    setBusy(false);
    if (rpcError) {
      setError(
        isDefinitiveFailure(rpcError)
          ? `Nothing was imported: ${rpcError.message}`
          : "No reply from the server. Re-importing the same file is safe — unchanged rows are skipped.",
      );
      return;
    }
    setResult(data as Record<string, number>);
    setBook(null);
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-5">
      {result && (
        <div role="status" className="rounded-xl bg-ok px-4 py-3 text-brand-ink">
          <p className="font-bold">✓ Import complete</p>
          <p className="text-sm">
            {result.materials_created} new materials · {result.products_created} new products · {result.recipes_created} recipe
            versions · {result.prices_updated ?? 0} prices updated · {result.recipes_unchanged} unchanged
          </p>
        </div>
      )}

      <section className="card flex flex-col gap-3 p-5">
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Excel or CSV file</span>
          <input
            type="file"
            accept=".xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv"
            onChange={(e) => onFile(e.target.files?.[0])}
            className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-brand file:px-4 file:py-2.5 file:font-semibold file:text-brand-ink"
          />
        </label>
        {book && Object.keys(book.sheets).length > 1 && (
          <label className="block max-w-xs">
            <span className="mb-1.5 block text-sm font-medium">Sheet</span>
            <select value={sheetName} onChange={(e) => setSheetName(e.target.value)} className="field">
              {Object.keys(book.sheets).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        )}
        {error && <p className="text-sm font-medium text-danger">{error}</p>}
      </section>

      {preview && (
        <>
          <section className="grid grid-cols-2 gap-3 md:grid-cols-5">
            {[
              ["New materials", preview.counts.newMaterials],
              ["New products", preview.counts.newProducts],
              ["Recipes changing", preview.counts.changedRecipes],
              ["Price changes", preview.counts.priceChanges],
              ["Unchanged", preview.counts.unchanged],
            ].map(([label, n]) => (
              <div key={label} className="card p-4">
                <p className="text-xs font-semibold uppercase text-muted">{label}</p>
                <p className="text-2xl font-bold tabular-nums">{n}</p>
              </div>
            ))}
          </section>

          {preview.blocking.length > 0 && (
            <section className="card border-danger/50 p-5">
              <h2 className="mb-2 font-bold text-danger">Fix these in the sheet first ({preview.blocking.length})</h2>
              <ul className="list-disc pl-5 text-sm">
                {preview.blocking.map((b, i) => (
                  <li key={i}>{b}</li>
                ))}
              </ul>
            </section>
          )}

          <section className="card p-5">
            <h2 className="mb-3 font-bold">Products</h2>
            <ul className="divide-y divide-line">
              {preview.products.map((p) => (
                <li key={p.name} className="flex flex-col gap-1 py-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-bold">{p.name}</span>
                    <span className="text-xs text-muted">row {p.row}</span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-bold ${
                        p.status === "new" ? "bg-brand/10 text-brand" : p.status === "changed" ? "bg-warn/10 text-warn" : "bg-bg text-muted"
                      }`}
                    >
                      {p.status === "new" ? "NEW" : p.status === "changed" ? "RECIPE CHANGES → new version" : "NO CHANGE"}
                    </span>
                    {p.price && (
                      <span className="text-xs font-semibold">
                        Price {p.price.from === null ? "" : `${formatINR(p.price.from)} → `}
                        {formatINR(p.price.to)}
                      </span>
                    )}
                  </div>
                  {p.changes.length > 0 && (
                    <p className="text-muted">
                      {p.changes
                        .map((c) =>
                          c.from === null
                            ? `+ ${c.material} ${q(c.to, c.baseUnit)}`
                            : c.to === null
                              ? `− ${c.material} (removed)`
                              : `${c.material} ${q(c.from, c.baseUnit)} → ${q(c.to, c.baseUnit)}`,
                        )
                        .join(" · ")}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </section>

          {preview.materials.some((m) => m.status === "new") && (
            <section className="card p-5 text-sm">
              <h2 className="mb-2 font-bold">New raw materials</h2>
              <p>
                {preview.materials
                  .filter((m) => m.status === "new")
                  .map((m) => `${m.name} (${m.baseUnit === "g" ? "weight" : m.baseUnit === "ml" ? "volume" : "pieces"})`)
                  .join(" · ")}
              </p>
              <p className="mt-2 text-xs text-muted">Set their reorder levels and costs under Raw materials after importing.</p>
            </section>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={runImport}
              disabled={busy || preview.blocking.length > 0 || nothingToDo}
              className="btn btn-primary"
            >
              {busy ? "Importing…" : "Import"}
            </button>
            {nothingToDo && <p className="text-sm text-muted">Everything in this sheet already matches the app.</p>}
            <p className="text-xs text-muted">Recipe changes apply to new sales only; past orders keep their recipe.</p>
          </div>
        </>
      )}
    </div>
  );
}
