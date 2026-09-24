import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { as, asCommitted, asOwner, createTestDb, createUser, locationId, rejects, type Db, type Tx } from "./harness";
import { sampleSheet } from "./fixtures";

let db: Db;
let admin: string;
let worker1: string;
let worker2: string;
let cart1: string;
let cart2: string;
const product: Record<string, string> = {};
const material: Record<string, string> = {};

type SaleResult = { status: string; order_id: string; item_count: number; total_amount: number; negative_materials: string[] };

async function sell(tx: Tx, orderId: string, items: [string, number][], occurredAt?: string): Promise<SaleResult> {
  const r = await tx.query<{ r: SaleResult }>("select public.record_sale($1, $2, $3) as r", [
    orderId,
    JSON.stringify(items.map(([name, quantity]) => ({ product_id: product[name], quantity }))),
    occurredAt ?? null,
  ]);
  return r.rows[0].r;
}

async function stock(tx: Tx, location: string, materialName: string): Promise<number> {
  const r = await tx.query<{ quantity: string }>(
    "select quantity from public.stock_levels where location_id = $1 and material_id = $2",
    [location, material[materialName]],
  );
  return r.rows[0] ? Number(r.rows[0].quantity) : 0;
}

async function count(tx: Tx, sql: string, params: unknown[] = []): Promise<number> {
  const r = await tx.query<{ n: number }>(`select count(*)::int as n from (${sql}) x`, params);
  return r.rows[0].n;
}

beforeAll(async () => {
  db = await createTestDb();
  admin = await createUser(db, { username: "owner", role: "admin" });
  worker1 = await createUser(db, { username: "ravi", role: "worker", locationCode: "CART1" });
  worker2 = await createUser(db, { username: "sunil", role: "worker", locationCode: "CART2" });
  cart1 = await locationId(db, "CART1");
  cart2 = await locationId(db, "CART2");

  await asCommitted(db, admin, async (tx) => {
    const r = await tx.query<{ r: Record<string, number> }>("select public.import_recipe_sheet($1) as r", [
      JSON.stringify(sampleSheet()),
    ]);
    expect(r.rows[0].r).toEqual({ materials_created: 23, products_created: 5, recipes_created: 5, recipes_unchanged: 0, prices_updated: 0 });

    for (const row of (await tx.query<{ id: string; name: string }>("select id, name from public.products")).rows) {
      product[row.name] = row.id;
    }
    for (const row of (await tx.query<{ id: string; name: string }>("select id, name from public.raw_materials")).rows) {
      material[row.name] = row.id;
    }
    await tx.query(
      `update public.products p set selling_price = v.price
         from (values ('Burger', 120), ('Roll', 100), ('Fries', 80), ('Shake', 110), ('Mojito', 90)) v(name, price)
        where p.name = v.name`,
    );
    const opening: [string, string, number][] = [
      [cart1, "Veg Patty", 20],
      [cart1, "Burger Bun", 20],
      [cart1, "Mayonnaise", 1000],
      [cart1, "Lemon", 10],
      [cart2, "Veg Patty", 30],
    ];
    for (const [loc, name, qty] of opening) {
      await tx.query("select public.admin_adjust_stock($1, $2, $3, 'OPENING_BALANCE')", [loc, material[name], qty]);
    }
  });
});

