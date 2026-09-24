"use client";

import { useCallback, useEffect, useState } from "react";
import { formatDateTime } from "@/lib/format";
import { getOutbox, useOutboxStats } from "@/lib/offline/client";
import type { OutboxItem } from "@/lib/offline/types";
import { createClient } from "@/lib/supabase/client";

const KIND_LABEL = { sale: "Sale", receipt: "Stock received", wastage: "Wastage" } as const;
const STALE_MS = 48 * 60 * 60 * 1000;

export function SyncList() {
  const stats = useOutboxStats();
  const [items, setItems] = useState<OutboxItem[] | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [nowMs] = useState(() => Date.now());

  const load = useCallback(async () => {
    const { data } = await createClient().auth.getSession();
    const me = data.session?.user.id;
    setItems((await getOutbox().items()).filter((i) => i.userId === me));
  }, []);

  // Reload whenever the counts change (an item synced, failed or was added).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- IndexedDB is only readable on the client
    void load();
  }, [load, stats.pending, stats.failed, stats.syncing]);

  async function syncNow() {
    setBusy(true);
    await getOutbox().sync();
    setBusy(false);
  }

  if (items === null) return <p className="text-muted">Loading…</p>;
  if (items.length === 0) {
    return <p className="card p-5 font-semibold text-ok">✓ Everything is synced.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      <button type="button" onClick={syncNow} disabled={busy || stats.syncing} className="btn btn-primary">
        {busy || stats.syncing ? "Syncing…" : "Sync now"}
      </button>
      <ul className="flex flex-col gap-2">
        {items.map((i) => {
          const stale = nowMs - new Date(i.createdAt).getTime() > STALE_MS;
          return (
            <li key={i.id} className={`card flex flex-col gap-2 p-4 ${i.status === "failed" ? "border-danger/50" : ""}`}>
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-bold uppercase text-muted">{KIND_LABEL[i.kind]}</span>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-bold ${
                    i.status === "failed" ? "bg-danger/10 text-danger" : "bg-warn/10 text-warn"
                  }`}
                >
                  {i.status === "failed" ? "FAILED" : "WAITING"}
                </span>
              </div>
              <p className="font-medium">{i.summary}</p>
              <p className="text-xs text-muted">
                Recorded {formatDateTime(i.createdAt)}
                {i.attempts > 0 && ` · ${i.attempts} attempt${i.attempts === 1 ? "" : "s"}`}
              </p>
              {stale && i.status === "pending" && (
                <p className="text-xs font-semibold text-warn">
                  Older than 2 days — connect soon. After 3 days it is recorded with the time it syncs.
                </p>
              )}
              {i.status === "failed" && (
                <>
                  <p className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">The server refused this: {i.lastError}</p>
                  {confirming === i.id ? (
                    <div className="flex flex-col gap-2">
                      <p className="text-sm font-semibold">Remove it from this phone for good? Tell the owner what it was.</p>
                      <div className="flex gap-2">
                        <button type="button" onClick={() => setConfirming(null)} className="btn btn-secondary flex-1">
                          Keep
                        </button>
                        <button
                          type="button"
                          onClick={async () => {
                            await getOutbox().discard(i.id);
                            setConfirming(null);
                          }}
                          className="btn btn-secondary flex-1 text-danger"
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      <button type="button" onClick={() => getOutbox().retry(i.id)} className="btn btn-secondary flex-1">
                        Try again
                      </button>
                      <button type="button" onClick={() => setConfirming(i.id)} className="btn btn-secondary flex-1 text-danger">
                        Remove…
                      </button>
                    </div>
                  )}
                </>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
