// Keeps the app working when the store's internet drops.
// Bump VERSION whenever you upload changed files so devices pick them up.
const VERSION = "sm-shifts-v5";
const SHELL = ["./", "index.html", "app.css", "app.js", "config.js", "manifest.webmanifest",
  "icon-192.png", "icon-512.png", "apple-touch-icon.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  // Never cache the Google Sheet connection.
  if (/google(usercontent)?\.com$/.test(url.hostname)) return;
  if (/(^|\.)jsdelivr\.net$/.test(url.hostname)) {
    // Barcode reader library: cache after the first download.
    e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); }
      return res;
    })));
    return;
  }
  if (url.origin !== self.location.origin) return;
  // App files: try the network first so updates show up, fall back to the saved copy offline.
  e.respondWith(fetch(e.request).then(res => {
    const copy = res.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); return res;
  }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(hit => hit || caches.match("index.html"))));
});
