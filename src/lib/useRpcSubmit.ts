"use client";

import { useCallback, useRef, useState } from "react";
import { newId } from "@/lib/ids";
import { isDefinitiveFailure } from "@/lib/sale";
import { createClient } from "@/lib/supabase/client";

export type SubmitPhase =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "unconfirmed"; message: string }
  | { kind: "error"; message: string };

/**
 * Calls an idempotent RPC whose first argument is a client-generated document id.
 * The id is kept across retries until the server gives a definite answer, so a retry
 * after a dropped connection can never create a second document.
 */
export function useRpcSubmit<TResult>(fn: string, idParam: string) {
  const [phase, setPhase] = useState<SubmitPhase>({ kind: "idle" });
  const docId = useRef<string | null>(null);
  const occurredAt = useRef<string | null>(null);

  const reset = useCallback(() => {
    docId.current = null;
    occurredAt.current = null;
    setPhase({ kind: "idle" });
  }, []);

  const submit = useCallback(
    async (args: Record<string, unknown>, opts: { withOccurredAt?: boolean } = {}): Promise<TResult | null> => {
      docId.current ??= newId();
      occurredAt.current ??= new Date().toISOString();
      setPhase({ kind: "sending" });

      const { data, error } = await createClient().rpc(fn, {
        [idParam]: docId.current,
        ...args,
        ...(opts.withOccurredAt ? { p_occurred_at: occurredAt.current } : {}),
      });
      if (error) {
        if (isDefinitiveFailure(error)) {
          docId.current = null;
          occurredAt.current = null;
          setPhase({ kind: "error", message: error.message });
        } else {
          setPhase({
            kind: "unconfirmed",
            message: navigator.onLine ? "No reply from the server." : "No internet connection.",
          });
        }
        return null;
      }
      docId.current = null;
      occurredAt.current = null;
      setPhase({ kind: "idle" });
      return data as TResult;
    },
    [fn, idParam],
  );

  return {
    phase,
    submit,
    reset,
    clearError: () => setPhase((p) => (p.kind === "error" ? { kind: "idle" } : p)),
    locked: phase.kind === "sending" || phase.kind === "unconfirmed",
  };
}
