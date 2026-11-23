// Service Worker: offline gyorsítótár + Web Push értesítések.
// Módosítás után emeld a verziót, hogy a kliensek frissüljenek.
const VERSION = 'v1.6.1';
const CACHE = `csaladi-naptar-${VERSION}`;

const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './css/app.css',
  './js/app.js',
  './js/db.js',
  './js/push.js',
  './js/logic.js',
  './js/config.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './icons/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Supabase API-t sosem cache-eljük (az app maga kezeli az offline cache-t).
  if (url.hostname.endsWith('supabase.co') || url.hostname.endsWith('supabase.in')) return;

  // Saját fájlok: network-first (friss tartalom), offline esetén cache.
  // cache: 'no-cache' → a böngésző HTTP-cache-ét is megkerüli (a GitHub Pages 10 percig
  // cache-elhetőnek jelöli a fájlokat), így egy új verzió azonnal megjelenik.
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' })
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req, { ignoreSearch: true })
          .then((r) => r || caches.match('./index.html'))),
    );
    return;
  }

  // CDN (Tailwind, supabase-js): cache-first, mert verziózott URL-ek.
  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req).then((res) => {
      if (res.ok || res.type === 'opaque') {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    })),
  );
});

// ---------------------------------------------------------------------------
// Web Push
// ---------------------------------------------------------------------------

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }

  const title = data.title || 'Családi Naptár';
  const options = {
    body: data.body || 'Nézd meg a mai teendőket!',
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    tag: data.tag || 'napi-osszefoglalo',
    renotify: true,
    data: { url: data.url || './', day: data.day || null },
  };

  // iOS-en minden push-hoz KÖTELEZŐ értesítést megjeleníteni, különben a rendszer visszavonja az engedélyt.
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { url, day } = event.notification.data || {};
  const target = new URL(url || './', self.registration.scope).href;

  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of all) {
      if (client.url.startsWith(self.registration.scope)) {
        await client.focus();
        if (day) client.postMessage({ type: 'open-day', day });
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});

// Ha a böngésző lejártatja a feliratkozást, próbáljunk újra feliratkozni.
self.addEventListener('pushsubscriptionchange', (event) => {
  // A régi feliratkozást a napi script automatikusan törli (410 Gone),
  // a felhasználónak a Beállításokban újra be kell kapcsolnia.
  console.log('pushsubscriptionchange', event);
});
