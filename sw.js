const CACHE_NAME = "zeiklijst-v12";
const FIREBASE_SDK = "12.6.0";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./shared.js",
  "./firebase-init.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
  "./fonts/rubik-dirt.woff2",
  "./fonts/protest-guerrilla.woff2",
  "./fonts/rubik-distressed.woff2",
  "./fonts/zeiklijst-display.css",
  "./logo.png",
  "./logo.svg",
  `https://www.gstatic.com/firebasejs/${FIREBASE_SDK}/firebase-app.js`,
  `https://www.gstatic.com/firebasejs/${FIREBASE_SDK}/firebase-auth.js`,
  `https://www.gstatic.com/firebasejs/${FIREBASE_SDK}/firebase-firestore.js`
];
const FONT_HOSTS = new Set(["fonts.googleapis.com", "fonts.gstatic.com"]);

function isFirebaseSdk(url) {
  return url.hostname === "www.gstatic.com" && url.pathname.startsWith("/firebasejs/");
}

function isAdminPath(url) {
  return url.pathname.includes("/admin/");
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
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
