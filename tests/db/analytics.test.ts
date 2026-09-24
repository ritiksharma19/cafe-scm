import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { as, asCommitted, createTestDb, createUser, locationId, rejects, type Db, type Tx } from "./harness";
import { actAs, idsByName, sampleSheet } from "./fixtures";

let db: Db;
let admin: string;
let worker1: string;
let worker2: string;
let cart1: string;
let cart2: string;
let mat: Record<string, string>;
let prod: Record<string, string>;

/** Past consumption written straight to the ledger (sales can't be back-dated beyond 72h). */
async function pastUse(tx: Tx, material: string, location: string, qty: number, daysAgo: number, type = "SALE_CONSUMPTION") {
  await tx.exec("reset role");
  await tx.query(
    `insert into public.stock_movements (material_id, location_id, qty_delta, movement_type, ref_type, unit_cost, occurred_at)
     values ($1, $2, $3, $4, 'adjustment', 25, now() - make_interval(days => $5))`,
    [mat[material], location, -qty, type, daysAgo],
  );
  await tx.exec("set local role authenticated");
}

type Summary = {
  current: Record<string, number>;
  previous: Record<string, number>;
  carts: ({ location_id: string } & Record<string, unknown>)[];
  pending_requests: number;
};

type StatusRow = { name: string; quantity: string; avg_daily_use: string | null; days_left: string | null; status: string; suggested_reorder: string | null; days_of_data: number };

async function status(tx: Tx, material: string, location: string | null): Promise<StatusRow | undefined> {
  const r = await tx.query<StatusRow>("select * from public.stock_status($1)", [location]);
  return r.rows.find((x) => x.name === material);
}

beforeAll(async () => {
  db = await createTestDb();
  admin = await createUser(db, { username: "owner", role: "admin" });
  worker1 = await createUser(db, { username: "ravi", role: "worker", locationCode: "CART1" });
  worker2 = await createUser(db, { username: "sunil", role: "worker", locationCode: "CART2" });
  cart1 = await locationId(db, "CART1");
  cart2 = await locationId(db, "CART2");

  await asCommitted(db, admin, async (tx) => {
    await tx.query("select public.import_recipe_sheet($1)", [JSON.stringify(sampleSheet())]);
    mat = await idsByName(tx, "raw_materials");
    prod = await idsByName(tx, "products");
    await tx.query("update public.products set selling_price = 120 where name = 'Burger'");
    await tx.query("update public.raw_materials set avg_unit_cost = 25, lead_time_days = 1 where name = 'Veg Patty'");
    await tx.query("update public.raw_materials set avg_unit_cost = 8 where name = 'Burger Bun'");
    for (const [loc, name, qty] of [
      [cart1, "Veg Patty", 30],
      [cart1, "Burger Bun", 30],
      [cart2, "Veg Patty", 30],
      [cart2, "Burger Bun", 30],
    ] as const) {
      await tx.query("select public.admin_adjust_stock($1, $2, $3, 'OPENING_BALANCE')", [loc, mat[name], qty]);
    }
  });
});

