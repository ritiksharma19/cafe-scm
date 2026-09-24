import { isDefinitiveFailure } from "@/lib/sale";
import type { OutboxItem, OutboxStats, OutboxStore, Rpc, SubmitOutcome } from "./types";

export interface OutboxDeps {
  store: OutboxStore;
  rpc: Rpc;
  /** The signed-in user's id, or null when signed out / unknown. */
  currentUserId: () => Promise<string | null>;
  isOnline: () => boolean;
  now?: () => Date;
}

/**
 * Durable outbox for worker documents.
 *
 * Rules:
 *  - A document is written to storage BEFORE any network call, so it survives a
 *    closed app, a dead battery or a lost connection.
 *  - It is sent with the same id every time; the server's idempotency (ON CONFLICT
 *    on the id) guarantees a retry can never record it twice.
 *  - Items are sent oldest-first, one at a time. A network failure stops the run
 *    (retried later); a server rejection marks only that item as failed and the run
 *    continues. Failed items are never silently dropped — a person decides.
 *  - Only the user who recorded an item may send it.
 */
export class Outbox {
  private running: Promise<void> | null = null;
  /** Outcome of the most recent attempt per item (in memory), used by submit(). */
  private lastResults = new Map<string, SubmitOutcome>();
  private listeners = new Set<(s: OutboxStats) => void>();
  private stats: OutboxStats = { pending: 0, failed: 0, syncing: false, oldestPendingAt: null };
  private readonly now: () => Date;

  constructor(private readonly deps: OutboxDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  subscribe(fn: (s: OutboxStats) => void): () => void {
    this.listeners.add(fn);
    fn(this.stats);
    return () => this.listeners.delete(fn);
  }

  getStats(): OutboxStats {
    return this.stats;
  }

  async items(): Promise<OutboxItem[]> {
    return (await this.deps.store.all()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async refreshStats(): Promise<OutboxStats> {
    const userId = await this.deps.currentUserId();
    const mine = (await this.deps.store.all()).filter((i) => i.userId === userId);
    const pending = mine.filter((i) => i.status === "pending");
    this.stats = {
      pending: pending.length,
      failed: mine.filter((i) => i.status === "failed").length,
      syncing: this.running !== null,
      oldestPendingAt: pending.map((i) => i.createdAt).sort()[0] ?? null,
    };
    for (const l of this.listeners) l(this.stats);
    return this.stats;
  }

  async enqueue(item: Omit<OutboxItem, "attempts" | "status" | "createdAt"> & { createdAt?: string }): Promise<OutboxItem> {
    const full: OutboxItem = { ...item, createdAt: item.createdAt ?? this.now().toISOString(), attempts: 0, status: "pending" };
    await this.deps.store.put(full);
    await this.refreshStats();
    return full;
  }

  /** Sends pending items. Concurrent calls share one run (never two sends of the same item). */
  sync(): Promise<void> {
    if (!this.running) {
      this.running = this.run().finally(() => {
        this.running = null;
        void this.refreshStats();
      });
      void this.refreshStats();
    }
    return this.running;
  }

  private async run(): Promise<void> {
    if (!this.deps.isOnline()) return;
    const userId = await this.deps.currentUserId();
    if (!userId) return;
    const queue = (await this.items()).filter((i) => i.status === "pending" && i.userId === userId);

    for (const item of queue) {
      const attempt: OutboxItem = { ...item, attempts: item.attempts + 1, lastAttemptAt: this.now().toISOString() };
      let result;
      try {
        result = await this.deps.rpc(item.fn, item.args);
      } catch (e) {
        result = { data: null, error: { message: (e as Error).message } };
      }

      if (!result.error) {
        await this.deps.store.delete(item.id); // created or duplicate: the server has it
        this.lastResults.set(item.id, { outcome: "synced", data: result.data });
      } else if (isDefinitiveFailure(result.error)) {
        await this.deps.store.put({ ...attempt, status: "failed", lastError: result.error.message });
        this.lastResults.set(item.id, { outcome: "rejected", message: result.error.message });
      } else {
        await this.deps.store.put({ ...attempt, lastError: result.error.message });
        return; // connection problem: stop, keep order, try again later
      }
      await this.refreshStats();
    }
  }

  /**
   * Stores a document, then tries to send it right away. Resolves with:
   *  - synced   → the server has it
   *  - queued   → offline / no answer in time; it is safe on the phone
   *  - rejected → the server refused it (e.g. validation); it is NOT kept, so the
   *               worker can correct the form and submit again
   */
  async submit(item: Omit<OutboxItem, "attempts" | "status" | "createdAt">, waitMs = 8000): Promise<SubmitOutcome> {
    await this.enqueue(item);
    this.lastResults.delete(item.id);
    if (!this.deps.isOnline()) return { outcome: "queued" };

    const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), waitMs));
    await Promise.race([this.syncUntilAttempted(item.id), timeout]);

    const result = this.lastResults.get(item.id);
    if (result?.outcome === "rejected") {
      await this.deps.store.delete(item.id);
      await this.refreshStats();
      return result;
    }
    return result ?? { outcome: "queued" };
  }

  /** Runs sync until the given item has been attempted (it may be behind a run already in progress). */
  private async syncUntilAttempted(id: string): Promise<void> {
    for (let i = 0; i < 3 && !this.lastResults.has(id); i++) {
      await this.sync();
      const still = (await this.deps.store.all()).find((x) => x.id === id);
      if (!still || still.status === "failed" || this.lastResults.has(id)) return;
      if (!this.deps.isOnline()) return;
      if (still.attempts > 0) return; // attempted and hit a connection problem
    }
  }

  /** Puts a failed item back in the queue and syncs. */
  async retry(id: string): Promise<void> {
    const item = (await this.deps.store.all()).find((i) => i.id === id);
    if (!item) return;
    await this.deps.store.put({ ...item, status: "pending", lastError: undefined });
    await this.refreshStats();
    await this.sync();
  }

  /** Removes an item for good (only offered for failed items, after confirmation). */
  async discard(id: string): Promise<void> {
    await this.deps.store.delete(id);
    await this.refreshStats();
  }
}
