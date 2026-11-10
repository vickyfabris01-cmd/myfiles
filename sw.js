// sw.js  -  MyFiles service worker (makes the site installable and lets the app shell open without a connection).
//
// WHAT IT DOES
//   * Pages, scripts, styles and icons from THIS site: network first (so a new deploy shows up straight away), cached copy when offline.
//   * Opening a page while offline shows the saved page; if there is none, a friendly offline page.
// WHAT IT NEVER DOES
//   * It never touches anything that is not on this site: the API (workers.dev), Supabase and the photo/video storage (R2) are not
//     intercepted, so no account data, file list or media is ever stored by this worker.
//   * It never saves private gallery pages (/e/...). Those are opened only when you are online.
//   * It does not queue uploads. Uploading needs a connection; the upload page says so.
// To force every device to drop its saved copies after a big change, bump VERSION.
const VERSION = 'v1';
const CACHE = `myfiles-${VERSION}`;
const PRECACHE = ['/offline.html', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/css/global.css'];
const NETWORK_TIMEOUT_MS = 4000;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(PRECACHE.map((u) => cache.add(u).catch(() => {}))); // one missing file must not stop the install
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('myfiles-') && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

// true when this worker must leave the request completely alone
function shouldBypass(request, selfOrigin) {
  if (request.method !== 'GET') return true;
  let u;
  try { u = new URL(request.url); } catch { return true; }
  if (u.origin !== selfOrigin) return true;                        // API, Supabase, R2 and other sites
  if (u.pathname === '/sw.js') return true;
  if (u.pathname.startsWith('/e/') || u.pathname === '/event.html') return true; // private gallery pages are never saved
  if (request.headers.has('range')) return true;                   // media range requests
  return false;
}

const isAsset = (path) => /\.(?:js|css|png|svg|ico|webmanifest|woff2?|jpg|jpeg|webp)$/i.test(path);

async function networkFirst(request, { navigation }) {
  const cache = await caches.open(CACHE);
  try {
    const res = await Promise.race([
      fetch(request),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), NETWORK_TIMEOUT_MS)),
    ]);
    if (res && res.status === 200 && res.type === 'basic') cache.put(request, res.clone()).catch(() => {});
    return res;
  } catch (err) {
    const hit = await cache.match(request, { ignoreSearch: navigation });
    if (hit) return hit;
    if (navigation) { const off = await cache.match('/offline.html'); if (off) return off; }
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (shouldBypass(request, self.location.origin)) return;
  const url = new URL(request.url);
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, { navigation: true }).catch(() => new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } })));
  } else if (isAsset(url.pathname)) {
    event.respondWith(networkFirst(request, { navigation: false }));
  }
});
