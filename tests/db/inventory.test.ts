import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { as, asCommitted, createTestDb, createUser, locationId, rejects, type Db, type Tx } from "./harness";
import { actAs, idsByName, sampleSheet } from "./fixtures";

let db: Db;
let admin: string;
let worker1: string;
let worker2: string;
let central: string;
let cart1: string;
let cart2: string;
let cart3: string;
let mat: Record<string, string>;
let prod: Record<string, string>;

async function stock(tx: Tx, location: string, name: string): Promise<number> {
  const r = await tx.query<{ quantity: string }>(
    "select quantity from public.stock_levels where location_id = $1 and material_id = $2",
    [location, mat[name]],
  );
  return r.rows[0] ? Number(r.rows[0].quantity) : 0;
}

async function rpc<T = Record<string, unknown>>(tx: Tx, sql: string, params: unknown[]): Promise<T> {
  const r = await tx.query<{ r: T }>(`select ${sql} as r`, params);
  return r.rows[0].r;
}

async function ledgerOk(tx: Tx) {
  await actAs(tx, admin);
  expect((await tx.query("select * from public.verify_stock_levels()")).rows).toEqual([]);
}

const receipt = (tx: Tx, id: string, items: object[], location: string | null = null, supplier: string | null = null) =>
  rpc(tx, "public.record_receipt($1, $2, $3, null, null, null, $4)", [id, JSON.stringify(items), supplier, location]);

beforeAll(async () => {
  db = await createTestDb();
  admin = await createUser(db, { username: "owner", role: "admin" });
  worker1 = await createUser(db, { username: "ravi", role: "worker", locationCode: "CART1" });
  worker2 = await createUser(db, { username: "sunil", role: "worker", locationCode: "CART2" });
  central = await locationId(db, "CENTRAL");
  cart1 = await locationId(db, "CART1");
  cart2 = await locationId(db, "CART2");
  cart3 = await locationId(db, "CART3");

  await asCommitted(db, admin, async (tx) => {
    await tx.query("select public.import_recipe_sheet($1)", [JSON.stringify(sampleSheet())]);
    mat = await idsByName(tx, "raw_materials");
    prod = await idsByName(tx, "products");
    await tx.query("update public.raw_materials set avg_unit_cost = 25 where name = 'Veg Patty'");
    for (const [loc, qty] of [
      [central, 100],
      [cart1, 20],
      [cart2, 30],
    ] as const) {
      await tx.query("select public.admin_adjust_stock($1, $2, $3, 'OPENING_BALANCE')", [loc, mat["Veg Patty"], qty]);
    }
  });
});

