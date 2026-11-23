importScripts("./version.js"); // één bron voor de versie (ook het label in de app)
const CACHE_NAME = `zeiklijst-admin-v${self.ZEIKLIJST_ADMIN_VERSION}`;
const FIREBASE_SDK = "12.6.0";
const ASSETS = [
  "./",
  "./index.html",
  "./admin.js",
  "./v2.js",
  "./audit-defaults.js",
  "./version.js",
  "./xlsx-export.js",
  "./update-guard.js",
  "./v3a.js",
  "./v3a-logic.js",
  "./v3b.js",
  "./v3b-logic.js",
  "./v3c.js",
  "./v3c-logic.js",
  "./admin.css",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
  "./icons/icon-maskable-192.png",
  "./icons/icon-maskable-512.png",
  "./icons/favicon-32.png",
  "./icons/favicon-16.png",
  "./favicon.ico",
  "../styles.css",
  "../shared.js",
  "../firebase-init.js",
  "../fonts/rubik-dirt.woff2",
  "../icons/icon-192.png",
  `../vendor/firebase/${FIREBASE_SDK}/firebase-app.js`,
  `../vendor/firebase/${FIREBASE_SDK}/firebase-auth.js`,
  `../vendor/firebase/${FIREBASE_SDK}/firebase-firestore.js`
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
});

// Auto-verversen: GEEN automatische skipWaiting bij install; de pagina stuurt SKIP_WAITING als de gebruiker niet bezig is.
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      // Alleen eigen caches ("zeiklijst-admin-"), nooit die van de staff-app ("zeiklijst-v*").
      Promise.all(keys.filter((key) => key !== CACHE_NAME && key.startsWith("zeiklijst-admin-")).map((key) => caches.delete(key)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      const response = await fetch(request);
      if (response && response.ok) cache.put(request, response.clone());
      return response;
    } catch {
      const cached = await cache.match(request, { ignoreSearch: true });
      if (cached) return cached;
      if (request.mode === "navigate") {
        const fallback = await cache.match("./index.html");
        if (fallback) return fallback;
      }
      throw new Error("Offline and not cached");
    }
  })());
});
