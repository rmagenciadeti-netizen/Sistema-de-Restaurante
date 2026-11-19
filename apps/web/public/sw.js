// RM Restaurant service worker. It only keeps the application shell available without connection (so the PDV can open and queue orders);
// business data from the API is never cached here — it is private, per restaurant and must always be fresh.
const VERSION = 'rm-v1';
const STATIC_CACHE = `rm-static-${VERSION}`;
const PAGE_CACHE = `rm-pages-${VERSION}`;
const OFFLINE_URL = '/offline.html';
const NAVIGATION_TIMEOUT_MS = 4000;

self.addEventListener('install', event => {
  event.waitUntil(caches.open(STATIC_CACHE).then(cache => cache.addAll([OFFLINE_URL, '/icons/icon-192.png', '/manifest.webmanifest'])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(names => Promise.all(names.filter(name => ![STATIC_CACHE, PAGE_CACHE].includes(name)).map(name => caches.delete(name)))).then(() => self.clients.claim()));
});

const isStaticAsset = url => url.pathname.startsWith('/_next/static/') || url.pathname.startsWith('/icons/') || /\.(?:woff2?|png|jpg|jpeg|svg|ico)$/.test(url.pathname);

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) (await caches.open(STATIC_CACHE)).put(request, response.clone());
  return response;
}

// Pages: the network wins when it answers in time; otherwise the last copy of that page, then the offline screen.
async function networkFirstPage(request) {
  const cache = await caches.open(PAGE_CACHE);
  try {
    const response = await Promise.race([fetch(request), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), NAVIGATION_TIMEOUT_MS))]);
    if (response.ok && response.type === 'basic') cache.put(request, response.clone());
    return response;
  } catch {
    return (await cache.match(request)) ?? (await caches.match(OFFLINE_URL)) ?? Response.error();
  }
}

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api-proxy/') || url.pathname.startsWith('/api/') || url.searchParams.has('_rsc')) return;
  if (request.mode === 'navigate') { event.respondWith(networkFirstPage(request)); return; }
  if (isStaticAsset(url)) event.respondWith(cacheFirst(request));
});
