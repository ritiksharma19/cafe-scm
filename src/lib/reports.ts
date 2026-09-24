import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getMaterialFlow, getStockStatus } from "@/lib/analytics";
import { round, type Cell } from "@/lib/export";
import { BUSINESS_TZ } from "@/lib/format";
import { MOVEMENT_LABELS } from "@/lib/movements";
import { formatQuantityCell } from "@/lib/recipe-sheet";
import { createClient } from "@/lib/supabase/server";

export const REPORTS = {
  sales: { title: "Sales", description: "Every order line: time, cart, product, quantity, price." },
  inventory: { title: "Inventory", description: "Current stock at every location, value and status." },
  movements: { title: "Stock movements", description: "The full stock ledger for the period, every change with its reason." },
  purchases: { title: "Purchases", description: "Receipt lines: supplier, bill, quantity, amount paid." },
  wastage: { title: "Wastage", description: "What was wasted, where, why, and its cost." },
  consumption: { title: "Ingredient consumption", description: "Per material: used in sales, wasted, purchased, variance." },
  recipes: { title: "Recipes (re-importable)", description: "Current recipes and prices in the import format." },
} as const;

export type ReportKey = keyof typeof REPORTS;

export interface ReportData {
  sheet: string;
  header: string[];
  rows: Cell[][];
}

export interface ReportParams {
  from: Date;
  to: Date;
  locationId: string | null;
}

const PAGE = 1000; // PostgREST returns at most this many rows per request.

/** Fetches every page of a query (PostgREST caps each response). */
async function fetchAll<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await build(offset, offset + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) return out;
    if (offset > 500_000) throw new Error("Report too large — choose a shorter period.");
  }
}

const dateFmt = new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const timeFmt = new Intl.DateTimeFormat("en-GB", { timeZone: BUSINESS_TZ, hour: "2-digit", minute: "2-digit" });
const d = (iso: string) => dateFmt.format(new Date(iso));
const t = (iso: string) => timeFmt.format(new Date(iso));

async function unitFactors(supabase: SupabaseClient): Promise<Map<string, number>> {
  const { data } = await supabase.from("units").select("code, factor_to_base");
  return new Map((data ?? []).map((u: { code: string; factor_to_base: string }) => [u.code, Number(u.factor_to_base)]));
}

