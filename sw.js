/* GoWatch service worker.
   - own assets: cache-first (precached on install; bump CACHE_VERSION on every release)
   - OpenCV.js (docs.opencv.org): network-first with a short timeout, falling back to the cached copy
   - everything else (OGS API, OAuth): never touched, goes straight to the network
   All paths are relative so the app works under https://<user>.github.io/gowatch/ */
const CACHE_VERSION = 'gowatch-v1';
const OPENCV_CACHE = 'gowatch-opencv-v1';
const ASSETS = [
  './', './index.html', './callback.html', './manifest.json', './css/style.css',
  './js/app.js', './js/camera.js', './js/config.js', './js/game.js', './js/ogs.js', './js/tracker.js', './js/ui.js', './js/vision.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE_VERSION).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION && k !== OPENCV_CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET') return;
  if (url.hostname === 'docs.opencv.org') { e.respondWith(networkFirst(req)); return; }
  if (url.origin !== self.location.origin) return;
  if (url.pathname.endsWith('/callback.html') && url.search) return; // OAuth redirect: always fresh
  e.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE_VERSION).then((c) => c.put(req, copy)); }
    return res;
  })));
});

async function networkFirst(req) {
  const cache = await caches.open(OPENCV_CACHE);
  try {
    const res = await Promise.race([fetch(req), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 6000))]);
    if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req);
    if (hit) return hit;
    throw err;
  }
}
