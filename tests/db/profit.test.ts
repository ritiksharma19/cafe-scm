import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { as, asCommitted, createTestDb, createUser, locationId, rejects, type Db, type Tx } from "./harness";
import { actAs, idsByName, sampleSheet } from "./fixtures";
import type { ProfitSummary } from "@/lib/analytics";

let db: Db;
let admin: string;
let worker1: string;
let central: string;
let cart1: string;
let cart2: string;
let cart3: string;
let mat: Record<string, string>;
let prod: Record<string, string>;

// Today as India-time midnight boundaries, the way the app sends periods.
const TODAY = `(date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata')`;
const PERIOD = `${TODAY}, ${TODAY} + interval '1 day'`;

async function sale(tx: Tx, qty: number, payment?: string, discount?: number, id = randomUUID()) {
  const items = JSON.stringify([{ product_id: prod["Burger"], quantity: qty }]);
  const r =
    payment === undefined
      ? await tx.query<{ r: Record<string, unknown> }>("select public.record_sale($1, $2) as r", [id, items])
      : await tx.query<{ r: Record<string, unknown> }>(
          "select public.record_sale($1, $2, null, $3::public.payment_method, $4) as r",
          [id, items, payment, discount ?? 0],
        );
  return r.rows[0].r;
}

async function expense(tx: Tx, category: string, amount: number, opts: { location?: string | null; on?: string; id?: string; description?: string } = {}) {
  const r = await tx.query<{ r: Record<string, unknown> }>(
    "select public.record_expense($1, $2::public.expense_category, $3, $4::date, $5, 'cash', $6) as r",
    [opts.id ?? randomUUID(), category, amount, opts.on ?? null, opts.description ?? null, opts.location ?? null],
  );
  return r.rows[0].r;
}

async function setDiscountLimit(tx: Tx, pct: number) {
  await tx.exec("reset role");
  await tx.query("update public.app_settings set worker_discount_limit_pct = $1", [pct]);
  await tx.exec("set local role authenticated");
}

beforeAll(async () => {
  db = await createTestDb();
  admin = await createUser(db, { username: "owner", role: "admin" });
  worker1 = await createUser(db, { username: "ravi", role: "worker", locationCode: "CART1" });
  await createUser(db, { username: "sunil", role: "worker", locationCode: "CART2" });
  central = await locationId(db, "CENTRAL");
  cart1 = await locationId(db, "CART1");
  cart2 = await locationId(db, "CART2");
  cart3 = await locationId(db, "CART3");

  await asCommitted(db, admin, async (tx) => {
    await tx.query("select public.import_recipe_sheet($1)", [JSON.stringify(sampleSheet())]);
    mat = await idsByName(tx, "raw_materials");
    prod = await idsByName(tx, "products");
    await tx.query("update public.products set selling_price = 120 where name = 'Burger'");
    await tx.query("update public.raw_materials set avg_unit_cost = 25 where name = 'Veg Patty'");
    await tx.query("update public.raw_materials set avg_unit_cost = 8 where name = 'Burger Bun'");
    for (const name of ["Veg Patty", "Burger Bun"]) {
      await tx.query("select public.admin_adjust_stock($1, $2, 30, 'OPENING_BALANCE')", [cart1, mat[name]]);
    }
  });
});

describe("record_sale — payment method and discount", () => {
  it("older 2/3-argument calls still work: cash, no discount", async () => {
    await as(db, worker1, async (tx) => {
      const r = await sale(tx, 1);
      expect(r).toMatchObject({ status: "created", total_amount: 120, payment_method: "cash", discount_amount: 0 });
    });
  });

  it("records UPI and a discount within the owner's limit; total is what the customer paid", async () => {
    await as(db, worker1, async (tx) => {
      await setDiscountLimit(tx, 10);
      const id = randomUUID();
      const r = await sale(tx, 2, "upi", 20, id);
      expect(r).toMatchObject({ total_amount: 220, discount_amount: 20, payment_method: "upi" });
      const o = await tx.query("select payment_method, discount_amount::text, total_amount::text from public.orders where id = $1", [id]);
      expect(o.rows[0]).toEqual({ payment_method: "upi", discount_amount: "20.00", total_amount: "220.00" });
    });
  });

  it("rejects discounts when not allowed, above the limit, or above the order", async () => {
    await rejects(as(db, worker1, (tx) => sale(tx, 1, "cash", 5)), /above the allowed limit \(0 % of the order\)/);
    await rejects(
      as(db, worker1, async (tx) => {
        await setDiscountLimit(tx, 10);
        return sale(tx, 1, "cash", 13);
      }),
      /above the allowed limit/,
    );
    await rejects(
      as(db, worker1, async (tx) => {
        await setDiscountLimit(tx, 100);
        return sale(tx, 1, "cash", 121);
      }),
      /larger than the order/,
    );
  });

  it("a rejected discount leaves no order and no stock change", async () => {
    await as(db, worker1, async (tx) => {
      const id = randomUUID();
      await expect(sale(tx, 1, "cash", 5, id)).rejects.toThrow();
    });
    await as(db, admin, async (tx) => {
      const r = await tx.query("select quantity::text from public.stock_levels where location_id = $1 and material_id = $2", [cart1, mat["Veg Patty"]]);
      expect(r.rows[0]).toEqual({ quantity: "30.000" });
    });
  });
});

