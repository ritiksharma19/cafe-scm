"use client";

import { useState } from "react";
import { signOut } from "@/app/actions/auth";
import { getOutbox } from "@/lib/offline/client";

/**
 * Clears pages saved by the service worker before signing out, so the next user never
 * sees them. With `checkOutbox`, warns first if this user still has unsynced items on
 * the phone (they can only be sent after the same person signs in again).
 */
export function SignOutButton({ className = "btn btn-secondary", checkOutbox = false }: { className?: string; checkOutbox?: boolean }) {
  const [unsynced, setUnsynced] = useState<number | null>(null);

  async function clearCachedPages() {
    if (!("caches" in window)) return;
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith("pages-")).map((k) => caches.delete(k)));
  }

  async function doSignOut() {
    await clearCachedPages();
    await signOut();
  }

  async function onClick() {
    if (checkOutbox && unsynced === null) {
      const ob = getOutbox();
      await ob.sync().catch(() => undefined);
      const { pending, failed } = await ob.refreshStats();
      if (pending + failed > 0) {
        setUnsynced(pending + failed);
        return;
      }
    }
    await doSignOut();
  }

  if (unsynced !== null) {
    return (
      <div className="card flex flex-col gap-3 border-warn p-4">
        <p className="text-sm font-semibold text-warn">
          {unsynced} item{unsynced === 1 ? " is" : "s are"} not synced yet. They stay on this phone and are sent the next
          time you sign in with a connection.
        </p>
        <div className="flex gap-2">
          <button type="button" onClick={() => setUnsynced(null)} className="btn btn-primary flex-1">
            Stay signed in
          </button>
          <button type="button" onClick={doSignOut} className="btn btn-secondary flex-1">
            Sign out anyway
          </button>
        </div>
      </div>
    );
  }

  return (
    <button type="button" onClick={onClick} className={className}>
      Sign out
    </button>
  );
}
