/**
 * Service worker: cache-first for the app shell so the phone can relaunch the
 * display even if the server is briefly unreachable. Network data (WS, /api/*)
 * is never cached — only the static assets.
 */
const CACHE = "tokenflare-shell-v1";
const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon.svg",
  "./styles/base.css",
  "./styles/themes.css",
  "./styles/components.css",
  "./js/app.js",
  "./js/client.js",
  "./js/render.js",
  "./js/settings.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // Never cache API or WS traffic.
  if (url.pathname.startsWith("/api/") || url.protocol === "ws:" || url.protocol === "wss:") return;
  // Don't cache cross-origin (e.g. Google Fonts) — let the browser handle it.
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.status === 200 && res.type === "basic") {
            const clone = res.clone();
            caches.open(CACHE).then((c) => c.put(req, clone)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
