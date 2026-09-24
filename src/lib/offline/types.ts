/** Worker documents that can be recorded offline and synced later. */
export type DocKind = "sale" | "receipt" | "wastage";

export interface OutboxItem {
  /** The document id sent to the server — also the idempotency key. */
  id: string;
  /** Who recorded it. Only this user's session may send it. */
  userId: string;
  kind: DocKind;
  /** RPC name and its full arguments (including the id and p_occurred_at). */
  fn: string;
  args: Record<string, unknown>;
  /** Human text for the pending list, e.g. "Burger × 2, Fries × 1 · ₹320". */
  summary: string;
  createdAt: string;
  attempts: number;
  status: "pending" | "failed";
  lastError?: string;
  lastAttemptAt?: string;
}

export interface OutboxStore {
  all(): Promise<OutboxItem[]>;
  put(item: OutboxItem): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface RpcResult {
  data: unknown;
  error: { code?: string; message: string } | null;
}

export type Rpc = (fn: string, args: Record<string, unknown>) => Promise<RpcResult>;

export interface OutboxStats {
  pending: number;
  failed: number;
  syncing: boolean;
  oldestPendingAt: string | null;
}

export type SubmitOutcome =
  | { outcome: "synced"; data: unknown } // server confirmed (created or duplicate)
  | { outcome: "queued" } // safely stored on the phone; will sync later
  | { outcome: "rejected"; message: string }; // server refused it; nothing kept