describe("record_sale — the core guarantee", () => {
  it("Patty 20 → Burger × 3 → 17, and retrying the same order keeps it at 17 (not 14)", async () => {
    await as(db, worker1, async (tx) => {
      const orderId = randomUUID();
      expect(await stock(tx, cart1, "Veg Patty")).toBe(20);

      const first = await sell(tx, orderId, [["Burger", 3]]);
      expect(first).toMatchObject({ status: "created", item_count: 3, total_amount: 360 });
      expect(await stock(tx, cart1, "Veg Patty")).toBe(17);

      const retry = await sell(tx, orderId, [["Burger", 3]]);
      expect(retry).toMatchObject({ status: "duplicate", order_id: orderId, item_count: 3 });
      expect(await stock(tx, cart1, "Veg Patty")).toBe(17);

      expect(await count(tx, "select 1 from public.orders where id = $1", [orderId])).toBe(1);
      expect(
        await count(tx, "select 1 from public.stock_movements where movement_type = 'SALE_CONSUMPTION' and material_id = $1", [
          material["Veg Patty"],
        ]),
      ).toBe(1);
    });
  });

  it("deducts every ingredient of every product, including decimals and grams", async () => {
    await as(db, worker1, async (tx) => {
      await sell(tx, randomUUID(), [
        ["Burger", 2],
        ["Mojito", 3],
      ]);
      expect(await stock(tx, cart1, "Burger Bun")).toBe(18);
      expect(await stock(tx, cart1, "Veg Patty")).toBe(18);
      expect(await stock(tx, cart1, "Mayonnaise")).toBe(960); // 1000 g − 2 × 20 g
      expect(await stock(tx, cart1, "Lemon")).toBe(8.5); // 10 − 3 × 0.5
      expect(await stock(tx, cart1, "Soda")).toBe(-600); // 3 × 200 ml, no opening stock → flagged negative
    });
  });

  it("merges repeated lines for the same product", async () => {
    await as(db, worker1, async (tx) => {
      const r = await sell(tx, randomUUID(), [
        ["Burger", 1],
        ["Burger", 2],
      ]);
      expect(r.item_count).toBe(3);
      expect(await stock(tx, cart1, "Veg Patty")).toBe(17);
    });
  });

  it("records the price and recipe version on each order line", async () => {
    await as(db, worker1, async (tx) => {
      const orderId = randomUUID();
      await sell(tx, orderId, [["Fries", 2]]);
      const r = await tx.query<{ unit_price: string; line_total: string; version: number }>(
        `select oi.unit_price, oi.line_total, pr.version
           from public.order_items oi join public.product_recipes pr on pr.id = oi.recipe_id
          where oi.order_id = $1`,
        [orderId],
      );
      expect(r.rows).toEqual([{ unit_price: "80.00", line_total: "160.00", version: 1 }]);
    });
  });

  it("the ledger always equals the cached balances", async () => {
    await as(db, worker1, async (tx) => {
      await sell(tx, randomUUID(), [
        ["Burger", 4],
        ["Roll", 2],
        ["Shake", 1],
      ]);
    });
    await as(db, admin, async (tx) => {
      expect((await tx.query("select * from public.verify_stock_levels()")).rows).toEqual([]);
    });
  });
});

describe("negative stock", () => {
  it("is allowed on sales but reported back so it can be flagged", async () => {
    await as(db, worker1, async (tx) => {
      const r = await sell(tx, randomUUID(), [["Burger", 25]]);
      expect(r.status).toBe("created");
      expect(r.negative_materials).toEqual(expect.arrayContaining(["Burger Bun", "Veg Patty"]));
      expect(await stock(tx, cart1, "Veg Patty")).toBe(-5);
    });
  });

  it("blocks the whole sale when the owner turns negative sales off", async () => {
    await asOwner(db, async (tx) => {
      await tx.query("update public.app_settings set allow_negative_on_sale = false");
      await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: worker1 })]);
      await tx.exec("set local role authenticated");
      await tx.exec("savepoint s");
      await expect(sell(tx, randomUUID(), [["Burger", 25]])).rejects.toThrow(/Not enough stock for: .*Veg Patty/);
      await tx.exec("rollback to savepoint s");
      expect(await stock(tx, cart1, "Veg Patty")).toBe(20);
      expect(await count(tx, "select 1 from public.orders")).toBe(0);
    });
  });
});

