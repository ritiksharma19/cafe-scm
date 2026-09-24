"use client";

import { useRpcSubmit, type SubmitPhase } from "@/lib/useRpcSubmit";
import type { DocKind } from "./types";
import { useOutboxSubmit } from "./useOutboxSubmit";

export type DocSubmitResult<T> = { queued: false; data: T } | { queued: true; data: null };

/**
 * One submit API for stock forms:
 *  - offline: true  → through the phone's outbox (worker screens; works without signal)
 *  - offline: false → straight to the server (admin screens; online only)
 */
export function useDocSubmit<T>(kind: DocKind, fn: string, idParam: string, opts: { offline: boolean }) {
  const online = useRpcSubmit<T>(fn, idParam);
  const queue = useOutboxSubmit(kind, fn, idParam);

  if (!opts.offline) {
    return {
      phase: online.phase as SubmitPhase,
      locked: online.locked,
      reset: online.reset,
      // The summary is only needed for the phone's pending list.
      submit: async (args: Record<string, unknown>): Promise<DocSubmitResult<T> | null> => {
        const data = await online.submit(args, { withOccurredAt: true });
        return data ? { queued: false, data } : null;
      },
    };
  }
  return {
    phase: queue.phase as SubmitPhase,
    locked: queue.busy,
    reset: queue.clearError,
    submit: async (args: Record<string, unknown>, summary: string): Promise<DocSubmitResult<T> | null> => {
      const r = await queue.submit(args, summary);
      if (!r) return null;
      return r.outcome === "synced" ? { queued: false, data: r.data as T } : { queued: true, data: null };
    },
  };
}
