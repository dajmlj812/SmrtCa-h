/*
 * SmrtCash service worker (Phase 9.0 / 0.12.0).
 *
 * Strategy:
 *   - PRECACHE the bare app shell (index.html) on install so the SPA
 *     loads without a network round trip on subsequent visits.
 *   - For navigation requests: try network first, fall back to cached
 *     index.html. Keeps the user "online" when offline.
 *   - For built static assets (/assets/*): cache-first. Vite hashes
 *     filenames so a fresh build's bundle has a fresh name; the old
 *     cached bundles just rot until the runtime cache cap evicts them.
 *   - For /api/*: network-only. Financial data must never be served
 *     from a stale cache — better to fail visibly than to show a
 *     yesterday-balance.
 *   - For /manifest.webmanifest, /icons/*, /favicon.svg: cache-first.
 *
 * Bump CACHE_VERSION on every release whose static assets change so
 * the activate handler can purge older caches.
 */
const CACHE_VERSION = 'smrtcash-v0.17.8';
const APP_SHELL = ['/', '/index.html', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

function isApiRequest(url) {
  return url.pathname.startsWith('/api/');
}

function isStaticAsset(url) {
  return (
    url.pathname.startsWith('/assets/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname === '/manifest.webmanifest' ||
    url.pathname === '/favicon.svg' ||
    url.pathname === '/favicon.ico'
  );
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Service workers only handle GET; everything else passes through.
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Only handle same-origin requests. Plaid Link, fonts, etc. go
  // straight to the network without interception.
  if (url.origin !== self.location.origin) return;

  if (isApiRequest(url)) {
    // Hard pass — never cache API responses.
    return;
  }

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() =>
        caches.match('/index.html').then((r) => r || Response.error()),
      ),
    );
    return;
  }

  if (isStaticAsset(url)) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((res) => {
          // Only cache successful responses; opaque/error responses
          // would poison the cache.
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE_VERSION).then((c) => c.put(req, clone));
          }
          return res;
        });
      }),
    );
  }
});