describe("atomicity and validation", () => {
  it("a bad line fails the whole order: nothing saved, no stock change", async () => {
    await as(db, worker1, async (tx) => {
      await tx.exec("savepoint s");
      await expect(
        tx.query("select public.record_sale($1, $2)", [
          randomUUID(),
          JSON.stringify([
            { product_id: product["Burger"], quantity: 2 },
            { product_id: randomUUID(), quantity: 1 },
          ]),
        ]),
      ).rejects.toThrow(/Unknown product/);
      await tx.exec("rollback to savepoint s");
      expect(await stock(tx, cart1, "Veg Patty")).toBe(20);
      expect(await count(tx, "select 1 from public.orders")).toBe(0);
      expect(await count(tx, "select 1 from public.stock_movements where movement_type = 'SALE_CONSUMPTION'")).toBe(0);
    });
  });

  it.each([
    [0, /Invalid quantity/],
    [-2, /Invalid quantity/],
    [1000, /Invalid quantity/],
  ])("rejects quantity %s", async (qty, pattern) => {
    await rejects(as(db, worker1, (tx) => sell(tx, randomUUID(), [["Burger", qty]])), pattern);
  });

  it("rejects an empty order", async () => {
    await rejects(
      as(db, worker1, (tx) => tx.query("select public.record_sale($1, '[]'::jsonb)", [randomUUID()])),
      /no items/,
    );
  });

  it("rejects a product that has no recipe", async () => {
    await rejects(
      as(db, worker1, async (tx) => {
        await tx.exec("reset role");
        const p = await tx.query<{ id: string }>("insert into public.products (name) values ('Tea') returning id");
        await tx.exec("set local role authenticated");
        return tx.query("select public.record_sale($1, $2)", [
          randomUUID(),
          JSON.stringify([{ product_id: p.rows[0].id, quantity: 1 }]),
        ]);
      }),
      /has no recipe/,
    );
  });

  it("never dates a sale in the future", async () => {
    await as(db, worker1, async (tx) => {
      const orderId = randomUUID();
      await sell(tx, orderId, [["Fries", 1]], "2099-01-01T00:00:00Z");
      const r = await tx.query<{ ok: boolean }>("select occurred_at <= clock_timestamp() and occurred_at > clock_timestamp() - interval '1 minute' as ok from public.orders where id = $1", [orderId]);
      expect(r.rows[0].ok).toBe(true);
    });
  });
});

describe("cart isolation", () => {
  it("each worker's sale deducts from their own cart only", async () => {
    await as(db, worker2, async (tx) => {
      await sell(tx, randomUUID(), [["Burger", 5]]);
      expect(await stock(tx, cart2, "Veg Patty")).toBe(25);
    });
    await as(db, admin, async (tx) => {
      expect(await stock(tx, cart1, "Veg Patty")).toBe(20);
    });
  });

  it("a worker cannot see another cart's orders", async () => {
    const orderId = randomUUID();
    await asOwner(db, async (tx) => {
      await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: worker2 })]);
      await tx.exec("set local role authenticated");
      await sell(tx, orderId, [["Burger", 1]]);
      await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: worker1 })]);
      expect(await count(tx, "select 1 from public.orders where id = $1", [orderId])).toBe(0);
      expect(await count(tx, "select 1 from public.order_items oi where oi.order_id = $1", [orderId])).toBe(0);
    });
  });

  it("an order id already used by another worker is rejected, not treated as a duplicate", async () => {
    const orderId = randomUUID();
    await rejects(
      asOwner(db, async (tx) => {
        await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: worker2 })]);
        await tx.exec("set local role authenticated");
        await sell(tx, orderId, [["Burger", 1]]);
        await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: worker1 })]);
        return sell(tx, orderId, [["Burger", 1]]);
      }),
      /already used/,
    );
  });

  it("the admin (no cart) cannot record sales", async () => {
    await rejects(as(db, admin, (tx) => sell(tx, randomUUID(), [["Burger", 1]])), /Only a cart worker/);
  });
});