describe("expenses", () => {
  it("a worker records an expense for their own cart; resending the same id is harmless", async () => {
    await as(db, worker1, async (tx) => {
      const id = randomUUID();
      expect(await expense(tx, "gas_fuel", 450, { id })).toMatchObject({ status: "created", amount: 450 });
      expect(await expense(tx, "gas_fuel", 450, { id })).toMatchObject({ status: "duplicate" });
      const r = await tx.query("select location_id, amount::text from public.expenses");
      expect(r.rows).toEqual([{ location_id: cart1, amount: "450.00" }]);
    });
  });

  it("workers cannot record for another cart, far in the past, or in the future", async () => {
    await rejects(as(db, worker1, (tx) => expense(tx, "rent", 100, { location: cart2 })), /own cart/);
    await rejects(
      as(db, worker1, (tx) => expense(tx, "rent", 100, { on: "2020-01-01" })),
      /last 3 days only/,
    );
    await rejects(as(db, admin, (tx) => expense(tx, "rent", 100, { on: "2999-01-01" })), /future/);
    await rejects(as(db, admin, (tx) => expense(tx, "other", 100)), /description/);
    await rejects(as(db, admin, (tx) => expense(tx, "rent", 0)), /greater than zero/);
  });

  it("workers only see their own cart's expenses; business-wide ones are admin-only", async () => {
    await as(db, admin, async (tx) => {
      await expense(tx, "rent", 5000); // whole business
      await expense(tx, "salaries", 800, { location: cart2 });
      await actAs(tx, worker1);
      await expense(tx, "packaging", 60);
      const seen = await tx.query("select category from public.expenses");
      expect(seen.rows).toEqual([{ category: "packaging" }]);
      await rejects(tx.query("insert into public.expenses (id, category, amount, spent_on, recorded_by) values (gen_random_uuid(), 'rent', 1, current_date, $1)", [worker1]), /permission denied/);
    });
  });

  it("void_expense is admin-only, needs a reason, and removes the expense from profit", async () => {
    await as(db, admin, async (tx) => {
      const id = randomUUID();
      await expense(tx, "maintenance", 300, { id, location: cart1 });
      await tx.query("savepoint a");
      await rejects(tx.query("select public.void_expense($1, ' ')", [id]), /reason/);
      await tx.query("rollback to savepoint a");
      await actAs(tx, worker1);
      await tx.query("savepoint b");
      await rejects(tx.query("select public.void_expense($1, 'x')", [id]), /Admin only/);
      await tx.query("rollback to savepoint b");
      await actAs(tx, admin);
      await tx.query("select public.void_expense($1, 'entered twice')", [id]);
      const p = await tx.query<{ s: { current: { expenses: number } } }>(`select public.profit_summary(${PERIOD}) as s`);
      expect(p.rows[0].s.current.expenses).toBe(0);
      await rejects(tx.query("delete from public.expenses where id = $1", [id]), /permission denied|not allowed/);
    });
  });
});

