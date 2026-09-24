import { beforeAll, describe, expect, it } from "vitest";
import { as, createTestDb, createUser, locationId, rejects, type Db } from "./harness";

let db: Db;
let admin: string;
let worker: string;
let cart1: string;
let cart3: string;
let central: string;

const UPDATE = "select * from public.admin_update_profile($1, $2, $3, $4)";

beforeAll(async () => {
  db = await createTestDb();
  admin = await createUser(db, { username: "owner", role: "admin" });
  worker = await createUser(db, { username: "ravi", role: "worker", locationCode: "CART1", fullName: "Ravi" });
  cart1 = await locationId(db, "CART1");
  cart3 = await locationId(db, "CART3");
  central = await locationId(db, "CENTRAL");
});

describe("admin_update_profile", () => {
  it("admin can move a worker to another cart, and the change is audited with the admin as actor", async () => {
    await as(db, admin, async (tx) => {
      const r = await tx.query<{ location_id: string; full_name: string }>(UPDATE, [worker, "Ravi K", cart3, true]);
      expect(r.rows[0]).toMatchObject({ location_id: cart3, full_name: "Ravi K" });

      const a = await tx.query<{ actor_id: string; action: string; old_loc: string; new_loc: string }>(
        `select actor_id, action, old_value->>'location_id' as old_loc, new_value->>'location_id' as new_loc
           from public.audit_logs where entity = 'profiles' and entity_id = $1 and action = 'update'`,
        [worker],
      );
      expect(a.rows).toEqual([{ actor_id: admin, action: "update", old_loc: cart1, new_loc: cart3 }]);
    });
  });

  it("workers must be assigned to a cart, not Central Storage", async () => {
    await rejects(as(db, admin, (tx) => tx.query(UPDATE, [worker, null, central, true])), /active cart/);
  });

  it("admin cannot deactivate themselves", async () => {
    await rejects(as(db, admin, (tx) => tx.query(UPDATE, [admin, null, null, false])), /your own account/);
  });

  it("a worker cannot call it", async () => {
    await rejects(as(db, worker, (tx) => tx.query(UPDATE, [worker, "Boss", cart3, true])), /Only an admin/);
  });

  it("a worker cannot write arbitrary audit entries", async () => {
    await rejects(
      as(db, worker, (tx) =>
        tx.query("select public.log_admin_action($1, 'x', 'y', 'z', '{}')", [worker]),
      ),
      /permission denied/,
    );
  });
});