describe("stock_status (runway)", () => {
  it("10/day for 5 days with 30 left → 3 days left, LOW (lead time 1 + 2)", async () => {
    await as(db, admin, async (tx) => {
      for (let d = 1; d <= 5; d++) await pastUse(tx, "Veg Patty", cart1, 10, d);
      const s = await status(tx, "Veg Patty", cart1);
      expect(s).toMatchObject({ quantity: "30.000", avg_daily_use: "10.000", days_left: "3.0", status: "low", days_of_data: 5 });
      // No target level: suggested = avg × (lead 1 + cover 7) − 30 = 50
      expect(s!.suggested_reorder).toBe("50");
    });
  });

  it("runs out within the lead time → CRITICAL", async () => {
    await as(db, admin, async (tx) => {
      for (let d = 1; d <= 5; d++) await pastUse(tx, "Veg Patty", cart1, 20, d);
      expect(await status(tx, "Veg Patty", cart1)).toMatchObject({ days_left: "1.5", status: "low" });
      await tx.exec("reset role");
      await tx.query("update public.raw_materials set lead_time_days = 2 where name = 'Veg Patty'");
      await tx.exec("set local role authenticated");
      expect(await status(tx, "Veg Patty", cart1)).toMatchObject({ status: "critical" });
    });
  });

  it("fewer than 3 days of history → no average (insufficient data), not a guess", async () => {
    await as(db, admin, async (tx) => {
      await pastUse(tx, "Burger Bun", cart1, 10, 1);
      await pastUse(tx, "Burger Bun", cart1, 10, 2);
      expect(await status(tx, "Burger Bun", cart1)).toMatchObject({ avg_daily_use: null, days_left: null, status: "unknown", days_of_data: 2 });
    });
  });

  it("uses configured levels: business-wide and per-location", async () => {
    await as(db, admin, async (tx) => {
      await tx.query("update public.raw_materials set min_level = 70, reorder_level = 100, target_level = 150 where name = 'Burger Bun'");
      // Business-wide total 60 ≤ min 70 → critical; target 150 → reorder 90
      expect(await status(tx, "Burger Bun", null)).toMatchObject({ quantity: "60.000", status: "critical", suggested_reorder: "90.000" });
      // Cart 1 has no per-location levels → material levels do not apply to a single cart
      expect((await status(tx, "Burger Bun", cart1))!.status).toBe("unknown");
      await tx.query(
        "insert into public.location_material_settings (location_id, material_id, min_level, reorder_level) values ($1, $2, 10, 40)",
        [cart1, mat["Burger Bun"]],
      );
      expect((await status(tx, "Burger Bun", cart1))!.status).toBe("low");
    });
  });

  it("negative stock is always critical", async () => {
    await as(db, admin, async (tx) => {
      await actAs(tx, worker1);
      await tx.query("select public.record_sale($1, $2)", [randomUUID(), JSON.stringify([{ product_id: prod["Burger"], quantity: 31 }])]);
      await actAs(tx, admin);
      expect(await status(tx, "Veg Patty", cart1)).toMatchObject({ quantity: "-1.000", status: "critical" });
    });
  });
});

describe("dashboard_summary", () => {
  it("totals, per-cart figures and the previous period", async () => {
    await as(db, admin, async (tx) => {
      await actAs(tx, worker1);
      await tx.query("select public.record_sale($1, $2)", [randomUUID(), JSON.stringify([{ product_id: prod["Burger"], quantity: 2 }])]);
      await tx.query("select public.record_sale($1, $2)", [randomUUID(), JSON.stringify([{ product_id: prod["Burger"], quantity: 1 }])]);
      await tx.query("select public.record_wastage($1, $2, 2, 'dropped')", [randomUUID(), mat["Veg Patty"]]);
      await actAs(tx, worker2);
      await tx.query("select public.record_sale($1, $2)", [randomUUID(), JSON.stringify([{ product_id: prod["Burger"], quantity: 4 }])]);
      await tx.query("select public.create_stock_request($1, $2)", [randomUUID(), JSON.stringify([{ material_id: mat["Milk"], quantity: 1000 }])]);
      await actAs(tx, admin);

      const r = await tx.query<{ s: Summary }>(
        "select public.dashboard_summary(now() - interval '1 hour', now() + interval '1 hour') as s",
      );
      const s = r.rows[0].s;
      expect(s.current).toMatchObject({ orders: 3, items: 7, sales: 840, wastage_cost: 50, consumption_cost: 231 }); // 7×(25+8)
      expect(s.previous).toMatchObject({ orders: 0, sales: 0 });
      const c1 = s.carts.find((c) => c.location_id === cart1);
      expect(c1).toMatchObject({ orders: 2, items: 3, sales: 360, wastage_cost: 50 });
      expect(s.pending_requests).toBe(1);
      expect(s.carts).toHaveLength(3);
    });
  });
});

