"use client";

import { signOut } from "@/app/actions/auth";

/** Clears pages cached by the service worker before signing out, so the next user never sees them. */
export function SignOutButton({ className = "btn btn-secondary" }: { className?: string }) {
  async function clearCachedPages() {
    if (!("caches" in window)) return;
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith("pages-")).map((k) => caches.delete(k)));
  }

  return (
    <form
      action={async () => {
        await clearCachedPages();
        await signOut();
      }}
    >
      <button type="submit" className={className}>
        Sign out
      </button>
    </form>
  );
}
