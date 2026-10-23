// Offline support. Online: always fetch the latest files (revalidated, bypassing the browser's
// 10-minute HTTP cache) so a new version shows on the next open. Offline: serve the saved copy.
// Firebase traffic is not intercepted (Firestore has its own offline cache).
const CACHE = 'expense-tracker-v20';
const SHELL = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest', 'icon.svg',
  'js/app.js', 'js/store.js', 'js/model.js', 'js/money.js', 'js/calc.js', 'js/analytics.js', 'js/backup.js', 'js/firebase-config.js',
];

self.addEventListener('install', (event) => {
  // cache: 'reload' skips the browser's HTTP cache, so a new version never stores old files.
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
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
      try {
        // 'no-cache' asks the server whether the file changed (cheap when it hasn't).
        // Fetch by URL: page navigations can't be re-issued with new options.
        const res = await fetch(event.request.url, { cache: 'no-cache', credentials: 'same-origin' });
        if (res.ok) cache.put(event.request, res.clone());
        return res;
      } catch {
        const cached = await cache.match(event.request, { ignoreSearch: true });
        return cached ?? Response.error();
      }
    }),
  );
});