describe("period analytics", () => {
  it("product_sales and material_flow reflect sales, voids and wastage", async () => {
    await as(db, admin, async (tx) => {
      await actAs(tx, worker1);
      const voided = randomUUID();
      await tx.query("select public.record_sale($1, $2)", [randomUUID(), JSON.stringify([{ product_id: prod["Burger"], quantity: 3 }])]);
      await tx.query("select public.record_sale($1, $2)", [voided, JSON.stringify([{ product_id: prod["Burger"], quantity: 5 }])]);
      await tx.query("select public.record_wastage($1, $2, 1, 'spoiled')", [randomUUID(), mat["Burger Bun"]]);
      await actAs(tx, admin);
      await tx.query("select public.void_order($1, 'test')", [voided]);

      const ps = await tx.query("select name, quantity::int, sales::numeric::text as sales from public.product_sales(now() - interval '1 hour', now() + interval '1 hour')");
      expect(ps.rows).toEqual([{ name: "Burger", quantity: 3, sales: "360.00" }]);

      const flow = await tx.query<{ name: string; consumed: string; wasted: string; consumed_cost: string }>(
        "select name, consumed, wasted, consumed_cost from public.material_flow(now() - interval '1 hour', now() + interval '1 hour', $1)",
        [cart1],
      );
      const bun = flow.rows.find((x) => x.name === "Burger Bun")!;
      expect(bun).toMatchObject({ consumed: "3.000", wasted: "1.000", consumed_cost: "24.00" });
    });
  });

  it("daily_trend and hourly_orders use India time (00:15 IST counts on the new day, hour 0)", async () => {
    await as(db, admin, async (tx) => {
      await tx.exec("reset role");
      // 2026-09-20 18:45 UTC = 2026-09-21 00:15 IST
      await tx.query(
        `insert into public.orders (id, location_id, worker_id, occurred_at, item_count, total_amount)
         values (gen_random_uuid(), $1, $2, '2026-09-20T18:45:00Z', 2, 240)`,
        [cart1, worker1],
      );
      await tx.exec("set local role authenticated");
      const days = await tx.query<{ day: string; orders: string; sales: string }>(
        "select day::text, orders::text, sales::text from public.daily_trend('2026-09-19T18:30:00Z', '2026-09-21T18:30:00Z')",
      );
      expect(days.rows).toEqual([
        { day: "2026-09-20", orders: "0", sales: "0" },
        { day: "2026-09-21", orders: "1", sales: "240.00" },
      ]);
      const hours = await tx.query<{ hour: number; orders: string }>(
        "select hour, orders::text from public.hourly_orders('2026-09-19T18:30:00Z', '2026-09-21T18:30:00Z') where orders > 0",
      );
      expect(hours.rows).toEqual([{ hour: 0, orders: "1" }]);
    });
  });
});

describe("product_costs", () => {
  it("compares ingredient cost now vs a past date from the cost history", async () => {
    await as(db, admin, async (tx) => {
      await tx.exec("reset role");
      await tx.query("update public.product_recipes set effective_from = effective_from - interval '60 days' where version = 1");
      for (const [name, cost] of [
        ["Burger Bun", 6],
        ["Veg Patty", 22],
      ] as const) {
        await tx.query(
          `insert into public.audit_logs (action, entity, entity_id, new_value, created_at)
           values ('update', 'raw_materials', $1, jsonb_build_object('avg_unit_cost', $2::numeric), now() - interval '40 days')`,
          [mat[name], cost],
        );
      }
      await tx.exec("set local role authenticated");

      const r = await tx.query<{ name: string; cost_now: string; cost_then: string; then_complete: boolean; ingredients: Record<string, unknown>[] }>(
        "select name, cost_now::text, cost_then::text, then_complete, ingredients from public.product_costs(now() - interval '30 days')",
      );
      const burger = r.rows.find((x) => x.name === "Burger")!;
      expect(burger).toMatchObject({ cost_now: "33.00", cost_then: "28.00", then_complete: true }); // 8+25 vs 6+22
      expect(burger.ingredients[0]).toMatchObject({ material: "Veg Patty", cost_now: 25, cost_then: 22 });
    });
  });
});

describe("access", () => {
  it.each([
    "select * from public.stock_status(null)",
    "select public.dashboard_summary(now() - interval '1 day', now())",
    "select * from public.product_sales(now() - interval '1 day', now())",
    "select * from public.material_flow(now() - interval '1 day', now())",
    "select * from public.product_costs(now())",
  ])("workers cannot run %s", async (sql) => {
    await rejects(as(db, worker1, (tx) => tx.query(sql)), /Admin only/);
  });
});
