import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { as, asCommitted, createBusiness, createTestDb, createUser, firstBusinessId, locationId, rejects, type Db, type Tx } from "./harness";
import { actAs, sampleSheet } from "./fixtures";

// Business A = the original data (code from its name). Business B = a second customer.
let db: Db;
let bizA: string;
let bizB: string;
let adminA: string;
let workerA: string;
let adminB: string;
let workerB: string;
let cartA: string;
let cartB: string;
let centralB: string;
const A: { mat: Record<string, string>; prod: Record<string, string> } = { mat: {}, prod: {} };
const B: { mat: Record<string, string>; prod: Record<string, string> } = { mat: {}, prod: {} };

async function ids(tx: Tx, table: "products" | "raw_materials", biz: string) {
  const r = await tx.query<{ id: string; name: string }>(`select id, name from public.${table} where business_id = $1`, [biz]);
  return Object.fromEntries(r.rows.map((x) => [x.name, x.id]));
}

const sale = (tx: Tx, product: string, qty = 1) =>
  tx.query<{ r: { status: string } }>("select public.record_sale($1, $2) as r", [randomUUID(), JSON.stringify([{ product_id: product, quantity: qty }])]);

beforeAll(async () => {
  db = await createTestDb();
  bizA = await firstBusinessId(db);
  bizB = await createBusiness(db, "BCAFE", 2);
  adminA = await createUser(db, { username: "owner", role: "admin" });
  await db.query("insert into public.platform_admins (user_id) values ($1)", [adminA]); // you, the product owner
  workerA = await createUser(db, { username: "ravi", role: "worker", locationCode: "CART1" });
  // Same usernames in the other business are fine.
  adminB = await createUser(db, { username: "owner", role: "admin", business: "BCAFE" });
  workerB = await createUser(db, { username: "ravi", role: "worker", locationCode: "CART1", business: "BCAFE" });
  cartA = await locationId(db, "CART1");
  cartB = await locationId(db, "CART1", "BCAFE");
  centralB = await locationId(db, "CENTRAL", "BCAFE");

  // Both businesses import the SAME menu: names repeat, rows must not.
  for (const [admin, biz, into, cart] of [
    [adminA, bizA, A, cartA],
    [adminB, bizB, B, cartB],
  ] as const) {
    await asCommitted(db, admin, async (tx) => {
      const r = await tx.query<{ r: { materials_created: number; products_created: number } }>("select public.import_recipe_sheet($1) as r", [
        JSON.stringify(sampleSheet()),
      ]);
      expect(r.rows[0].r).toMatchObject({ materials_created: 23, products_created: 5 });
      Object.assign(into.mat, await ids(tx, "raw_materials", biz));
      Object.assign(into.prod, await ids(tx, "products", biz));
      await tx.query("update public.products set selling_price = 120 where name = 'Burger'");
      await tx.query("update public.raw_materials set avg_unit_cost = 25 where name = 'Veg Patty'");
      for (const m of ["Veg Patty", "Burger Bun"]) {
        await tx.query("select public.admin_adjust_stock($1, $2, 50, 'OPENING_BALANCE')", [cart, into.mat[m]]);
      }
    });
  }
});