export async function buildReport(key: ReportKey, p: ReportParams): Promise<ReportData> {
  const supabase = await createClient();
  const f = await unitFactors(supabase);
  const disp = (baseQty: number | string, unit: string) => round(Number(baseQty) / (f.get(unit) ?? 1));
  const inRange = <Q extends { gte: (c: string, v: string) => Q; lt: (c: string, v: string) => Q }>(q: Q, col = "occurred_at") =>
    q.gte(col, p.from.toISOString()).lt(col, p.to.toISOString());

  switch (key) {
    case "sales": {
      type Row = {
        quantity: number;
        unit_price: string;
        line_total: string;
        product: { name: string } | null;
        order: { id: string; occurred_at: string; status: string; location: { name: string } | null; worker: { full_name: string } | null };
      };
      const rows = await fetchAll<Row>((a, b) => {
        let q = supabase
          .from("order_items")
          .select(
            "quantity, unit_price, line_total, product:products(name), order:orders!inner(id, occurred_at, status, location_id, location:locations(name), worker:profiles!orders_worker_id_fkey(full_name))",
          )
          .gte("order.occurred_at", p.from.toISOString())
          .lt("order.occurred_at", p.to.toISOString())
          .order("created_at")
          .range(a, b);
        if (p.locationId) q = q.eq("order.location_id", p.locationId);
        return q.returns<Row[]>();
      });
      rows.sort((x, y) => x.order.occurred_at.localeCompare(y.order.occurred_at));
      return {
        sheet: "Sales",
        header: ["Date", "Time", "Location", "Order ID", "Status", "Product", "Quantity", "Unit price (₹)", "Line total (₹)", "Recorded by"],
        rows: rows.map((r) => [
          d(r.order.occurred_at), t(r.order.occurred_at), r.order.location?.name, r.order.id, r.order.status,
          r.product?.name, r.quantity, Number(r.unit_price), Number(r.line_total), r.order.worker?.full_name,
        ]),
      };
    }

    case "inventory": {
      const [{ data: locations }, { data: materials }, levels, status] = await Promise.all([
        supabase.from("locations").select("id, name").eq("is_active", true).order("sort_order"),
        supabase.from("raw_materials").select("id, name, display_unit, avg_unit_cost").eq("is_active", true).order("name"),
        fetchAll<{ location_id: string; material_id: string; quantity: string }>((a, b) =>
          supabase.from("stock_levels").select("location_id, material_id, quantity").range(a, b),
        ),
        getStockStatus(null),
      ]);
      const qty = new Map(levels.map((l) => [`${l.location_id}:${l.material_id}`, Number(l.quantity)]));
      const st = new Map(status.map((s) => [s.material_id, s]));
      const locs = (locations ?? []) as { id: string; name: string }[];
      return {
        sheet: "Inventory",
        header: ["Raw material", "Unit", ...locs.map((l) => l.name), "Total", "Cost per unit (₹)", "Value (₹)", "Status", "Days left"],
        rows: ((materials ?? []) as { id: string; name: string; display_unit: string; avg_unit_cost: string }[]).map((m) => {
          const per = locs.map((l) => qty.get(`${l.id}:${m.id}`) ?? 0);
          const total = per.reduce((s, x) => s + x, 0);
          const s = st.get(m.id);
          return [
            m.name, m.display_unit, ...per.map((x) => disp(x, m.display_unit)), disp(total, m.display_unit),
            round(Number(m.avg_unit_cost) * (f.get(m.display_unit) ?? 1), 2),
            round(Math.max(total, 0) * Number(m.avg_unit_cost), 2),
            s?.status ?? "", s?.days_left !== null && s?.days_left !== undefined ? Number(s.days_left) : "",
          ];
        }),
      };
    }

    case "movements": {
      type Row = {
        occurred_at: string; qty_delta: string; movement_type: string; unit_cost: string | null; notes: string | null; ref_type: string;
        location: { name: string } | null; material: { name: string; display_unit: string } | null; creator: { full_name: string } | null;
      };
      const rows = await fetchAll<Row>((a, b) => {
        let q = inRange(
          supabase
            .from("stock_movements")
            .select("occurred_at, qty_delta, movement_type, unit_cost, notes, ref_type, location:locations(name), material:raw_materials(name, display_unit), creator:profiles!stock_movements_created_by_fkey(full_name)"),
        )
          .order("occurred_at")
          .order("id")
          .range(a, b);
        if (p.locationId) q = q.eq("location_id", p.locationId);
        return q.returns<Row[]>();
      });
      return {
        sheet: "Stock movements",
        header: ["Date", "Time", "Location", "Raw material", "Movement", "Quantity", "Unit", "Unit cost (₹)", "Value (₹)", "Notes", "By"],
        rows: rows.map((r) => {
          const unit = r.material?.display_unit ?? "";
          return [
            d(r.occurred_at), t(r.occurred_at), r.location?.name, r.material?.name, MOVEMENT_LABELS[r.movement_type] ?? r.movement_type,
            disp(r.qty_delta, unit), unit,
            r.unit_cost !== null ? round(Number(r.unit_cost) * (f.get(unit) ?? 1), 2) : null,
            r.unit_cost !== null ? round(Number(r.qty_delta) * Number(r.unit_cost), 2) : null,
            r.notes, r.creator?.full_name,
          ];
        }),
      };
    }

    case "purchases": {
      type Row = {
        quantity: string; line_cost: string | null; unit_cost: string | null; material: { name: string; display_unit: string } | null;
        receipt: { occurred_at: string; status: string; invoice_ref: string | null; location: { name: string } | null; supplier: { name: string } | null; receiver: { full_name: string } | null };
      };
      const rows = await fetchAll<Row>((a, b) => {
        let q = supabase
          .from("purchase_receipt_items")
          .select(
            "quantity, line_cost, unit_cost, material:raw_materials(name, display_unit), receipt:purchase_receipts!inner(occurred_at, status, invoice_ref, location_id, location:locations(name), supplier:suppliers(name), receiver:profiles!purchase_receipts_received_by_fkey(full_name))",
          )
          .gte("receipt.occurred_at", p.from.toISOString())
          .lt("receipt.occurred_at", p.to.toISOString())
          .order("created_at")
          .range(a, b);
        if (p.locationId) q = q.eq("receipt.location_id", p.locationId);
        return q.returns<Row[]>();
      });
      return {
        sheet: "Purchases",
        header: ["Date", "Location", "Supplier", "Bill no.", "Raw material", "Quantity", "Unit", "Amount paid (₹)", "Price per unit (₹)", "Status", "Received by"],
        rows: rows.map((r) => {
          const unit = r.material?.display_unit ?? "";
          return [
            d(r.receipt.occurred_at), r.receipt.location?.name, r.receipt.supplier?.name, r.receipt.invoice_ref, r.material?.name,
            disp(r.quantity, unit), unit, r.line_cost !== null ? Number(r.line_cost) : null,
            r.unit_cost !== null ? round(Number(r.unit_cost) * (f.get(unit) ?? 1), 2) : null, r.receipt.status, r.receipt.receiver?.full_name,
          ];
        }),
      };
    }

    case "wastage": {
      type Row = {
        id: string; occurred_at: string; quantity: string; reason: string; notes: string | null; status: string;
        location: { name: string } | null; material: { name: string; display_unit: string } | null; recorder: { full_name: string } | null;
      };
      const [rows, costs] = await Promise.all([
        fetchAll<Row>((a, b) => {
          let q = inRange(
            supabase
              .from("wastage")
              .select("id, occurred_at, quantity, reason, notes, status, location:locations(name), material:raw_materials(name, display_unit), recorder:profiles!wastage_recorded_by_fkey(full_name)"),
          )
            .order("occurred_at")
            .range(a, b);
          if (p.locationId) q = q.eq("location_id", p.locationId);
          return q.returns<Row[]>();
        }),
        fetchAll<{ ref_id: string; qty_delta: string; unit_cost: string | null }>((a, b) =>
          inRange(supabase.from("stock_movements").select("ref_id, qty_delta, unit_cost").eq("movement_type", "WASTAGE")).range(a, b),
        ),
      ]);
      const cost = new Map(costs.map((c) => [c.ref_id, round(-Number(c.qty_delta) * Number(c.unit_cost ?? 0), 2)]));
      return {
        sheet: "Wastage",
        header: ["Date", "Time", "Location", "Raw material", "Quantity", "Unit", "Reason", "Cost (₹)", "Status", "Note", "Recorded by"],
        rows: rows.map((r) => {
          const unit = r.material?.display_unit ?? "";
          return [
            d(r.occurred_at), t(r.occurred_at), r.location?.name, r.material?.name, disp(r.quantity, unit), unit,
            r.reason.replace("_", " "), cost.get(r.id) ?? null, r.status, r.notes, r.recorder?.full_name,
          ];
        }),
      };
    }

    case "consumption": {
      const flow = await getMaterialFlow(p.from, p.to, p.locationId);
      return {
        sheet: "Consumption",
        header: [
          "Raw material", "Unit", "Used in sales (expected)", "Wasted", "Inventory variance (counts/adjustments)", "Actual use",
          "Purchased", "Transfers in", "Transfers out", "Cost used in sales (₹)", "Wastage cost (₹)", "Purchase value (₹)", "Stock now",
        ],
        rows: flow.map((r) => {
          const u = r.display_unit;
          return [
            r.name, u, disp(r.consumed, u), disp(r.wasted, u), disp(r.count_adjust, u),
            disp(Number(r.consumed) + Number(r.wasted) - Number(r.count_adjust), u), disp(r.purchased, u),
            disp(r.transfer_in, u), disp(r.transfer_out, u), Number(r.consumed_cost), Number(r.wasted_cost), Number(r.purchased_cost),
            disp(r.current_qty, u),
          ];
        }),
      };
    }

    case "recipes": {
      type Row = {
        name: string; selling_price: string;
        product_recipes: { recipe_items: { quantity: string; material: { name: string; base_unit: string } | null }[] }[];
      };
      const { data, error } = await supabase
        .from("products")
        .select("name, selling_price, sort_order, product_recipes!inner(recipe_items(quantity, material:raw_materials(name, base_unit)))")
        .is("product_recipes.effective_to", null)
        .eq("is_active", true)
        .order("sort_order")
        .returns<Row[]>();
      if (error) throw new Error(error.message);
      const materials: string[] = [];
      for (const p of data ?? [])
        for (const i of p.product_recipes[0]?.recipe_items ?? [])
          if (i.material && !materials.includes(i.material.name)) materials.push(i.material.name);
      return {
        sheet: "Recipes",
        header: ["Product", "Price", ...materials],
        rows: (data ?? []).map((p) => {
          const byName = new Map((p.product_recipes[0]?.recipe_items ?? []).map((i) => [i.material?.name, i]));
          return [
            p.name, Number(p.selling_price),
            ...materials.map((m) => {
              const i = byName.get(m);
              return i && i.material ? formatQuantityCell(Number(i.quantity), i.material.base_unit) : "";
            }),
          ];
        }),
      };
    }
  }
}
