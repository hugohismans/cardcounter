// Service worker : met l'appli et le modèle en cache pour un usage 100 % hors ligne.
const CACHE = 'cardcounter-v4';
const FILES = [
  './', 'index.html', 'style.css', 'manifest.webmanifest',
  'icons/logo.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-192.png', 'icons/maskable-512.png',
  'icons/apple-touch-icon.png', 'icons/favicon-32.png',
  'src/main.js', 'src/cards.js', 'src/scoring.js', 'src/detector.js', 'src/game.js',
  'model/cards.onnx', 'model/meta.json',
  'vendor/ort/ort.wasm.min.mjs', 'vendor/ort/ort-wasm-simd-threaded.mjs', 'vendor/ort/ort-wasm-simd-threaded.wasm',
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// réseau d'abord (pour récupérer les mises à jour), cache si hors ligne
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});
