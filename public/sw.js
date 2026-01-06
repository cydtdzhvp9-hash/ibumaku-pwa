/*
 * Minimal Service Worker for installable PWA experience.
 *
 * This app is online-only by design (位置情報取得などの都合で原則オンライン)。
 * We do NOT cache app data (version.json / spots / stations etc.).
 */

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Network-only: behave like normal browsing, but keeps SW present.
self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
