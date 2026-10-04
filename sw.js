// Service worker: cacher app-skallen så appen også åbner uden netværk,
// og tilføjer cross-origin-isolation-headers, så YOLO kan bruge flere CPU-tråde
// også på hosts der ikke selv kan sende dem (fx GitHub Pages).
const CACHE = 'racetrackstar-v4';
const SHELL = [
  './',
  'index.html',
  'app.css',
  'js/app.js',
  'js/store.js',
  'js/tracker.js',
  'js/cartracker.js',
  'js/yolo.js',
  'js/race.js',
  'manifest.webmanifest',
  'icons/icon.svg',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isolate(res) {
  if (!res || res.status === 0 || res.type === 'opaque') return res;
  const headers = new Headers(res.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // Netværk først (så opdateringer slår igennem), cache som offline-fallback.
  // YOLO-modellen og -motoren caches først når de faktisk hentes.
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
      }
      return isolate(res);
    }).catch(() => caches.match(e.request).then(isolate))
  );
});
