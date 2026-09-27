import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { as, createBusiness, createTestDb, createUser, type Db } from "./harness";

// The Chai Point demo seeder (scripts/demo/chai-demo.sql) must keep every stock rule:
// run it for a week on a fresh business and check the ledger and the screens' data.
let db: Db;
let admin: string;

beforeAll(async () => {
  db = await createTestDb();
  await createBusiness(db, "CHAIPOINT", 1);
  admin = await createUser(db, { username: "ravi", role: "admin", business: "CHAIPOINT" });
  await db.exec(readFileSync("scripts/demo/chai-demo.sql", "utf8"));
  await db.query("select demo_seed.setup('CHAIPOINT', 'ravi')");
  // Workers, as the seeding script creates them after setup.
  for (const [username, cart] of [["arjun", "CART1"], ["neha", "CART1"], ["priya", "CART2"], ["sameer", "CART3"]]) {
    await createUser(db, { username, role: "worker", locationCode: cart, business: "CHAIPOINT" });
  }
  await db.query("select demo_seed.run_days('CHAIPOINT', 8, 4)");
  await db.query("select demo_seed.run_days('CHAIPOINT', 3, 0)");
  await db.query("select demo_seed.finish('CHAIPOINT')");
  await db.exec("drop schema demo_seed cascade");
}, 300_000);

describe("Chai Point demo data", () => {
  it("keeps the ledger and balances identical", async () => {
    await as(db, admin, async (tx) => {
      expect((await tx.query("select * from public.verify_stock_levels()")).rows).toEqual([]);
    });
  });

  it("fills every area of the app", async () => {
    await as(db, admin, async (tx) => {
      const n = async (sql: string) => Number((await tx.query<{ n: string }>(`select count(*) as n from (${sql}) x`)).rows[0].n);
      expect(await n("select 1 from public.products")).toBe(10); // 8 + 2 sizes
      expect(await n("select 1 from public.addons")).toBe(4);
      expect(await n("select 1 from public.locations where type = 'cart'")).toBe(3);
      expect(await n("select 1 from public.orders where status = 'completed'")).toBeGreaterThan(300);
      expect(await n("select 1 from public.order_item_addons")).toBeGreaterThan(10);
      expect(await n("select 1 from public.orders where discount_amount > 0")).toBeGreaterThan(0);
      expect(await n("select distinct payment_method from public.orders")).toBe(3);
      expect(await n("select 1 from public.purchase_receipts")).toBeGreaterThan(10);
      expect(await n("select 1 from public.stock_transfers where status = 'received'")).toBeGreaterThan(0);
      expect(await n("select 1 from public.stock_transfers where status = 'in_transit'")).toBe(1);
      expect(await n("select 1 from public.wastage")).toBeGreaterThan(0);
      expect(await n("select 1 from public.expenses")).toBeGreaterThan(5);
      expect(await n("select 1 from public.stock_counts where status = 'posted'")).toBeGreaterThan(0);
      expect(await n("select 1 from public.stock_counts where status = 'draft'")).toBe(1);
      expect(await n("select 1 from public.stock_requests where status = 'pending'")).toBe(1);
    });
  });

  it("produces believable numbers: profitable, costed, no stock below zero", async () => {
    await as(db, admin, async (tx) => {
      const s = await tx.query<{ s: { current: { net_sales: number; gross_margin_pct: number; cogs: number } } }>(
        "select public.profit_summary(now() - interval '9 days', now() + interval '1 hour') as s",
      );
      const c = s.rows[0].s.current;
      expect(c.cogs).toBeGreaterThan(0);
      expect(c.gross_margin_pct).toBeGreaterThan(50);
      expect(c.gross_margin_pct).toBeLessThan(85);
      const neg = await tx.query("select m.name, sl.quantity from public.stock_levels sl join public.raw_materials m on m.id = sl.material_id where sl.quantity < 0");
      expect(neg.rows).toEqual([]);
    });
  });
});