describe("recipe versioning", () => {
  it("a recipe change affects new sales only; history keeps the old recipe", async () => {
    await as(db, admin, async (tx) => {
      // Sale under v1 (1 patty per burger).
      await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: worker1 })]);
      const before = randomUUID();
      await sell(tx, before, [["Burger", 2]]);
      expect(await stock(tx, cart1, "Veg Patty")).toBe(18);

      // Owner makes it a double-patty burger (v2).
      await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: admin })]);
      await tx.query("select public.save_recipe($1, $2)", [
        product["Burger"],
        JSON.stringify([
          { material_id: material["Burger Bun"], quantity: 1 },
          { material_id: material["Veg Patty"], quantity: 2 },
        ]),
      ]);

      await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: worker1 })]);
      const after = randomUUID();
      await sell(tx, after, [["Burger", 2]]);
      expect(await stock(tx, cart1, "Veg Patty")).toBe(14); // 18 − 2 × 2

      const versions = await tx.query<{ id: string; version: number }>(
        `select oi.order_id as id, pr.version from public.order_items oi
           join public.product_recipes pr on pr.id = oi.recipe_id where oi.order_id in ($1, $2)`,
        [before, after],
      );
      expect(Object.fromEntries(versions.rows.map((r) => [r.id, r.version]))).toEqual({ [before]: 1, [after]: 2 });

      // The earlier order's consumption rows are untouched.
      const hist = await tx.query<{ qty: string }>(
        `select sum(sm.qty_delta)::text as qty from public.stock_movements sm
           join public.order_items oi on oi.id = sm.ref_id
          where oi.order_id = $1 and sm.material_id = $2`,
        [before, material["Veg Patty"]],
      );
      expect(hist.rows[0].qty).toBe("-2.000");
    });
  });

  it("an offline sale timestamped before a recipe change uses the recipe in force at that time", async () => {
    await as(db, admin, async (tx) => {
      const saleTime = (await tx.query<{ t: string }>("select (now() - interval '1 hour')::text as t")).rows[0].t;
      await tx.query("select public.save_recipe($1, $2)", [
        product["Burger"],
        JSON.stringify([{ material_id: material["Veg Patty"], quantity: 2 }]),
      ]);
      // Backdate v1 so it was clearly in force at saleTime.
      await tx.exec("reset role");
      await tx.exec("alter table public.product_recipes disable trigger audit");
      await tx.query(
        `update public.product_recipes set effective_from = effective_from - interval '1 day'
          where product_id = $1 and version = 1`,
        [product["Burger"]],
      );
      await tx.exec("alter table public.product_recipes enable trigger audit");
      await tx.exec("set local role authenticated");

      await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: worker1 })]);
      await sell(tx, randomUUID(), [["Burger", 1]], saleTime);
      expect(await stock(tx, cart1, "Veg Patty")).toBe(19); // v1: 1 patty, not v2's 2
    });
  });

  it("recipe items cannot be edited in place", async () => {
    await rejects(
      asOwner(db, (tx) => tx.query("update public.recipe_items set quantity = 5")),
      /append-only/,
    );
  });

  it("re-importing the same sheet changes nothing; a changed quantity creates one new version", async () => {
    await as(db, admin, async (tx) => {
      const sheet = sampleSheet();
      const again = await tx.query<{ r: Record<string, number> }>("select public.import_recipe_sheet($1) as r", [
        JSON.stringify(sheet),
      ]);
      expect(again.rows[0].r).toEqual({ materials_created: 0, products_created: 0, recipes_created: 0, recipes_unchanged: 5, prices_updated: 0 });

      const fries = sheet.products.find((p) => p.name === "Fries")!;
      fries.items.find((i) => i.material === "Frozen Fries")!.quantity = 180;
      const changed = await tx.query<{ r: Record<string, number> }>("select public.import_recipe_sheet($1) as r", [
        JSON.stringify(sheet),
      ]);
      expect(changed.rows[0].r).toMatchObject({ recipes_created: 1, recipes_unchanged: 4 });
    });
  });

  it("import rejects a material whose unit conflicts with the app", async () => {
    await rejects(
      as(db, admin, (tx) =>
        tx.query("select public.import_recipe_sheet($1)", [
          JSON.stringify({ materials: [{ name: "Milk", base_unit: "g" }], products: [] }),
        ]),
      ),
      /measured in ml in the app but g in the sheet/,
    );
  });
});

