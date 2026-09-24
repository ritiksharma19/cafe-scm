/*
 * Cafe SCM service worker.
 * - Static build assets: cache-first (they are content-hashed).
 * - Page navigations: network-first, falling back to the saved copy of that page
 *   (worker screens fall back to the Sell screen), then /offline.
 * - "warm-pages" message: the worker layout asks us to refresh saved copies of the
 *   worker screens while online, so they open later without signal.
 * - Supabase API calls are never cached here. Offline writes go through the app's
 *   IndexedDB outbox and are synced with idempotent ids.
 */
const VERSION = "v2";
const STATIC_CACHE = "static-" + VERSION;
const PAGE_CACHE = "pages-" + VERSION;
const PRECACHE = ["/offline", "/manifest.webmanifest", "/pwa-icon/192", "/pwa-icon/512"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.endsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function savePage(request, response) {
  // Only real pages: not redirects (e.g. to /login) and not errors.
  if (response.ok && !response.redirected && response.type === "basic") {
    const copy = response.clone();
    caches.open(PAGE_CACHE).then((c) => c.put(request, copy));
  }
  return response;
}

// A saved page only works offline if its scripts/styles are saved too.
async function saveAssetsOf(html) {
  const assets = [...new Set(html.match(/\/_next\/static\/[^"'\s)\\]+/g) || [])];
  const cache = await caches.open(STATIC_CACHE);
  await Promise.all(
    assets.map(async (a) => {
      if (await cache.match(a)) return;
      try {
        const res = await fetch(a);
        if (res.ok) await cache.put(a, res);
      } catch {
        // Next warm-up will try again.
      }
    }),
  );
}

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type !== "warm-pages" || !Array.isArray(data.urls)) return;
  event.waitUntil(
    Promise.all(
      data.urls
        .filter((u) => typeof u === "string" && u.startsWith("/worker"))
        .map((u) =>
          fetch(u, { credentials: "same-origin", redirect: "follow" })
            .then(async (res) => {
              savePage(new Request(u), res);
              if (res.ok && !res.redirected) await saveAssetsOf(await res.clone().text());
            })
            .catch(() => undefined),
        ),
    ),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/pwa-icon/")) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ||
          fetch(request).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(STATIC_CACHE).then((c) => c.put(request, copy));
            }
            return res;
          }),
      ),
    );
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((res) => savePage(new Request(url.pathname), res))
        .catch(async () => {
          const exact = await caches.match(url.pathname, { ignoreSearch: true });
          if (exact) return exact;
          if (url.pathname.startsWith("/worker")) {
            const sell = await caches.match("/worker");
            if (sell) return sell;
          }
          return caches.match("/offline");
        }),
    );
  }
});
