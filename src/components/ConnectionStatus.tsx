"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";
import { useOutboxStats } from "@/lib/offline/client";

function subscribe(callback: () => void) {
  window.addEventListener("online", callback);
  window.addEventListener("offline", callback);
  return () => {
    window.removeEventListener("online", callback);
    window.removeEventListener("offline", callback);
  };
}

function useOnline() {
  return useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    () => true,
  );
}

const TONE = {
  ok: "bg-ok/10 text-ok",
  warn: "bg-warn/10 text-warn",
  danger: "bg-danger/10 text-danger",
} as const;

function Pill({ tone, dot, children }: { tone: keyof typeof TONE; dot: string; children: React.ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold tracking-wide ${TONE[tone]}`}>
      <span aria-hidden className={`size-2 rounded-full ${dot}`} />
      {children}
    </span>
  );
}

/** ONLINE / OFFLINE pill. Admin screens: connection only. */
export function ConnectionStatus() {
  const online = useOnline();
  return (
    <span role="status">
      <Pill tone={online ? "ok" : "danger"} dot={online ? "bg-ok" : "bg-danger"}>
        {online ? "ONLINE" : "OFFLINE"}
      </Pill>
    </span>
  );
}

/**
 * Worker screens: connection + the phone's outbox.
 *   ONLINE · OFFLINE — 3 pending sync · Syncing 2… · ⚠ 1 failed
 * Tapping it (when anything is waiting) opens the sync screen.
 */
export function WorkerConnectionStatus() {
  const online = useOnline();
  const { pending, failed } = useOutboxStats();

  let pill: React.ReactNode;
  if (failed > 0) {
    pill = (
      <Pill tone="danger" dot="bg-danger">
        ⚠ {failed} FAILED{pending > 0 ? ` · ${pending} PENDING` : ""}
      </Pill>
    );
  } else if (!online) {
    pill = (
      <Pill tone="danger" dot="bg-danger">
        OFFLINE{pending > 0 ? ` — ${pending} PENDING SYNC` : ""}
      </Pill>
    );
  } else if (pending > 0) {
    pill = (
      <Pill tone="warn" dot="bg-warn animate-pulse">
        SYNCING {pending}…
      </Pill>
    );
  } else {
    pill = (
      <Pill tone="ok" dot="bg-ok">
        ONLINE
      </Pill>
    );
  }

  return pending + failed > 0 ? (
    <Link href="/worker/sync" role="status" aria-label="Open sync status">
      {pill}
    </Link>
  ) : (
    <span role="status">{pill}</span>
  );
}