describe("reading: each business sees only its own data", () => {
  it("catalog, locations, people and stock are separate", async () => {
    await as(db, adminB, async (tx) => {
      expect((await tx.query("select id from public.products")).rows).toHaveLength(5);
      expect((await tx.query("select 1 from public.products where id = $1", [A.prod["Burger"]])).rows).toHaveLength(0);
      const locs = await tx.query<{ business_id: string }>("select business_id from public.locations");
      expect(locs.rows.every((l) => l.business_id === bizB)).toBe(true);
      expect((await tx.query("select username from public.profiles order by username")).rows).toHaveLength(2);
      const lv = await tx.query<{ business_id: string }>("select business_id from public.stock_levels");
      expect(lv.rows.length).toBeGreaterThan(0);
      expect(lv.rows.every((l) => l.business_id === bizB)).toBe(true);
      expect((await tx.query("select 1 from public.audit_logs where business_id <> $1", [bizB])).rows).toHaveLength(0);
    });
  });

  it("orders from business A are invisible to business B (admin and worker)", async () => {
    await as(db, workerA, async (tx) => {
      await sale(tx, A.prod["Burger"], 2);
      for (const who of [adminB, workerB]) {
        await actAs(tx, who);
        expect((await tx.query("select 1 from public.orders")).rows).toHaveLength(0);
        expect((await tx.query("select 1 from public.order_items")).rows).toHaveLength(0);
        expect((await tx.query("select 1 from public.stock_movements where location_id = $1", [cartA])).rows).toHaveLength(0);
      }
    });
  });

  it("settings are per business", async () => {
    await as(db, adminA, async (tx) => {
      await tx.query("update public.app_settings set worker_discount_limit_pct = 15");
      await actAs(tx, adminB);
      const b = await tx.query("select worker_discount_limit_pct, business_name from public.app_settings");
      expect(b.rows).toEqual([{ worker_discount_limit_pct: 0, business_name: "BCAFE Cafe" }]);
      await actAs(tx, adminA);
      expect((await tx.query("select worker_discount_limit_pct from public.app_settings")).rows).toEqual([{ worker_discount_limit_pct: 15 }]);
    });
  });

  it("analytics only count the caller's business; another business's location is refused", async () => {
    await as(db, workerA, async (tx) => {
      await sale(tx, A.prod["Burger"], 3);
      await actAs(tx, workerB);
      await sale(tx, B.prod["Burger"], 1);
      await actAs(tx, adminB);
      const s = await tx.query<{ s: { current: { orders: number; net_sales: number }; by_location: unknown[] } }>(
        "select public.profit_summary(now() - interval '1 hour', now() + interval '1 hour') as s",
      );
      expect(s.rows[0].s.current).toMatchObject({ orders: 1, net_sales: 120 });
      expect(s.rows[0].s.by_location).toHaveLength(3); // B's central + 2 carts
      const d = await tx.query<{ s: { current: { orders: number }; carts: unknown[] } }>(
        "select public.dashboard_summary(now() - interval '1 hour', now() + interval '1 hour') as s",
      );
      expect(d.rows[0].s.current.orders).toBe(1);
      expect(d.rows[0].s.carts).toHaveLength(2);
      const st = await tx.query("select name from public.stock_status(null)");
      expect(st.rows.length).toBeGreaterThan(0);
      expect((await tx.query("select * from public.verify_stock_levels()")).rows).toEqual([]);
      await tx.query("savepoint s");
      await rejects(tx.query("select public.profit_summary(now() - interval '1 day', now(), $1)", [cartA]), /Unknown location/);
      await tx.query("rollback to savepoint s");
      await rejects(tx.query("select * from public.stock_status($1)", [cartA]), /Unknown location/);
    });
  });
});

describe("writing: nothing can cross into another business", () => {
  it.each([
    ["sell A's product from B's cart", (tx: Tx) => (actAs(tx, workerB), sale(tx, A.prod["Burger"]))],
    ["void A's order", async (tx: Tx) => {
      const id = randomUUID();
      await tx.query("select public.record_sale($1, $2)", [id, JSON.stringify([{ product_id: A.prod["Burger"], quantity: 1 }])]);
      await actAs(tx, adminB);
      return tx.query("select public.void_order($1, 'x')", [id]);
    }],
    ["adjust A's stock", (tx: Tx) => (actAs(tx, adminB), tx.query("select public.admin_adjust_stock($1, $2, 5, 'MANUAL_ADJUSTMENT', 'x')", [cartA, A.mat["Veg Patty"]]))],
    ["adjust own cart with A's material", (tx: Tx) => (actAs(tx, adminB), tx.query("select public.admin_adjust_stock($1, $2, 5, 'MANUAL_ADJUSTMENT', 'x')", [cartB, A.mat["Veg Patty"]]))],
    ["receive stock into A's cart", (tx: Tx) => (actAs(tx, adminB), tx.query("select public.record_receipt($1, $2, null, null, null, null, $3)", [randomUUID(), JSON.stringify([{ material_id: B.mat["Veg Patty"], quantity: 1 }]), cartA]))],
    ["transfer from B central to A's cart", (tx: Tx) => (actAs(tx, adminB), tx.query("select public.create_transfer($1, $2, $3, $4)", [randomUUID(), centralB, cartA, JSON.stringify([{ material_id: B.mat["Veg Patty"], quantity: 1 }])]))],
    ["put A's material in a B recipe", (tx: Tx) => (actAs(tx, adminB), tx.query("select public.save_recipe($1, $2)", [B.prod["Burger"], JSON.stringify([{ material_id: A.mat["Veg Patty"], quantity: 1 }])]))],
    ["rename A's cart", (tx: Tx) => (actAs(tx, adminB), tx.query("select public.admin_save_location($1, 'Hacked', null, true)", [cartA]))],
    ["move A's worker to a B cart", (tx: Tx) => (actAs(tx, adminB), tx.query("select public.admin_update_profile($1, 'Ravi', $2, true)", [workerA, cartB]))],
    ["record an expense at A's cart", (tx: Tx) => (actAs(tx, adminB), tx.query("select public.record_expense($1, 'rent', 10, null, null, 'cash', $2)", [randomUUID(), cartA]))],
    ["update A's product directly", async (tx: Tx) => {
      await actAs(tx, adminB);
      const r = await tx.query("update public.products set selling_price = 1 where id = $1 returning id", [A.prod["Burger"]]);
      if (r.rows.length === 0) throw new Error("Not allowed (no rows visible)");
    }],
  ])("B cannot %s", async (_label, attempt) => {
    await rejects(
      as(db, workerA, async (tx) => {
        await attempt(tx);
      }),
      /another business|Unknown location|Choose a valid location|not found|Not allowed/i,
    );
  });

  it("a user without a business context cannot create rows for nobody", async () => {
    await rejects(
      as(db, adminB, async (tx) => {
        await tx.exec("reset role");
        await tx.query("select set_config('request.jwt.claims', '', true)");
        await tx.query("insert into public.suppliers (name) values ('Orphan')");
      }),
      /business_id is required/,
    );
  });
});

