import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { as, asCommitted, createBusiness, createTestDb, createUser, locationId, rejects, type Db, type Tx } from "./harness";
import { actAs, idsByName, sampleSheet } from "./fixtures";

let db: Db;
let admin: string;
let worker: string;
let adminB: string;
let cart: string;
let mat: Record<string, string>;
let prod: Record<string, string>;
let cheese: string; // add-on "Extra cheese" ₹20 = 1 Cheese Slice, offered on Burger
let sauce: string; // add-on "Extra mayo" ₹10 = 20 g Mayonnaise, offered on Burger
let large: string; // Shake Large ₹150

type Line = { product_id: string; quantity: number; addons?: { addon_id: string; quantity?: number }[] };

async function sell(tx: Tx, lines: Line[], id = randomUUID()) {
  const r = await tx.query<{ r: { status: string; total_amount: number; item_count: number } }>("select public.record_sale($1, $2) as r", [
    id,
    JSON.stringify(lines),
  ]);
  return r.rows[0].r;
}

async function stock(tx: Tx, name: string) {
  const r = await tx.query<{ q: string }>("select quantity::text as q from public.stock_levels where location_id = $1 and material_id = $2", [
    cart,
    mat[name],
  ]);
  return Number(r.rows[0]?.q ?? 0);
}

beforeAll(async () => {
  db = await createTestDb();
  admin = await createUser(db, { username: "owner", role: "admin" });
  worker = await createUser(db, { username: "ravi", role: "worker", locationCode: "CART1" });
  await createBusiness(db, "OTHER");
  adminB = await createUser(db, { username: "boss", role: "admin", business: "OTHER" });
  cart = await locationId(db, "CART1");

  await asCommitted(db, admin, async (tx) => {
    await tx.query("select public.import_recipe_sheet($1)", [JSON.stringify(sampleSheet())]);
    mat = await idsByName(tx, "raw_materials");
    prod = await idsByName(tx, "products");
    await tx.query("update public.products set selling_price = 120 where name = 'Burger'");
    await tx.query("update public.products set selling_price = 110 where name = 'Shake'");
    await tx.query("update public.raw_materials set avg_unit_cost = 10 where name = 'Cheese Slice'");
    await tx.query("update public.raw_materials set avg_unit_cost = 0.25 where name = 'Mayonnaise'");
    for (const [name, qty] of [["Cheese Slice", 50], ["Mayonnaise", 2000], ["Veg Patty", 50], ["Burger Bun", 50], ["Milk", 10000]] as const) {
      await tx.query("select public.admin_adjust_stock($1, $2, $3, 'OPENING_BALANCE')", [cart, mat[name], qty]);
    }
    cheese = (await tx.query<{ id: string }>("select public.save_addon(null, 'Extra cheese', 20, true, $1, $2) as id", [
      JSON.stringify([{ material_id: mat["Cheese Slice"], quantity: 1 }]),
      [prod["Burger"]],
    ])).rows[0].id;
    sauce = (await tx.query<{ id: string }>("select public.save_addon(null, 'Extra mayo', 10, true, $1, $2) as id", [
      JSON.stringify([{ material_id: mat["Mayonnaise"], quantity: 20 }]),
      [prod["Burger"]],
    ])).rows[0].id;
    large = (await tx.query<{ id: string }>("select public.create_variant($1, 'Large', 150) as id", [prod["Shake"]])).rows[0].id;
    // A large shake uses 300 ml milk instead of 200 ml.
    await tx.query("select public.save_recipe($1, $2)", [
      large,
      JSON.stringify([{ material_id: mat["Milk"], quantity: 300 }, { material_id: mat["Ice"], quantity: 50 }]),
    ]);
  });
});

