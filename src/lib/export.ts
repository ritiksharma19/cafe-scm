import * as XLSX from "xlsx";

export type Cell = string | number | boolean | null | undefined;
export type ExportFormat = "csv" | "xlsx";

/**
 * Text that Excel would treat as a formula (=, +, -, @, tab, CR) is prefixed with an
 * apostrophe, so user-entered text (notes, names) can never execute in a spreadsheet.
 * Numbers are left as real numbers.
 */
export function safeCell(value: Cell): string | number | boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(value)) return `'${value}`;
  return value;
}

/** Builds a CSV or XLSX file from a header row and data rows. */
export function buildExport(format: ExportFormat, sheetName: string, header: string[], rows: Cell[][]): { body: Uint8Array; contentType: string } {
  const aoa = [header, ...rows.map((r) => r.map(safeCell))];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  if (format === "csv") {
    // BOM so Excel opens UTF-8 (₹, names) correctly.
    const csv = "﻿" + XLSX.utils.sheet_to_csv(ws, { forceQuotes: false });
    return { body: new TextEncoder().encode(csv), contentType: "text/csv; charset=utf-8" };
  }
  ws["!cols"] = header.map((h, i) => ({
    wch: Math.min(40, Math.max(h.length, ...rows.slice(0, 200).map((r) => String(r[i] ?? "").length)) + 2),
  }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31));
  const out = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  return {
    body: new Uint8Array(out),
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };
}

/** Rounds for display in exports without float noise (e.g. 0.30000000000000004 → 0.3). */
export function round(n: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
