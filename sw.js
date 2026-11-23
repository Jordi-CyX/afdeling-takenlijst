// Versioned URL so an HTTP-cached app-version.js can never give a new worker the old cache name.
importScripts("./app-version.js?v=21");
const CACHE_NAME = self.APP_CACHE_NAME || "zeiklijst-v21";
const FIREBASE_SDK = "12.6.0";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./app-version.js",
  "./task-order.js",
  "./staff-auth.js",
  "./limits.js",
  "./shared.js",
  "./firebase-init.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
  "./icons/icon-maskable-192.png",
  "./icons/icon-maskable-512.png",
  "./icons/favicon-32.png",
  "./favicon.ico",
  "./fonts/rubik-dirt.woff2",
  "./fonts/protest-guerrilla.woff2",
  "./fonts/rubik-distressed.woff2",
  "./fonts/zeiklijst-display.css",
  "./logo.png",
  "./logo.svg",
  // L7: the Firebase SDK is vendored (see the import map in index.html).
  `./vendor/firebase/${FIREBASE_SDK}/firebase-app.js`,
  `./vendor/firebase/${FIREBASE_SDK}/firebase-auth.js`,
  `./vendor/firebase/${FIREBASE_SDK}/firebase-firestore.js`
];
const FONT_HOSTS = new Set(["fonts.googleapis.com", "fonts.gstatic.com"]);

function isFirebaseSdk(url) {
  return url.hostname === "www.gstatic.com" && url.pathname.startsWith("/firebasejs/");
}

function isAdminPath(url) {
  return url.pathname.includes("/admin/");
}

// Do not skipWaiting on install: the page activates a waiting worker with
// SKIP_WAITING when the user is idle (or taps the update banner). The
// maintenance screen (maintenance.js) also sends SKIP_WAITING, so v20
// takes over from zeiklijst-v19-onderhoud by itself.
self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(ASSETS);
  })());
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      // Only remove old ZL caches; leave the admin app's caches alone.
      Promise.all(keys
        .filter((key) => key.startsWith("zeiklijst-v") && key !== CACHE_NAME)
        .map((key) => caches.delete(key)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  // Do not control or cache the Admin PWA.
  if (isAdminPath(url)) return;

  if (isFirebaseSdk(url) || FONT_HOSTS.has(url.hostname)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(request);
      try {
        const response = await fetch(request);
        if (response && response.ok) cache.put(request, response.clone());
        return response;
      } catch (err) {
        if (cached) return cached;
        throw err;
      }
    })());
    return;
  }

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