describe("suspension and plan limits", () => {
  it("a suspended business can neither read nor write; the platform can reactivate it", async () => {
    await as(db, adminA, async (tx) => {
      await tx.query("select public.platform_update_business($1, 'BCAFE Cafe', 'BCAFE', 'standard', null, 'suspended')", [bizB]);
      await actAs(tx, workerB);
      expect((await tx.query("select 1 from public.products")).rows).toHaveLength(0);
      await tx.query("savepoint s");
      await rejects(sale(tx, B.prod["Burger"]), /suspended/);
      await tx.query("rollback to savepoint s");
      const cb = await tx.query<{ b: { status: string } }>("select public.current_business() as b");
      expect(cb.rows[0].b.status).toBe("suspended");
      await actAs(tx, adminA);
      await tx.query("select public.platform_update_business($1, 'BCAFE Cafe', 'BCAFE', 'standard', null, 'active')", [bizB]);
      await actAs(tx, workerB);
      expect((await sale(tx, B.prod["Burger"])).rows[0].r.status).toBe("created");
    });
  });

  it("cart limit: adding or reactivating carts stops at the plan's limit", async () => {
    await as(db, adminA, async (tx) => {
      await tx.query("select public.platform_update_business($1, 'BCAFE Cafe', 'BCAFE', 'basic', 2, 'active')", [bizB]);
      await actAs(tx, adminB);
      await rejects(tx.query("select public.admin_save_location(null, 'Cart 3')"), /plan allows 2 active cart/);
    });
  });
});

describe("platform administration", () => {
  it("creates a business with settings, Central Storage and carts; codes are unique", async () => {
    await as(db, adminA, async (tx) => {
      const r = await tx.query<{ id: string }>("select public.platform_create_business('Chai Point', 'chaipoint', 'standard', 3, 2) as id");
      const id = r.rows[0].id;
      const locs = await tx.query("select code, type from public.locations where business_id = $1 order by sort_order", [id]);
      expect(locs.rows).toEqual([]); // not visible: it is another business
      const list = await tx.query<{ code: string; carts: string; users: string }>("select code, carts::text, users::text from public.platform_businesses() where id = $1", [id]);
      expect(list.rows).toEqual([{ code: "CHAIPOINT", carts: "2", users: "0" }]);
      await tx.query("savepoint s");
      await rejects(tx.query("select public.platform_create_business('Other', 'CHAIPOINT')"), /already taken/);
      await tx.query("rollback to savepoint s");
      await rejects(tx.query("select public.platform_update_business($1, 'x', 'x', 'x', null, 'suspended')", [bizA]), /Code: 3–16|cannot suspend/);
    });
  });

  it("only platform admins can run platform functions", async () => {
    await rejects(as(db, adminB, (tx) => tx.query("select * from public.platform_businesses()")), /Platform admin only/);
    await rejects(as(db, adminB, (tx) => tx.query("select public.platform_create_business('X', 'XCAFE')")), /Platform admin only/);
  });

  it("a platform admin cannot suspend their own business", async () => {
    await rejects(
      as(db, adminA, (tx) => tx.query("select public.platform_update_business($1, 'Mine', 'MINE', 'standard', null, 'suspended')", [bizA])),
      /cannot suspend your own/,
    );
  });
});