describe("profit_summary / product_profit", () => {
  it("P&L: net sales − cost of goods = gross profit; minus wastage, variance and expenses = net profit", async () => {
    await as(db, admin, async (tx) => {
      await actAs(tx, worker1);
      await setDiscountLimit(tx, 10);
      await sale(tx, 2, "upi", 20); // 240 − 20 = 220
      await sale(tx, 1, "cash"); // 120
      const voided = randomUUID();
      await sale(tx, 5, "cash", 0, voided); // voided below: neither revenue nor cost
      await tx.query("select public.record_wastage($1, $2, 2, 'dropped')", [randomUUID(), mat["Veg Patty"]]); // 50
      await expense(tx, "gas_fuel", 100); // cart 1
      await actAs(tx, admin);
      await tx.query("select public.void_order($1, 'mistake')", [voided]);
      await tx.query("select public.admin_adjust_stock($1, $2, -1, 'MANUAL_ADJUSTMENT', 'missing')", [cart1, mat["Veg Patty"]]); // −25
      await expense(tx, "rent", 500); // whole business

      const all = (await tx.query<{ s: ProfitSummary }>(`select public.profit_summary(${PERIOD}) as s`)).rows[0].s;
      expect(all.current).toMatchObject({
        orders: 2,
        gross_sales: 360,
        discounts: 20,
        net_sales: 340,
        cogs: 99, // 3 burgers × (25 + 8)
        gross_profit: 241,
        gross_margin_pct: 70.9,
        wastage_cost: 50,
        stock_variance: -25,
        expenses: 600,
        shared_expenses: 0,
        net_profit: -434, // 241 − 50 − 25 − 600
        net_margin_pct: -127.6,
      });
      expect(all.previous).toMatchObject({ orders: 0, net_sales: 0, net_profit: 0 });
      expect(all.payments).toEqual([
        { method: "upi", orders: 1, amount: 220 },
        { method: "cash", orders: 1, amount: 120 },
      ]);
      expect(all.expenses_by_category).toEqual([
        { category: "rent", amount: 500 },
        { category: "gas_fuel", amount: 100 },
      ]);
      const c1 = all.by_location.find((l) => l.location_id === cart1);
      expect(c1).toMatchObject({ net_sales: 340, expenses: 100, shared_expenses: 500, net_profit: 66 });
      expect(all.by_location.find((l) => l.location_id === central)).toMatchObject({ net_sales: 0 });
      expect(all.daily).toHaveLength(1);
      expect(all.daily[0]).toMatchObject({ net_sales: 340, cogs: 99, gross_profit: 241, stock_loss: 75, expenses: 600, net_profit: -434 });

      // One cart: its own expenses only; shared rent is reported, not subtracted.
      const one = (await tx.query<{ s: ProfitSummary }>(`select public.profit_summary(${PERIOD}, $1) as s`, [cart1])).rows[0].s;
      expect(one.current).toMatchObject({ net_profit: 66, expenses: 100, shared_expenses: 500 });
      expect(one.by_location).toEqual([]);

      const pp = await tx.query(`select name, quantity::int, sales::text, cogs::text, profit::text, margin_pct::text from public.product_profit(${PERIOD})`);
      expect(pp.rows).toEqual([{ name: "Burger", quantity: 3, sales: "360.00", cogs: "99.00", profit: "261.00", margin_pct: "72.5" }]);
    });
  });

  it("cost of goods uses the cost frozen at the time of sale, not today's cost", async () => {
    await as(db, admin, async (tx) => {
      await actAs(tx, worker1);
      await sale(tx, 1);
      await actAs(tx, admin);
      await tx.query("update public.raw_materials set avg_unit_cost = 1000 where name = 'Veg Patty'");
      const s = (await tx.query<{ s: ProfitSummary }>(`select public.profit_summary(${PERIOD}) as s`)).rows[0].s;
      expect(s.current).toMatchObject({ cogs: 33, gross_profit: 87 });
    });
  });

  it.each([
    `select public.profit_summary(${PERIOD})`,
    `select * from public.product_profit(${PERIOD})`,
  ])("workers cannot run %s", async (sql) => {
    await rejects(as(db, worker1, (tx) => tx.query(sql)), /Admin only/);
  });
});

describe("admin_save_location — adding and retiring carts", () => {
  const save = (tx: Tx, id: string | null, name: string, active = true) =>
    tx.query<{ id: string; code: string; name: string; type: string; is_active: boolean }>(
      "select id, code, name, type, is_active from public.admin_save_location($1, $2, null, $3)",
      [id, name, active],
    );

  it("adds a cart with the next code; a worker can then be assigned to it", async () => {
    await as(db, admin, async (tx) => {
      const r = await save(tx, null, "Cart 4 — Station Road");
      expect(r.rows[0]).toMatchObject({ code: "CART4", type: "cart", is_active: true });
      const r2 = await save(tx, null, "Food truck");
      expect(r2.rows[0].code).toBe("CART5");
      await tx.query("select public.admin_update_profile($1, 'Ravi', $2, true)", [worker1, r.rows[0].id]);
      await rejects(save(tx, null, "cart 1"), /already exists/);
    });
  });

  it("renames; refuses to deactivate Central, a cart with workers, or a cart holding stock", async () => {
    await as(db, admin, async (tx) => {
      expect((await save(tx, cart2, "Cart 2 — Beach")).rows[0].name).toBe("Cart 2 — Beach");
      await tx.query("savepoint s");
      await rejects(save(tx, central, "Central Storage", false), /cannot be deactivated/);
      await tx.query("rollback to savepoint s");
      await rejects(save(tx, cart2, "Cart 2", false), /Move or disable the 1 worker/);
      await tx.query("rollback to savepoint s");
      await tx.exec("reset role");
      await tx.query("update public.profiles set is_active = false where id = $1", [worker1]);
      await tx.exec("set local role authenticated");
      await rejects(save(tx, cart1, "Cart 1", false), /still holds stock/);
      await tx.query("rollback to savepoint s");
    });
  });

  it("deactivates an empty cart with no workers", async () => {
    await as(db, admin, async (tx) => {
      expect((await save(tx, cart3, "Cart 3", false)).rows[0].is_active).toBe(false);
      expect((await save(tx, cart3, "Cart 3", true)).rows[0].is_active).toBe(true);
    });
  });

  it("workers cannot manage locations", async () => {
    await rejects(as(db, worker1, (tx) => save(tx, null, "My cart")), /Admin only/);
  });
});

