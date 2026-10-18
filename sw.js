// Offline app shell. Serves cached files instantly and refreshes them in the background.
// Firebase traffic is not intercepted (Firestore has its own offline cache).
const CACHE = 'expense-tracker-v11';
const SHELL = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest', 'icon.svg',
  'js/app.js', 'js/store.js', 'js/model.js', 'js/money.js', 'js/calc.js', 'js/analytics.js', 'js/backup.js', 'js/firebase-config.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin) return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(event.request, { ignoreSearch: true });
      const network = fetch(event.request)
        .then((res) => { if (res.ok) cache.put(event.request, res.clone()); return res; })
        .catch(() => cached);
      return cached ?? network;
    }),
  );
});
