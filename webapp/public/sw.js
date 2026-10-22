// Hand-rolled service worker (no build-time PWA plugin/dependency) covering
// two things: an installable app shell, and offline access to the most
// recently-seen conversation history via GET /api/conversation. Everything
// else (the WebSocket, every other /api/ route) passes straight through —
// this is deliberately not a general offline-first cache.
const VERSION = "v2";
const APP_CACHE = `gatsby-app-${VERSION}`;
const CONVERSATION_CACHE = `gatsby-conversation-${VERSION}`;
const CACHE_NAMES = [APP_CACHE, CONVERSATION_CACHE];

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((name) => !CACHE_NAMES.includes(name)).map((name) => caches.delete(name))),
    ).then(() => self.clients.claim()),
  );
});

// Try the network first (conversation history should be as fresh as
// possible); fall back to the last cached copy for that exact URL when the
// network is unavailable, so recent conversations stay visible offline.
async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw err;
  }
}

// Serve the app shell/static assets from cache instantly when present, while
// refreshing the cache in the background — keeps the app launchable offline
// without ever blocking a normal, online load on a network round trip.
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      if (response && response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => cached);
  return cached || network;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname === "/api/conversation") {
    event.respondWith(networkFirst(request, CONVERSATION_CACHE));
    return;
  }

  if (url.pathname === "/" || url.pathname.startsWith("/assets/") || url.pathname === "/favicon.svg" || url.pathname === "/manifest.webmanifest") {
    event.respondWith(staleWhileRevalidate(request, APP_CACHE));
  }
});
