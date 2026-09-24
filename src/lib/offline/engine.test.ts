import { describe, expect, it } from "vitest";
import { Outbox } from "./engine";
import type { OutboxItem, OutboxStore, RpcResult } from "./types";

class MemoryStore implements OutboxStore {
  items = new Map<string, OutboxItem>();
  async all() {
    return [...this.items.values()].map((i) => ({ ...i }));
  }
  async put(i: OutboxItem) {
    this.items.set(i.id, { ...i });
  }
  async delete(id: string) {
    this.items.delete(id);
  }
}

const NETWORK: RpcResult = { data: null, error: { code: "", message: "TypeError: Failed to fetch" } };
const REJECT = (msg: string): RpcResult => ({ data: null, error: { code: "22023", message: msg } });
const OK = (status = "created"): RpcResult => ({ data: { status }, error: null });

function setup(opts: { online?: boolean; user?: string | null; server?: (fn: string, args: Record<string, unknown>) => RpcResult } = {}) {
  const store = new MemoryStore();
  const calls: string[] = [];
  const state = { online: opts.online ?? true, user: opts.user === undefined ? "u1" : opts.user };
  let t = 0;
  const outbox = new Outbox({
    store,
    rpc: async (fn, args) => {
      calls.push(String(args.p_order_id));
      await new Promise((r) => setTimeout(r, 1));
      return (opts.server ?? (() => OK()))(fn, args);
    },
    currentUserId: async () => state.user,
    isOnline: () => state.online,
    now: () => new Date(Date.UTC(2026, 8, 28, 10, 0, t++)),
  });
  const item = (id: string, userId = "u1") => ({
    id,
    userId,
    kind: "sale" as const,
    fn: "record_sale",
    args: { p_order_id: id },
    summary: `order ${id}`,
  });
  return { store, calls, state, outbox, item };
}

describe("Outbox", () => {
  it("stores first, then syncs and removes on success", async () => {
    const { store, calls, outbox, item } = setup();
    expect(await outbox.submit(item("a"))).toEqual({ outcome: "synced", data: { status: "created" } });
    expect(calls).toEqual(["a"]);
    expect(store.items.size).toBe(0);
  });

  it("offline: keeps the document on the phone and reports it as queued", async () => {
    const { store, calls, outbox, item } = setup({ online: false });
    expect(await outbox.submit(item("a"))).toEqual({ outcome: "queued" });
    expect(calls).toEqual([]);
    expect([...store.items.values()][0]).toMatchObject({ id: "a", status: "pending", attempts: 0 });
    expect(outbox.getStats()).toMatchObject({ pending: 1, failed: 0 });
  });

  it("a connection error stops the run and keeps order; the next sync sends everything once", async () => {
    let down = true;
    const { store, calls, outbox, item, state } = setup({ online: false, server: () => (down ? NETWORK : OK()) });
    await outbox.enqueue(item("a"));
    await outbox.enqueue(item("b"));
    state.online = true;
    await outbox.sync();
    expect(calls).toEqual(["a"]); // stopped after the first network failure
    expect(store.items.size).toBe(2);
    down = false;
    await outbox.sync();
    expect(calls).toEqual(["a", "a", "b"]); // same id resent; server idempotency makes this safe
    expect(store.items.size).toBe(0);
  });

  it("a server 'duplicate' answer counts as success", async () => {
    const { store, outbox, item } = setup({ server: () => OK("duplicate") });
    expect((await outbox.submit(item("a"))).outcome).toBe("synced");
    expect(store.items.size).toBe(0);
  });

  it("a rejection on immediate submit is returned to the form and not kept", async () => {
    const { store, outbox, item } = setup({ server: () => REJECT("Unknown product") });
    expect(await outbox.submit(item("a"))).toEqual({ outcome: "rejected", message: "Unknown product" });
    expect(store.items.size).toBe(0);
  });

  it("a rejection during background sync is kept as FAILED and does not block later items", async () => {
    const { store, calls, outbox, item, state } = setup({
      online: false,
      server: (_fn, args) => (args.p_order_id === "a" ? REJECT("Product disabled") : OK()),
    });
    await outbox.enqueue(item("a"));
    await outbox.enqueue(item("b"));
    state.online = true;
    await outbox.sync();
    expect(calls).toEqual(["a", "b"]);
    expect([...store.items.values()]).toEqual([expect.objectContaining({ id: "a", status: "failed", lastError: "Product disabled" })]);
    expect(outbox.getStats()).toMatchObject({ pending: 0, failed: 1 });
  });

  it("failed items can be retried or discarded", async () => {
    let reject = true;
    const { store, outbox, item, state } = setup({ online: false, server: () => (reject ? REJECT("x") : OK()) });
    await outbox.enqueue(item("a"));
    state.online = true;
    await outbox.sync();
    expect(store.items.get("a")?.status).toBe("failed");
    reject = false;
    await outbox.retry("a");
    expect(store.items.size).toBe(0);

    reject = true;
    state.online = false;
    await outbox.enqueue(item("b"));
    state.online = true;
    await outbox.sync();
    await outbox.discard("b");
    expect(store.items.size).toBe(0);
  });

  it("concurrent syncs never send the same item twice", async () => {
    const { calls, outbox, item, state } = setup({ online: false });
    for (const id of ["a", "b", "c"]) await outbox.enqueue(item(id));
    state.online = true;
    await Promise.all([outbox.sync(), outbox.sync(), outbox.sync()]);
    expect(calls).toEqual(["a", "b", "c"]);
  });

  it("only sends items recorded by the signed-in user", async () => {
    const { store, calls, outbox, item, state } = setup({ online: false });
    await outbox.enqueue(item("mine", "u1"));
    await outbox.enqueue(item("theirs", "u2"));
    state.online = true;
    await outbox.sync();
    expect(calls).toEqual(["mine"]);
    expect([...store.items.keys()]).toEqual(["theirs"]);
    expect(outbox.getStats().pending).toBe(0); // u2's item is not counted for u1
  });

  it("signed out: nothing is sent", async () => {
    const { calls, outbox, item } = setup({ user: null });
    await outbox.enqueue(item("a"));
    await outbox.sync();
    expect(calls).toEqual([]);
  });

  it("no answer in time → queued, and the document is still delivered later", async () => {
    const { store, outbox, item } = setup({
      server: () => {
        throw new Error("never here");
      },
    });
    // Slow server: replace rpc with one that takes longer than the wait.
    (outbox as unknown as { deps: { rpc: unknown } }).deps.rpc = () => new Promise((r) => setTimeout(() => r(OK()), 50));
    expect(await outbox.submit(item("a"), 5)).toEqual({ outcome: "queued" });
    await new Promise((r) => setTimeout(r, 80));
    expect(store.items.size).toBe(0);
  });
});
