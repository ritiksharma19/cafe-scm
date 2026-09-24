"use client";

import { useCallback, useState } from "react";
import { newId } from "@/lib/ids";
import { createClient } from "@/lib/supabase/client";
import { getOutbox } from "./client";
import type { DocKind, SubmitOutcome } from "./types";

export type OutboxPhase = { kind: "idle" } | { kind: "sending" } | { kind: "error"; message: string };

/**
 * Submits a worker document through the offline outbox. The document is saved on
 * the phone before any network call, so the only outcomes are:
 *  synced (server has it) · queued (safe on the phone, syncs later) · rejected (fix and resend).
 */
export function useOutboxSubmit(kind: DocKind, fn: string, idParam: string) {
  const [phase, setPhase] = useState<OutboxPhase>({ kind: "idle" });

  const submit = useCallback(
    async (args: Record<string, unknown>, summary: string): Promise<Exclude<SubmitOutcome, { outcome: "rejected" }> | null> => {
      setPhase({ kind: "sending" });
      const { data } = await createClient().auth.getSession();
      const userId = data.session?.user.id;
      if (!userId) {
        setPhase({ kind: "error", message: "You are signed out. Sign in again to record this." });
        return null;
      }
      const id = newId();
      try {
        const result = await getOutbox().submit({
          id,
          userId,
          kind,
          fn,
          summary,
          args: { [idParam]: id, ...args, p_occurred_at: new Date().toISOString() },
        });
        if (result.outcome === "rejected") {
          setPhase({ kind: "error", message: result.message });
          return null;
        }
        setPhase({ kind: "idle" });
        return result;
      } catch (e) {
        // Could not even save on the phone (storage blocked / full).
        setPhase({ kind: "error", message: `Could not save on this phone: ${(e as Error).message}` });
        return null;
      }
    },
    [kind, fn, idParam],
  );

  return { phase, submit, clearError: () => setPhase({ kind: "idle" }), busy: phase.kind === "sending" };
}
