/* Service worker: app shell precache + stale-while-revalidate for API data.
   The IndexedDB price cache in store.js is the real offline story; this exists
   so the shell itself boots without a network. */

var SHELL_CACHE = 'apf-shell-v13';
var DATA_CACHE = 'apf-data-v13';

// Keep the ?v= stamps in sync with index.html — they are part of the cache key.
var BUILD = '13';
var SHELL = [
  './',
  './index.html',
  './css/styles.css?v=' + BUILD,
  './js/config.js?v=' + BUILD,
  './js/store.js?v=' + BUILD,
  './js/recipes-data.js?v=' + BUILD,
  './js/recipes.js?v=' + BUILD,
  './js/api.js?v=' + BUILD,
  './js/calc.js?v=' + BUILD,
  './js/ui.js?v=' + BUILD,
  './js/app.js?v=' + BUILD,
  './manifest.json'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(SHELL_CACHE)
      .then(function (c) { return c.addAll(SHELL); })
      .then(function () { return self.skipWaiting(); })
      .catch(function () { /* a missing shell file must not block install */ })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== SHELL_CACHE && k !== DATA_CACHE) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url = new URL(req.url);

  // Market data + item dumps: network first, fall back to the last good copy.
  if (/albion-online-data\.com|githubusercontent\.com|albiononline\.com/.test(url.hostname)) {
    e.respondWith(
      fetch(req).then(function (res) {
        if (res && res.ok) {
          var clone = res.clone();
          caches.open(DATA_CACHE).then(function (c) { c.put(req, clone); });
        }
        return res;
      }).catch(function () {
        return caches.match(req);
      })
    );
    return;
  }

  // App shell: network first, falling back to cache when offline.
  // Cache-first would be faster, but it strands users on a stale build until
  // the cache is manually cleared — the offline fallback is what matters here.
  if (url.origin === location.origin) {
    e.respondWith(
      fetch(req).then(function (res) {
        if (res && res.ok) {
          var clone = res.clone();
          caches.open(SHELL_CACHE).then(function (c) { c.put(req, clone); });
        }
        return res;
      }).catch(function () {
        return caches.match(req).then(function (hit) {
          return hit || caches.match('./index.html');
        });
      })
    );
  }
});
