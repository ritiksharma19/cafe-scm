"use client";

import { useEffect } from "react";
import { startOutboxSync } from "@/lib/offline/client";

// Worker screens kept on the phone so they open without signal.
const WORKER_PAGES = [
  "/worker",
  "/worker/receive",
  "/worker/waste",
  "/worker/stock",
  "/worker/more",
  "/worker/activity",
  "/worker/sync",
];

/**
 * Mounted in the worker layout:
 *  1. starts the outbox sync loop;
 *  2. while online, asks the service worker to refresh its copies of the worker
 *     screens (products, materials and the cart name are inside those pages).
 */
export function OfflineBoot() {
  useEffect(() => {
    startOutboxSync();

    const warm = () => {
      if (!navigator.onLine || !navigator.serviceWorker?.controller) return;
      navigator.serviceWorker.controller.postMessage({ type: "warm-pages", urls: WORKER_PAGES });
    };
    const t = setTimeout(warm, 3000); // after the current page has settled
    window.addEventListener("online", warm);
    navigator.serviceWorker?.addEventListener("controllerchange", warm);

    // Offline, in-app navigation would fetch server data and fail. Turn link clicks into
    // full page loads instead, which the service worker answers from its saved copies.
    const onClick = (e: MouseEvent) => {
      if (navigator.onLine || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]");
      const href = a?.getAttribute("href");
      if (!href || !href.startsWith("/worker")) return;
      e.preventDefault();
      e.stopPropagation();
      window.location.assign(href);
    };
    window.addEventListener("click", onClick, true);

    return () => {
      clearTimeout(t);
      window.removeEventListener("online", warm);
      window.removeEventListener("click", onClick, true);
      navigator.serviceWorker?.removeEventListener("controllerchange", warm);
    };
  }, []);
  return null;
}
