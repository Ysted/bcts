// Cache-first service worker: after one online visit the app runs fully offline.
// Bump CACHE on every deploy so phones pick up the new files.
const CACHE = "bcts-v9";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./logic.js",
  "./scanner.js",
  "./alarm.js",
  "./manifest.json",
  "./vendor/zxing-0.23.0.min.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  // cache: "reload" bypasses the HTTP cache (GitHub Pages serves max-age=600),
  // so a new version never gets stored with stale files from the previous one.
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(ASSETS.map((url) => new Request(url, { cache: "reload" }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then((cached) => {
      if (cached) return cached;
      return fetch(request).catch(() =>
        request.mode === "navigate" ? caches.match("./index.html") : Response.error(),
      );
    }),
  );
});
