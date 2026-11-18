const CACHE_NAME = "zeiklijst-admin-v15";
const FIREBASE_SDK = "12.6.0";
const ASSETS = [
  "./",
  "./index.html",
  "./admin.js",
  "./admin.css",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
  "../styles.css",
  "../shared.js",
  "../firebase-init.js",
  "../fonts/rubik-dirt.woff2",
  "../icons/icon-192.png",
  `https://www.gstatic.com/firebasejs/${FIREBASE_SDK}/firebase-app.js`,
  `https://www.gstatic.com/firebasejs/${FIREBASE_SDK}/firebase-auth.js`,
  `https://www.gstatic.com/firebasejs/${FIREBASE_SDK}/firebase-firestore.js`
];

function isFirebaseSdk(url) {
  return url.hostname === "www.gstatic.com" && url.pathname.startsWith("/firebasejs/");
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME && key.startsWith("zeiklijst-admin-")).map((key) => caches.delete(key)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  if (isFirebaseSdk(url)) {
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
