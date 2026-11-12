/* Match Center service worker: lets a match page that was opened once keep working without a connection
   (a booth with bad wifi). It never serves old content while the network works:
     - pages (*.html) and data (data/*.json): network first, the cached copy only when the network fails;
     - app/*.js|css loaded with ?v=<content hash> (see scripts/stamp-assets.mjs): cache first, the URL changes
       whenever the file does, so a cached copy is never out of date;
     - images (team crests, player photos, same origin or not): cache first, refreshed in the background.
   Everything else (Supabase calls, POSTs, URLs with a cache-busting "_" parameter) is left to the browser. */
var VERSION = 'mc-sw-1';
var PAGES = VERSION + '-pages', ASSETS = VERSION + '-assets', DATA = VERSION + '-data', IMGS = VERSION + '-img';
var MAX_IMGS = 400;

self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf(VERSION) !== 0; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function networkFirst(req, cacheName, key) {
  return fetch(req).then(function (res) {
    if (res && res.ok && !res.redirected) { var copy = res.clone(); caches.open(cacheName).then(function (c) { c.put(key || req, copy); }); }
    return res;
  }).catch(function () {
    return caches.open(cacheName).then(function (c) { return c.match(key || req, { ignoreSearch: !!key }); }).then(function (hit) {
      return hit || Response.error();
    });
  });
}

function cacheFirst(req, cacheName) {
  return caches.open(cacheName).then(function (c) {
    return c.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        if (res && res.ok) c.put(req, res.clone());
        return res;
      });
    });
  });
}

function imageCache(req) {
  return caches.open(IMGS).then(function (c) {
    return c.match(req).then(function (hit) {
      var net = fetch(req).then(function (res) {
        if (res && (res.ok || res.type === 'opaque')) {
          c.put(req, res.clone()).then(function () { return c.keys(); }).then(function (keys) {
            if (keys.length > MAX_IMGS) c.delete(keys[0]);
          });
        }
        return res;
      }).catch(function () { return hit || Response.error(); });
      return hit || net;
    });
  });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin === self.location.origin) {
    if (url.searchParams.has('_')) return;
    var path = url.pathname;
    if (/\/app\/[^/]+\.(js|css)$/.test(path) && url.searchParams.has('v')) { e.respondWith(cacheFirst(req, ASSETS)); return; }
    if (req.mode === 'navigate' || /\.html$/.test(path) || /\/$/.test(path)) {
      // match.html?m=<slug> is the same document for every slug: one cached copy per page
      e.respondWith(networkFirst(req, PAGES, new Request(url.origin + url.pathname)));
      return;
    }
    if (/\/data\/.+\.json$/.test(path)) { e.respondWith(networkFirst(req, DATA)); return; }
    if (/\.(png|jpe?g|svg|webp|gif|ico|woff2?)$/.test(path)) { e.respondWith(imageCache(req)); return; }
    return;
  }
  if (req.destination === 'image') e.respondWith(imageCache(req));
});
