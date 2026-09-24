import { beforeAll, describe, expect, it } from "vitest";
import { as, asOwner, createTestDb, createUser, locationId, rejects, type Db } from "./harness";

let db: Db;
let admin: string;
let worker1: string;
let worker2: string;
let cart1: string;
let cart2: string;
let bunId: string;

beforeAll(async () => {
  db = await createTestDb();
  admin = await createUser(db, { username: "owner", role: "admin", fullName: "Owner" });
  worker1 = await createUser(db, { username: "ravi", role: "worker", locationCode: "CART1" });
  worker2 = await createUser(db, { username: "sunil", role: "worker", locationCode: "CART2" });
  cart1 = await locationId(db, "CART1");
  cart2 = await locationId(db, "CART2");

  // Operational fixture data written as owner (as RPCs will do in later phases).
  const m = await db.query<{ id: string }>(
    `insert into public.raw_materials (name, base_unit, display_unit) values ('Burger Bun', 'pcs', 'pcs') returning id`,
  );
  bunId = m.rows[0].id;
  for (const [loc, qty] of [
    [cart1, 20],
    [cart2, 30],
  ] as const) {
    await db.query(
      `insert into public.stock_movements (material_id, location_id, qty_delta, movement_type, ref_type)
       values ($1, $2, $3, 'OPENING_BALANCE', 'opening')`,
      [bunId, loc, qty],
    );
    await db.query(`insert into public.stock_levels (location_id, material_id, quantity) values ($1, $2, $3)`, [
      loc,
      bunId,
      qty,
    ]);
  }
});

describe("reference data", () => {
  it("seeds Central Storage and 3 carts", async () => {
    const r = await db.query<{ code: string; type: string }>("select code, type from public.locations order by sort_order");
    expect(r.rows).toEqual([
      { code: "CENTRAL", type: "central" },
      { code: "CART1", type: "cart" },
      { code: "CART2", type: "cart" },
      { code: "CART3", type: "cart" },
    ]);
  });

  it("allows only one central location", async () => {
    await rejects(
      asOwner(db, (tx) => tx.query(`insert into public.locations (code, name, type) values ('C2','Other','central')`)),
      /duplicate key/,
    );
  });

  it("defaults to IST and flags-not-blocks negative stock on sales", async () => {
    const r = await db.query<{ timezone: string; allow_negative_on_sale: boolean; allow_negative_other: boolean }>(
      "select timezone, allow_negative_on_sale, allow_negative_other from public.app_settings",
    );
    expect(r.rows[0]).toEqual({ timezone: "Asia/Kolkata", allow_negative_on_sale: true, allow_negative_other: false });
  });
});

describe("profiles", () => {
  it("stores role and cart per person", async () => {
    const r = await db.query<{ username: string; role: string; location_id: string | null }>(
      "select username, role, location_id from public.profiles order by username",
    );
    expect(r.rows).toEqual([
      { username: "owner", role: "admin", location_id: null },
      { username: "ravi", role: "worker", location_id: cart1 },
      { username: "sunil", role: "worker", location_id: cart2 },
    ]);
  });

  it("a worker profile must have a cart", async () => {
    await rejects(
      asOwner(db, async (tx) => {
        const u = await tx.query<{ id: string }>("insert into auth.users (email) values ($1) returning id", ["nocart@test.local"]);
        await tx.query("insert into public.profiles (id, username, full_name, role) values ($1, $2, $3, $4)", [
          u.rows[0].id,
          "nocart",
          "No Cart",
          "worker",
        ]);
      }),
      /profiles_worker_has_location/,
    );
  });

  it("a login without a profile (e.g. a stray sign-up) can see and do nothing", async () => {
    await asOwner(db, async (tx) => {
      // Supabase Auth inserts the login row with only provider metadata.
      const u = await tx.query<{ id: string }>("insert into auth.users (email, raw_app_meta_data) values ($1, $2) returning id", [
        "stray@test.local",
        JSON.stringify({ provider: "email", providers: ["email"] }),
      ]);
      expect((await tx.query("select 1 from public.profiles where id = $1", [u.rows[0].id])).rows).toEqual([]);

      await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: u.rows[0].id })]);
      await tx.exec("set local role authenticated");
      expect((await tx.query("select * from public.locations")).rows).toEqual([]);
      expect((await tx.query("select * from public.products")).rows).toEqual([]);
      await tx.exec("savepoint s");
      await expect(tx.query("select public.record_sale(gen_random_uuid(), '[{}]'::jsonb)")).rejects.toThrow(/Not signed in or account disabled/);
      await tx.exec("rollback to savepoint s");
    });
  });

  it("worker sees only their own profile; admin sees all", async () => {
    const mine = await as(db, worker1, (tx) => tx.query("select username from public.profiles"));
    expect(mine.rows).toEqual([{ username: "ravi" }]);
    const all = await as(db, admin, (tx) => tx.query("select count(*)::int as n from public.profiles"));
    expect(all.rows[0]).toEqual({ n: 3 });
  });
});

