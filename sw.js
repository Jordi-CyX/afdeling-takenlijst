importScripts("./app-version.js");
const CACHE_NAME = self.APP_CACHE_NAME || "zeiklijst-v17";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app-version.js",
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
  "./logo.svg"
];

function isAdminPath(url) {
  return url.pathname.includes("/admin/");
}

function isHtmlNavigation(request, url) {
  if (request.mode === "navigate") return true;
  const path = url.pathname;
  return path.endsWith("/") || path.endsWith("/index.html");
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  // Do not control or cache the Admin PWA.
  if (isAdminPath(url)) return;

  if (url.origin !== self.location.origin) return;

  // Always take index.html / navigations from the network so phones
  // do not keep serving the old app from cache during maintenance.
  if (isHtmlNavigation(request, url)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        const response = await fetch(request, { cache: "no-cache" });
        if (response && response.ok) cache.put(request, response.clone());
        return response;
      } catch {
        const cached = await cache.match(request, { ignoreSearch: true });
        if (cached) return cached;
        const fallback = await cache.match("./index.html");
        if (fallback) return fallback;
        throw new Error("Offline and not cached");
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      const response = await fetch(request);
      if (response && response.ok) cache.put(request, response.clone());
      return response;
    } catch {
      const cached = await cache.match(request, { ignoreSearch: true });
      if (cached) return cached;
      throw new Error("Offline and not cached");
    }
  })());
});