describe("void_order", () => {
  it("reverses consumption, keeps history, and is audited", async () => {
    await as(db, admin, async (tx) => {
      await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: worker1 })]);
      const orderId = randomUUID();
      await sell(tx, orderId, [["Burger", 3]]);
      expect(await stock(tx, cart1, "Veg Patty")).toBe(17);

      await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: admin })]);
      await tx.query("select public.void_order($1, 'Entered twice')", [orderId]);
      expect(await stock(tx, cart1, "Veg Patty")).toBe(20);

      const o = await tx.query<{ status: string; void_reason: string }>(
        "select status, void_reason from public.orders where id = $1",
        [orderId],
      );
      expect(o.rows[0]).toEqual({ status: "voided", void_reason: "Entered twice" });
      expect(await count(tx, "select 1 from public.stock_movements where movement_type = 'SALE_CONSUMPTION'")).toBe(8);
      expect(await count(tx, "select 1 from public.stock_movements where movement_type = 'SALE_REVERSAL'")).toBe(8);
      expect(await count(tx, "select 1 from public.audit_logs where entity = 'orders' and action = 'void'")).toBe(1);
      expect((await tx.query("select * from public.verify_stock_levels()")).rows).toEqual([]);

      await tx.exec("savepoint s");
      await expect(tx.query("select public.void_order($1, 'again')", [orderId])).rejects.toThrow(/already voided/);
      await tx.exec("rollback to savepoint s");
    });
  });

  it("requires a reason", async () => {
    await rejects(as(db, admin, (tx) => tx.query("select public.void_order($1, '  ')", [randomUUID()])), /reason is required/);
  });
});

describe("admin-only functions", () => {
  it.each([
    ["void_order", "select public.void_order(gen_random_uuid(), 'x')"],
    ["save_recipe", "select public.save_recipe(gen_random_uuid(), '[]')"],
    ["import_recipe_sheet", "select public.import_recipe_sheet('{}')"],
    ["admin_adjust_stock", "select public.admin_adjust_stock(gen_random_uuid(), gen_random_uuid(), 5, 'MANUAL_ADJUSTMENT', 'x')"],
    ["verify_stock_levels", "select * from public.verify_stock_levels()"],
  ])("a worker cannot call %s", async (_name, sql) => {
    await rejects(as(db, worker1, (tx) => tx.query(sql)), /Admin only/);
  });

  it("internal ledger functions are not callable by app users", async () => {
    await rejects(
      as(db, admin, (tx) =>
        tx.query(
          "select public.post_movement($1, $2, 100, 'PURCHASE', 'adjustment', null, 0, now(), null)",
          [cart1, material["Veg Patty"]],
        ),
      ),
      /permission denied/,
    );
  });

  it("manual adjustments need a note and cannot go negative", async () => {
    await rejects(
      as(db, admin, (tx) =>
        tx.query("select public.admin_adjust_stock($1, $2, -1, 'MANUAL_ADJUSTMENT', '')", [cart1, material["Veg Patty"]]),
      ),
      /note is required/,
    );
    await rejects(
      as(db, admin, (tx) =>
        tx.query("select public.admin_adjust_stock($1, $2, -50, 'MANUAL_ADJUSTMENT', 'count')", [cart1, material["Veg Patty"]]),
      ),
      /negative/,
    );
  });
});