describe("row level security", () => {
  it("anon sees nothing", async () => {
    await rejects(
      as(db, null, (tx) => tx.query("select * from public.locations")),
      /permission denied/,
    );
  });

  it("worker sees only their own cart's stock", async () => {
    const r = await as(db, worker1, (tx) =>
      tx.query<{ location_id: string; quantity: string }>("select location_id, quantity from public.stock_levels"),
    );
    expect(r.rows).toEqual([{ location_id: cart1, quantity: "20.000" }]);

    const m = await as(db, worker2, (tx) =>
      tx.query<{ location_id: string }>("select location_id from public.stock_movements"),
    );
    expect(m.rows.map((x) => x.location_id)).toEqual([cart2]);
  });

  it("admin sees every location's stock", async () => {
    const r = await as(db, admin, (tx) => tx.query("select count(*)::int as n from public.stock_levels"));
    expect(r.rows[0]).toEqual({ n: 2 });
  });

  it("worker cannot write stock movements or balances directly", async () => {
    await rejects(
      as(db, worker1, (tx) =>
        tx.query(
          `insert into public.stock_movements (material_id, location_id, qty_delta, movement_type, ref_type)
           values ($1, $2, 100, 'MANUAL_ADJUSTMENT', 'adjustment')`,
          [bunId, cart1],
        ),
      ),
      /permission denied/,
    );
    await rejects(
      as(db, worker1, (tx) => tx.query("update public.stock_levels set quantity = 999")),
      /permission denied/,
    );
  });

  it("worker cannot create orders directly (RPC only)", async () => {
    await rejects(
      as(db, worker1, (tx) =>
        tx.query(
          `insert into public.orders (id, location_id, worker_id, occurred_at) values (gen_random_uuid(), $1, $2, now())`,
          [cart1, worker1],
        ),
      ),
      /permission denied/,
    );
  });

  it("worker cannot edit products or raw materials", async () => {
    await rejects(
      as(db, worker1, (tx) => tx.query(`insert into public.products (name) values ('Hacked')`)),
      /row-level security/,
    );
    const r = await as(db, worker1, (tx) =>
      tx.query(`update public.raw_materials set avg_unit_cost = 1 returning id`),
    );
    expect(r.rows).toEqual([]); // RLS hides rows from the update
  });

  it("worker cannot change their own role or cart", async () => {
    await rejects(
      as(db, worker1, (tx) => tx.query(`update public.profiles set role = 'admin' where id = $1`, [worker1])),
      /permission denied/,
    );
  });

  it("worker cannot read audit logs", async () => {
    const r = await as(db, worker1, (tx) => tx.query("select * from public.audit_logs"));
    expect(r.rows).toEqual([]);
  });

  it("deactivated worker loses all access", async () => {
    await asOwner(db, async (tx) => {
      await tx.query("update public.profiles set is_active = false where id = $1", [worker1]);
      await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: worker1 })]);
      await tx.exec("set local role authenticated");
      const levels = await tx.query("select * from public.stock_levels");
      const products = await tx.query("select * from public.products");
      expect(levels.rows).toEqual([]);
      expect(products.rows).toEqual([]);
    });
  });
});

describe("admin master data", () => {
  it("admin can create a product and it is audited with the actor", async () => {
    await as(db, admin, async (tx) => {
      const p = await tx.query<{ id: string }>(
        `insert into public.products (name, selling_price) values ('Burger', 150) returning id`,
      );
      const a = await tx.query<{ actor_id: string; action: string; entity: string }>(
        `select actor_id, action, entity from public.audit_logs where entity_id = $1`,
        [p.rows[0].id],
      );
      expect(a.rows).toEqual([{ actor_id: admin, action: "insert", entity: "products" }]);
    });
  });

  it("rejects a display unit that does not convert to the base unit", async () => {
    await rejects(
      as(db, admin, (tx) =>
        tx.query(`insert into public.raw_materials (name, base_unit, display_unit) values ('Milk', 'ml', 'kg')`),
      ),
      /does not convert/,
    );
  });

  it("admin cannot delete products (deactivate instead)", async () => {
    await rejects(
      asOwner(db, async (tx) => {
        await tx.query(`insert into public.products (name) values ('Temp')`);
        await tx.query(`delete from public.products`);
      }),
      /append-only/,
    );
  });
});

describe("ledger immutability", () => {
  it("stock movements cannot be updated or deleted, even by the owner", async () => {
    await rejects(
      asOwner(db, (tx) => tx.query("update public.stock_movements set qty_delta = 1")),
      /append-only/,
    );
    await rejects(
      asOwner(db, (tx) => tx.query("delete from public.stock_movements")),
      /append-only/,
    );
  });

  it("audit logs cannot be altered", async () => {
    await rejects(
      asOwner(db, (tx) => tx.query("delete from public.audit_logs")),
      /append-only/,
    );
  });
});