describe("add-ons on the Sell screen", () => {
  it("adds the add-on price and deducts its ingredients", async () => {
    await as(db, worker, async (tx) => {
      // 2 burgers, each with double cheese: 2×120 + 2×2×20 = 320; cheese used = 2 (recipe) + 4 (add-on)
      const r = await sell(tx, [{ product_id: prod["Burger"], quantity: 2, addons: [{ addon_id: cheese, quantity: 2 }] }]);
      expect(r).toMatchObject({ status: "created", total_amount: 320, item_count: 2 });
      expect(await stock(tx, "Cheese Slice")).toBe(44);
      const l = await tx.query("select quantity, line_total::text, addons_amount::text from public.order_items");
      expect(l.rows).toEqual([{ quantity: 2, line_total: "240.00", addons_amount: "80.00" }]);
    });
  });

  it("the same product with different add-ons stays on separate lines; identical lines merge", async () => {
    await as(db, worker, async (tx) => {
      const r = await sell(tx, [
        { product_id: prod["Burger"], quantity: 1 },
        { product_id: prod["Burger"], quantity: 1, addons: [{ addon_id: cheese }] },
        { product_id: prod["Burger"], quantity: 2, addons: [{ addon_id: cheese }] },
        { product_id: prod["Burger"], quantity: 1, addons: [{ addon_id: sauce }, { addon_id: cheese }] },
      ]);
      expect(r.total_amount).toBe(5 * 120 + 3 * 20 + (20 + 10));
      const lines = await tx.query<{ quantity: number; addons: string }>(
        `select oi.quantity, coalesce(string_agg(a.name, '+' order by a.name), '') as addons
           from public.order_items oi
           left join public.order_item_addons oia on oia.order_item_id = oi.id
           left join public.addons a on a.id = oia.addon_id
          group by oi.id, oi.quantity order by addons, oi.quantity`,
      );
      expect(lines.rows).toEqual([
        { quantity: 1, addons: "" },
        { quantity: 3, addons: "Extra cheese" },
        { quantity: 1, addons: "Extra cheese+Extra mayo" },
      ]);
    });
  });

  it("rejects an add-on not offered with the product, an inactive one, or a duplicate", async () => {
    await rejects(as(db, worker, (tx) => sell(tx, [{ product_id: prod["Fries"], quantity: 1, addons: [{ addon_id: cheese }] }])), /not offered with "Fries"/);
    await rejects(
      as(db, admin, async (tx) => {
        await tx.query("select public.save_addon($1, 'Extra cheese', 20, false, '[]', $2)", [cheese, [prod["Burger"]]]);
        await actAs(tx, worker);
        return sell(tx, [{ product_id: prod["Burger"], quantity: 1, addons: [{ addon_id: cheese }] }]);
      }),
      /not available/,
    );
    await rejects(
      as(db, worker, (tx) => sell(tx, [{ product_id: prod["Burger"], quantity: 1, addons: [{ addon_id: cheese }, { addon_id: cheese }] }])),
      /listed twice/,
    );
  });

  it("voiding the order returns the add-on ingredients too", async () => {
    await as(db, worker, async (tx) => {
      const id = randomUUID();
      await sell(tx, [{ product_id: prod["Burger"], quantity: 1, addons: [{ addon_id: cheese, quantity: 3 }] }], id);
      expect(await stock(tx, "Cheese Slice")).toBe(46);
      await actAs(tx, admin);
      await tx.query("select public.void_order($1, 'test')", [id]);
      expect(await stock(tx, "Cheese Slice")).toBe(50);
      expect((await tx.query("select * from public.verify_stock_levels()")).rows).toEqual([]);
    });
  });

  it("profit per product includes add-on revenue and cost; add-on report adds up", async () => {
    await as(db, worker, async (tx) => {
      await sell(tx, [{ product_id: prod["Burger"], quantity: 1, addons: [{ addon_id: cheese }, { addon_id: sauce }] }]);
      await actAs(tx, admin);
      const p = await tx.query(
        "select sales::text, cogs::text from public.product_profit(now() - interval '1 hour', now() + interval '1 hour') where name = 'Burger'",
      );
      // revenue 120 + 20 + 10; cost = recipe (cheese 10 + mayo 20 g × 0.25 = 5) + add-ons (10 + 5)
      expect(p.rows).toEqual([{ sales: "150.00", cogs: "30.00" }]);
      const a = await tx.query("select name, quantity::int, sales::text, cogs::text from public.addon_sales(now() - interval '1 hour', now() + interval '1 hour') order by name");
      expect(a.rows).toEqual([
        { name: "Extra cheese", quantity: 1, sales: "20.00", cogs: "10.00" },
        { name: "Extra mayo", quantity: 1, sales: "10.00", cogs: "5.00" },
      ]);
    });
  });
});

