const CACHE_NAME = 'pos-v1';
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
    event.respondWith(networkFirstWithCacheFallback(event.request));
    return;
  }
  event.respondWith(
    caches.match(event.request).then((response) => response || fetch(event.request))
  );
});

async function networkFirstWithCacheFallback(request) {
  const networkTimeout = (ms, req) => new Promise((resolve) => 
    setTimeout(() => resolve(null), ms).then(() => fetch(req).catch(() => null))
  );
  
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
    
    const timeoutResponse = await networkTimeout(3000, request);
    return timeoutResponse || new Response(JSON.stringify({ offline: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
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