import { beforeAll, describe, expect, it } from "vitest";
import { as, createTestDb, createUser, rejects, type Db, type Tx } from "./harness";
import { sampleSheet } from "./fixtures";

let db: Db;
let admin: string;

const importSheet = (tx: Tx, sheet: unknown) =>
  tx.query<{ r: Record<string, number> }>("select public.import_recipe_sheet($1) as r", [JSON.stringify(sheet)]).then((r) => r.rows[0].r);

async function count(tx: Tx, table: string): Promise<number> {
  return (await tx.query<{ n: number }>(`select count(*)::int as n from public.${table}`)).rows[0].n;
}

beforeAll(async () => {
  db = await createTestDb();
  admin = await createUser(db, { username: "owner", role: "admin" });
});

describe("import_recipe_sheet with prices", () => {
  it("sets prices on new products and updates only changed prices later", async () => {
    await as(db, admin, async (tx) => {
      const sheet = sampleSheet();
      const priced = {
        ...sheet,
        products: sheet.products.map((p) => ({ ...p, selling_price: p.name === "Burger" ? 120 : p.name === "Fries" ? 80 : null })),
      };
      expect(await importSheet(tx, priced)).toMatchObject({ products_created: 5, prices_updated: 0 });
      const prices = await tx.query<{ name: string; selling_price: string }>(
        "select name, selling_price from public.products where name in ('Burger', 'Fries', 'Roll') order by name",
      );
      expect(prices.rows).toEqual([
        { name: "Burger", selling_price: "120.00" },
        { name: "Fries", selling_price: "80.00" },
        { name: "Roll", selling_price: "0.00" },
      ]);

      priced.products.find((p) => p.name === "Burger")!.selling_price = 130;
      expect(await importSheet(tx, priced)).toMatchObject({ prices_updated: 1, recipes_created: 0, recipes_unchanged: 5 });
    });
  });

  it("is all-or-nothing: one bad product rolls back everything, including new materials", async () => {
    await as(db, admin, async (tx) => {
      const sheet = sampleSheet();
      sheet.materials.push({ name: "Saffron", base_unit: "g" });
      sheet.products.push({ name: "Broken", items: [{ material: "Not a material", quantity: 1, entered_qty: 1, entered_unit: "pcs" }] });
      await tx.exec("savepoint s");
      await expect(importSheet(tx, sheet)).rejects.toThrow(/not in the materials list/);
      await tx.exec("rollback to savepoint s");
      expect(await count(tx, "raw_materials")).toBe(0);
      expect(await count(tx, "products")).toBe(0);
      expect(await count(tx, "product_recipes")).toBe(0);
    });
  });

  it("rejects negative prices", async () => {
    await rejects(
      as(db, admin, (tx) =>
        importSheet(tx, {
          materials: [{ name: "Bun", base_unit: "pcs" }],
          products: [{ name: "Burger", selling_price: -5, items: [{ material: "Bun", quantity: 1 }] }],
        }),
      ),
      /price cannot be negative/,
    );
  });
});
