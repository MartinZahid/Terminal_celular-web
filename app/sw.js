'use strict';

const CACHE = 'tc-v5';
const SHELL = [
  '/app',
  '/app/app.css',
  '/app/app.js',
  '/app/pure.js',
  '/app/manifest.webmanifest',
  '/app/icons/icon-192.png',
  '/app/icons/icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/oc') || url.pathname.startsWith('/auth')) return;
  if (url.pathname === '/app' || url.pathname.startsWith('/app/')) {
    e.respondWith(
      fetch(e.request, { cache: 'no-store' })
        .then((res) => {
          // Solo cachear el shell conocido (no redirects, ni errores, ni rutas inexistentes).
          if (res.ok && res.status === 200 && !res.redirected && SHELL.includes(url.pathname)) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
          }
          return res;
        })
        .catch(() => caches.match(e.request).then((r) => r || caches.match('/app')))
    );
  }
});
