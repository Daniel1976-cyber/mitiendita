const CACHE_NAME = 'pos-v2';
const urlsToCache = [
  '/',
  '/index.html',
  '/css/styles.css',
  '/js/app.js',
  '/logo.jpg',
  '/manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(urlsToCache))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keyList) =>
      Promise.all(
        keyList.map((key) => (key !== CACHE_NAME ? caches.delete(key) : null))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirstApi(event.request));
    return;
  }
  // Archivos estáticos (html/js/css): siempre intenta traer la versión más
  // nueva primero; si no hay internet, recién ahí usa lo último cacheado.
  event.respondWith(networkFirstStatic(event.request));
});

async function networkFirstStatic(request) {
  try {
    const networkResponse = await fetch(request);
    if (networkResponse && networkResponse.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, networkResponse.clone());
      return networkResponse;
    }
    throw new Error('Respuesta de red no válida');
  } catch (e) {
    const cached = await caches.match(request);
    if (cached) return cached;
    throw e;
  }
}

async function networkFirstApi(request) {
  try {
    const networkResponse = await fetch(request);
    if (networkResponse.ok) {
      caches.open(CACHE_NAME).then((cache) => cache.put(request, networkResponse.clone()));
      return networkResponse;
    }
    throw new Error('Network response not ok');
  } catch (e) {
    const cached = await caches.match(request);
    if (cached) return cached;
    return new Response(JSON.stringify({ offline: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-facturas') {
    event.waitUntil(syncPendientes());
  }
});

async function syncPendientes() {
  const clientsList = await self.clients.matchAll();
  for (const client of clientsList) {
    client.postMessage({ type: 'sync-requested' });
  }
}