describe("receiving stock", () => {
  it("a worker's receipt adds stock to their own cart (30 → 40) and is idempotent", async () => {
    await as(db, worker2, async (tx) => {
      const id = randomUUID();
      const items = [{ material_id: mat["Veg Patty"], quantity: 10, entered_qty: 10, entered_unit: "pcs" }];
      expect(await receipt(tx, id, items)).toMatchObject({ status: "created", lines: 1 });
      expect(await stock(tx, cart2, "Veg Patty")).toBe(40);
      expect(await receipt(tx, id, items)).toMatchObject({ status: "duplicate" });
      expect(await stock(tx, cart2, "Veg Patty")).toBe(40);
      await ledgerOk(tx);
    });
  });

  it("updates the weighted-average cost from the price paid", async () => {
    await as(db, worker1, async (tx) => {
      // On hand: 150 patties @ ₹25. Buy 50 for ₹1,500 (₹30 each) → (150×25 + 50×30) / 200 = ₹26.25
      await receipt(tx, randomUUID(), [{ material_id: mat["Veg Patty"], quantity: 50, line_cost: 1500 }]);
      const r = await tx.query<{ avg_unit_cost: string }>("select avg_unit_cost from public.raw_materials where id = $1", [
        mat["Veg Patty"],
      ]);
      expect(r.rows[0].avg_unit_cost).toBe("26.2500");
      const m = await tx.query<{ unit_cost: string }>(
        "select unit_cost from public.stock_movements where movement_type = 'PURCHASE'",
      );
      expect(m.rows).toEqual([{ unit_cost: "30.0000" }]);
    });
  });

  it("converts entered kg to base grams (the app sends base units)", async () => {
    await as(db, worker1, async (tx) => {
      await receipt(tx, randomUUID(), [{ material_id: mat["Paneer"], quantity: 2500, entered_qty: 2.5, entered_unit: "kg" }]);
      expect(await stock(tx, cart1, "Paneer")).toBe(2500);
    });
  });

  it("a worker cannot receive into another location", async () => {
    await rejects(
      as(db, worker1, (tx) => receipt(tx, randomUUID(), [{ material_id: mat["Veg Patty"], quantity: 1 }], cart2)),
      /own cart/,
    );
  });

  it("the admin records purchases at Central Storage, and must name a location", async () => {
    await as(db, admin, async (tx) => {
      await receipt(tx, randomUUID(), [{ material_id: mat["Veg Patty"], quantity: 40 }], central);
      expect(await stock(tx, central, "Veg Patty")).toBe(140);
    });
    await rejects(
      as(db, admin, (tx) => receipt(tx, randomUUID(), [{ material_id: mat["Veg Patty"], quantity: 1 }])),
      /valid location/,
    );
  });

  it("rejects unknown materials, zero quantities and negative costs", async () => {
    await rejects(as(db, worker1, (tx) => receipt(tx, randomUUID(), [{ material_id: randomUUID(), quantity: 1 }])), /Unknown raw material/);
    await rejects(as(db, worker1, (tx) => receipt(tx, randomUUID(), [{ material_id: mat["Milk"], quantity: 0 }])), /greater than zero/);
    await rejects(
      as(db, worker1, (tx) => receipt(tx, randomUUID(), [{ material_id: mat["Milk"], quantity: 5, line_cost: -1 }])),
      /negative/,
    );
  });

  it("voiding a receipt reverses it; blocked if that would make stock negative", async () => {
    await as(db, admin, async (tx) => {
      const id = randomUUID();
      await actAs(tx, worker1);
      await receipt(tx, id, [{ material_id: mat["Veg Patty"], quantity: 10 }]);
      await actAs(tx, admin);
      await tx.query("select public.void_receipt($1, 'wrong quantity')", [id]);
      expect(await stock(tx, cart1, "Veg Patty")).toBe(20);
      await ledgerOk(tx);
    });
    await rejects(
      as(db, admin, async (tx) => {
        const id = randomUUID();
        await actAs(tx, worker1);
        await receipt(tx, id, [{ material_id: mat["Milk"], quantity: 1000 }]);
        await tx.query("select public.record_sale($1, $2)", [randomUUID(), JSON.stringify([{ product_id: prod["Shake"], quantity: 2 }])]);
        await actAs(tx, admin);
        return tx.query("select public.void_receipt($1, 'test')", [id]); // 600 ml left, reversing 1000 → −400
      }),
      /Not enough stock for: Milk/,
    );
  });
});

describe("wastage", () => {
  const waste = (tx: Tx, id: string, material: string, qty: number, reason = "spoiled", notes: string | null = null) =>
    rpc(tx, "public.record_wastage($1, $2, $3, $4, $5)", [id, mat[material], qty, reason, notes]);

  it("reduces stock, records cost, and is idempotent", async () => {
    await as(db, worker1, async (tx) => {
      const id = randomUUID();
      expect(await waste(tx, id, "Veg Patty", 2, "dropped")).toMatchObject({ status: "created", remaining: 18, cost: 50 });
      expect(await waste(tx, id, "Veg Patty", 2, "dropped")).toMatchObject({ status: "duplicate" });
      expect(await stock(tx, cart1, "Veg Patty")).toBe(18);
      await ledgerOk(tx);
    });
  });

  it("cannot waste more than is in stock", async () => {
    await rejects(as(db, worker1, (tx) => waste(tx, randomUUID(), "Veg Patty", 21)), /Not enough stock for: Veg Patty/);
  });

  it("needs a note when the reason is 'other'", async () => {
    await rejects(as(db, worker1, (tx) => waste(tx, randomUUID(), "Veg Patty", 1, "other")), /Add a note/);
  });

  it("admin can void wastage; stock returns", async () => {
    await as(db, admin, async (tx) => {
      const id = randomUUID();
      await actAs(tx, worker1);
      await waste(tx, id, "Veg Patty", 3);
      await actAs(tx, admin);
      await tx.query("select public.void_wastage($1, 'mistake')", [id]);
      expect(await stock(tx, cart1, "Veg Patty")).toBe(20);
      await ledgerOk(tx);
    });
  });
});

