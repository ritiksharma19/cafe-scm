"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Outbox } from "./engine";
import { idbStore } from "./idb-store";
import type { OutboxStats } from "./types";

const RETRY_EVERY_MS = 30_000;

let outbox: Outbox | null = null;
let started = false;

/** The app-wide outbox (browser only). */
export function getOutbox(): Outbox {
  if (!outbox) {
    const supabase = createClient();
    outbox = new Outbox({
      store: idbStore,
      rpc: async (fn, args) => {
        const { data, error } = await supabase.rpc(fn, args);
        return { data, error: error ? { code: error.code, message: error.message } : null };
      },
      currentUserId: async () => {
        // Local session read (no network), so it also works offline.
        const { data } = await supabase.auth.getSession();
        return data.session?.user.id ?? null;
      },
      isOnline: () => navigator.onLine,
    });
  }
  return outbox;
}

/**
 * Starts background syncing: on load, when the connection returns, when the app is
 * brought back to the foreground, and every 30 s while items are waiting.
 * (iOS has no Background Sync, so the app syncs whenever it is open.)
 */
export function startOutboxSync(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  const ob = getOutbox();
  const kick = () => void ob.sync();
  window.addEventListener("online", kick);
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && kick());
  setInterval(() => {
    if (ob.getStats().pending > 0) kick();
  }, RETRY_EVERY_MS);
  void ob.refreshStats().then(kick);
}

export function useOutboxStats(): OutboxStats {
  const [stats, setStats] = useState<OutboxStats>({ pending: 0, failed: 0, syncing: false, oldestPendingAt: null });
  useEffect(() => getOutbox().subscribe(setStats), []);
  return stats;
}