describe("sizes (variants)", () => {
  it("a size is sold with its own price and recipe", async () => {
    await as(db, worker, async (tx) => {
      const r = await sell(tx, [
        { product_id: prod["Shake"], quantity: 1 },
        { product_id: large, quantity: 2 },
      ]);
      expect(r.total_amount).toBe(110 + 2 * 150);
      expect(await stock(tx, "Milk")).toBe(10000 - 200 - 2 * 300);
    });
  });

  it("create_variant copies the base recipe and name; sizes cannot have sizes", async () => {
    await as(db, admin, async (tx) => {
      const id = (await tx.query<{ id: string }>("select public.create_variant($1, 'Double', 170) as id", [prod["Burger"]])).rows[0].id;
      const p = await tx.query("select name, variant_label, category from public.products where id = $1", [id]);
      expect(p.rows[0]).toMatchObject({ name: "Burger Double", variant_label: "Double" });
      const items = await tx.query<{ n: number }>("select count(*)::int as n from public.recipe_items ri join public.product_recipes r on r.id = ri.recipe_id where r.product_id = $1", [id]);
      expect(items.rows[0].n).toBe(8);
      await tx.query("savepoint s");
      await rejects(tx.query("select public.create_variant($1, 'XL', 200)", [id]), /main product/);
      await tx.query("rollback to savepoint s");
      await rejects(tx.query("update public.products set variant_of = $1 where id = $2", [prod["Roll"], prod["Shake"]]), /already has sizes/);
    });
  });

  it("a size also offers its base product's add-ons", async () => {
    await as(db, admin, async (tx) => {
      const dbl = (await tx.query<{ id: string }>("select public.create_variant($1, 'Double', 170) as id", [prod["Burger"]])).rows[0].id;
      await actAs(tx, worker);
      const r = await sell(tx, [{ product_id: dbl, quantity: 1, addons: [{ addon_id: cheese }] }]);
      expect(r.total_amount).toBe(190);
    });
  });
});

describe("add-on administration", () => {
  it("only admins manage add-ons; another business's products or materials are refused", async () => {
    await rejects(as(db, worker, (tx) => tx.query("select public.save_addon(null, 'X', 1)")), /Admin only/);
    await rejects(
      as(db, adminB, (tx) => tx.query("select public.save_addon(null, 'Cheese', 5, true, '[]', $1)", [[prod["Burger"]]])),
      /another business/,
    );
    await rejects(
      as(db, adminB, (tx) => tx.query("select public.save_addon(null, 'Cheese', 5, true, $1)", [JSON.stringify([{ material_id: mat["Cheese Slice"], quantity: 1 }])])),
      /another business/,
    );
    await rejects(as(db, adminB, (tx) => tx.query("select public.create_variant($1, 'L', 1)", [prod["Shake"]])), /not found/);
  });

  it("workers of another business cannot sell this business's add-ons", async () => {
    await rejects(
      as(db, admin, async (tx) => {
        const w = await tx.query<{ id: string }>("select id from public.profiles where username = 'ravi'");
        await actAs(tx, w.rows[0].id);
        await actAs(tx, adminB);
        return sell(tx, [{ product_id: prod["Burger"], quantity: 1, addons: [{ addon_id: cheese }] }]);
      }),
      /cart worker|another business/,
    );
  });
});