describe("transfers", () => {
  const items = (qty: number) => JSON.stringify([{ material_id: mat["Veg Patty"], quantity: qty }]);

  it("stock leaves the source on dispatch and arrives only on receipt — never double-counted", async () => {
    await as(db, admin, async (tx) => {
      const id = randomUUID();
      await rpc(tx, "public.create_transfer($1, $2, $3, $4)", [id, central, cart3, items(25)]);
      expect(await stock(tx, central, "Veg Patty")).toBe(75);
      expect(await stock(tx, cart3, "Veg Patty")).toBe(0); // in transit
      const total = await tx.query<{ t: string }>("select sum(quantity)::text as t from public.stock_levels where material_id = $1", [
        mat["Veg Patty"],
      ]);
      expect(total.rows[0].t).toBe("125.000"); // 150 − 25 in transit

      expect(await rpc(tx, "public.receive_transfer($1)", [id])).toMatchObject({ status: "received", short_items: 0 });
      expect(await stock(tx, cart3, "Veg Patty")).toBe(25);
      expect(await rpc(tx, "public.receive_transfer($1)", [id])).toMatchObject({ status: "duplicate" });
      expect(await stock(tx, cart3, "Veg Patty")).toBe(25);
      await ledgerOk(tx);
    });
  });

  it("the destination worker receives; a short delivery is recorded", async () => {
    await as(db, admin, async (tx) => {
      const id = randomUUID();
      await rpc(tx, "public.create_transfer($1, $2, $3, $4)", [id, central, cart1, items(10)]);
      await actAs(tx, worker1);
      const r = await rpc(tx, "public.receive_transfer($1, $2)", [
        id,
        JSON.stringify([{ material_id: mat["Veg Patty"], qty_received: 8 }]),
      ]);
      expect(r).toMatchObject({ short_items: 1 });
      expect(await stock(tx, cart1, "Veg Patty")).toBe(28);
      const ti = await tx.query("select qty_sent, qty_received from public.stock_transfer_items where transfer_id = $1", [id]);
      expect(ti.rows).toEqual([{ qty_sent: "10.000", qty_received: "8.000" }]);
      await ledgerOk(tx);
    });
  });

  it("another cart's worker cannot receive it", async () => {
    await rejects(
      as(db, admin, async (tx) => {
        const id = randomUUID();
        await rpc(tx, "public.create_transfer($1, $2, $3, $4)", [id, central, cart1, items(5)]);
        await actAs(tx, worker2);
        return rpc(tx, "public.receive_transfer($1)", [id]);
      }),
      /Transfer not found/,
    );
  });

  it("a worker can send from their own cart only", async () => {
    await as(db, worker1, async (tx) => {
      await rpc(tx, "public.create_transfer($1, $2, $3, $4)", [randomUUID(), cart1, cart2, items(5)]);
      expect(await stock(tx, cart1, "Veg Patty")).toBe(15);
    });
    await rejects(
      as(db, worker1, (tx) => rpc(tx, "public.create_transfer($1, $2, $3, $4)", [randomUUID(), cart2, cart1, items(5)])),
      /own cart/,
    );
  });

  it("cannot send more than the source has", async () => {
    await rejects(
      as(db, worker1, (tx) => rpc(tx, "public.create_transfer($1, $2, $3, $4)", [randomUUID(), cart1, cart2, items(21)])),
      /Not enough stock/,
    );
  });

  it("cancelling a transfer in transit returns the stock to the source", async () => {
    await as(db, admin, async (tx) => {
      const id = randomUUID();
      await rpc(tx, "public.create_transfer($1, $2, $3, $4)", [id, cart2, cart3, items(10)]);
      expect(await stock(tx, cart2, "Veg Patty")).toBe(20);
      await tx.query("select public.cancel_transfer($1, 'not needed')", [id]);
      expect(await stock(tx, cart2, "Veg Patty")).toBe(30);
      expect(await stock(tx, cart3, "Veg Patty")).toBe(0);
      await tx.exec("savepoint s");
      await expect(tx.query("select public.receive_transfer($1)", [id])).rejects.toThrow(/cancelled/);
      await tx.exec("rollback to savepoint s");
      await ledgerOk(tx);
    });
  });
});

