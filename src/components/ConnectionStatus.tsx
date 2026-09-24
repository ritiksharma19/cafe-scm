"use client";

import { useSyncExternalStore } from "react";

function subscribe(callback: () => void) {
  window.addEventListener("online", callback);
  window.addEventListener("offline", callback);
  return () => {
    window.removeEventListener("online", callback);
    window.removeEventListener("offline", callback);
  };
}

/** ONLINE / OFFLINE pill. The pending-sync count is added with the offline outbox (Phase 6). */
export function ConnectionStatus() {
  const online = useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    () => true,
  );
  return (
    <span
      role="status"
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold tracking-wide ${
        online ? "bg-ok/10 text-ok" : "bg-danger/10 text-danger"
      }`}
    >
      <span aria-hidden className={`size-2 rounded-full ${online ? "bg-ok" : "bg-danger"}`} />
      {online ? "ONLINE" : "OFFLINE"}
    </span>
  );
}
