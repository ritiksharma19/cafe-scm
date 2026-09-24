import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { Outbox } from "./engine";
import { idbStore } from "./idb-store";

const item = (id: string) => ({ id, userId: "u1", kind: "sale" as const, fn: "record_sale", args: { p_order_id: id }, summary: id });

describe("IndexedDB outbox", () => {
  it("keeps orders across an app restart and delivers each exactly once", async () => {
    const sent: string[] = [];
    const deps = (online: boolean) => ({
      store: idbStore,
      rpc: async (_fn: string, args: Record<string, unknown>) => {
        sent.push(String(args.p_order_id));
        return { data: { status: "created" }, error: null };
      },
      currentUserId: async () => "u1",
      isOnline: () => online,
    });

    // Offline: two sales recorded, then the app is closed.
    const before = new Outbox(deps(false));
    expect((await before.submit(item("a"))).outcome).toBe("queued");
    expect((await before.submit(item("b"))).outcome).toBe("queued");
    expect((await idbStore.all()).map((i) => i.id).sort()).toEqual(["a", "b"]);

    // App reopened later with signal: a fresh Outbox reads the same IndexedDB.
    const after = new Outbox(deps(true));
    await after.sync();
    await after.sync(); // a second run finds nothing left to send
    expect(sent).toEqual(["a", "b"]);
    expect(await idbStore.all()).toEqual([]);
  });
});