describe("stock requests", () => {
  it("request → transfer → receive marks it fulfilled", async () => {
    await as(db, admin, async (tx) => {
      const req = randomUUID();
      await actAs(tx, worker1);
      await rpc(tx, "public.create_stock_request($1, $2)", [req, JSON.stringify([{ material_id: mat["Veg Patty"], quantity: 30 }])]);

      await actAs(tx, admin);
      const t = randomUUID();
      await rpc(tx, "public.create_transfer($1, $2, $3, $4, null, $5)", [
        t,
        central,
        cart1,
        JSON.stringify([{ material_id: mat["Veg Patty"], quantity: 30 }]),
        req,
      ]);
      const status = async () =>
        (await tx.query<{ status: string }>("select status from public.stock_requests where id = $1", [req])).rows[0].status;
      expect(await status()).toBe("approved");

      await actAs(tx, worker1);
      await rpc(tx, "public.receive_transfer($1)", [t]);
      expect(await status()).toBe("fulfilled");
      expect(await stock(tx, cart1, "Veg Patty")).toBe(50);
    });
  });

  it("a request cannot be sent twice while the first transfer is on the way", async () => {
    await rejects(
      as(db, admin, async (tx) => {
        const req = randomUUID();
        const items = JSON.stringify([{ material_id: mat["Veg Patty"], quantity: 5 }]);
        await actAs(tx, worker1);
        await rpc(tx, "public.create_stock_request($1, $2)", [req, items]);
        await actAs(tx, admin);
        await rpc(tx, "public.create_transfer($1, $2, $3, $4, null, $5)", [randomUUID(), central, cart1, items, req]);
        return rpc(tx, "public.create_transfer($1, $2, $3, $4, null, $5)", [randomUUID(), central, cart1, items, req]);
      }),
      /already on the way/,
    );
  });

  it("workers can cancel their own pending request but not approve it", async () => {
    const req = randomUUID();
    await as(db, worker1, async (tx) => {
      await rpc(tx, "public.create_stock_request($1, $2)", [req, JSON.stringify([{ material_id: mat["Milk"], quantity: 2000 }])]);
      await rpc(tx, "public.update_stock_request($1, 'cancelled')", [req]);
    });
    await rejects(
      as(db, worker1, async (tx) => {
        await rpc(tx, "public.create_stock_request($1, $2)", [req, JSON.stringify([{ material_id: mat["Milk"], quantity: 2000 }])]);
        return rpc(tx, "public.update_stock_request($1, 'approved')", [req]);
      }),
      /only cancel/,
    );
  });

  it("a worker cannot see another cart's requests", async () => {
    await as(db, admin, async (tx) => {
      const req = randomUUID();
      await actAs(tx, worker2);
      await rpc(tx, "public.create_stock_request($1, $2)", [req, JSON.stringify([{ material_id: mat["Milk"], quantity: 1 }])]);
      await actAs(tx, worker1);
      expect((await tx.query("select 1 from public.stock_requests where id = $1", [req])).rows).toEqual([]);
    });
  });
});

describe("stock counts", () => {
  const count = (tx: Tx, id: string, qty: number, location: string | null = null) =>
    rpc<{ count_status: string; variances: { variance: string }[] }>(tx, "public.submit_stock_count($1, $2, null, $3)", [
      id,
      JSON.stringify([{ material_id: mat["Veg Patty"], counted_qty: qty }]),
      location,
    ]);

  it("a worker's count changes nothing until the admin approves it", async () => {
    await as(db, admin, async (tx) => {
      const id = randomUUID();
      await actAs(tx, worker1);
      const r = await count(tx, id, 17);
      expect(r.count_status).toBe("draft");
      expect(r.variances).toHaveLength(1);
      expect(Number(r.variances[0].variance)).toBe(-3);
      expect(await stock(tx, cart1, "Veg Patty")).toBe(20);

      await actAs(tx, admin);
      await rpc(tx, "public.review_stock_count($1, true)", [id]);
      expect(await stock(tx, cart1, "Veg Patty")).toBe(17);
      await ledgerOk(tx);
    });
  });

  it("sales between counting and approval are not double-corrected", async () => {
    await as(db, admin, async (tx) => {
      const id = randomUUID();
      await actAs(tx, worker1);
      await count(tx, id, 18); // expected 20 → variance −2
      await tx.query("select public.record_sale($1, $2)", [
        randomUUID(),
        JSON.stringify([{ product_id: prod["Burger"], quantity: 5 }]),
      ]); // 20 → 15
      await actAs(tx, admin);
      await rpc(tx, "public.review_stock_count($1, true)", [id]);
      expect(await stock(tx, cart1, "Veg Patty")).toBe(13); // 15 − 2, not reset to 18
    });
  });

  it("an admin count posts immediately; a rejected count changes nothing", async () => {
    await as(db, admin, async (tx) => {
      expect((await count(tx, randomUUID(), 95, central)).count_status).toBe("posted");
      expect(await stock(tx, central, "Veg Patty")).toBe(95);

      const id = randomUUID();
      await actAs(tx, worker1);
      await count(tx, id, 5);
      await actAs(tx, admin);
      await rpc(tx, "public.review_stock_count($1, false, 'Recount please')", [id]);
      expect(await stock(tx, cart1, "Veg Patty")).toBe(20);
      const c = await tx.query("select status, review_note from public.stock_counts where id = $1", [id]);
      expect(c.rows).toEqual([{ status: "rejected", review_note: "Recount please" }]);
    });
  });

  it("workers cannot approve counts", async () => {
    await rejects(
      as(db, worker1, async (tx) => {
        const id = randomUUID();
        await count(tx, id, 10);
        return rpc(tx, "public.review_stock_count($1, true)", [id]);
      }),
      /Admin only/,
    );
  });
});

describe("worker restrictions", () => {
  it.each([
    ["void_receipt", "select public.void_receipt(gen_random_uuid(), 'x')"],
    ["void_wastage", "select public.void_wastage(gen_random_uuid(), 'x')"],
    ["cancel_transfer", "select public.cancel_transfer(gen_random_uuid(), 'x')"],
  ])("cannot call %s", async (_n, sql) => {
    await rejects(as(db, worker1, (tx) => tx.query(sql)), /Admin only/);
  });
});
