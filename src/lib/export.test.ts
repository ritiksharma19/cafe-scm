import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { buildExport, round, safeCell } from "./export";

describe("safeCell", () => {
  it("neutralises formula-like text but keeps numbers", () => {
    expect(safeCell("=HYPERLINK(\"http://x\")")).toBe("'=HYPERLINK(\"http://x\")");
    expect(safeCell("+91 98765")).toBe("'+91 98765");
    expect(safeCell("-5 dropped")).toBe("'-5 dropped");
    expect(safeCell("@cmd")).toBe("'@cmd");
    expect(safeCell(-5)).toBe(-5);
    expect(safeCell("Burger")).toBe("Burger");
    expect(safeCell(undefined)).toBeNull();
  });
});

describe("buildExport", () => {
  const header = ["Product", "Qty", "Note"];
  const rows = [
    ["Burger", 3, "=1+1"],
    ["Chai ₹", 2.5, null],
  ];

  it("writes UTF-8 CSV with a BOM", () => {
    const { body, contentType } = buildExport("csv", "Sales", header, rows);
    const text = new TextDecoder().decode(body);
    expect(contentType).toContain("text/csv");
    expect([...body.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // UTF-8 BOM
    expect(text).toContain("Chai ₹,2.5,");
    expect(text).toContain("'=1+1");
  });

  it("writes an xlsx that reads back with real numbers", () => {
    const { body } = buildExport("xlsx", "Sales", header, rows);
    const wb = XLSX.read(body);
    const back = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets.Sales, { header: 1 });
    expect(back[1]).toEqual(["Burger", 3, "'=1+1"]);
    expect(typeof back[2][1]).toBe("number");
  });

  it("round() avoids float noise", () => {
    expect(round(0.1 + 0.2)).toBe(0.3);
    expect(round(2.3456, 2)).toBe(2.35);
  });
});
