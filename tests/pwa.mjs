// tests/pwa.mjs  -  PWA: manifest, icons and service-worker rules (what it caches, and what it must never touch):  node tests/pwa.mjs
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';
let pass = 0, fail = 0;
const check = (n, c) => { c ? pass++ : (fail++, console.log('FAIL', n)); if (c) console.log('PASS', n); };
const read = (p) => readFileSync(new URL('../' + p, import.meta.url));
const pngSize = (p) => { const b = read(p); return b.readUInt32BE(0) === 0x89504e47 ? [b.readUInt32BE(16), b.readUInt32BE(20)] : null; };

/* ---------- manifest + icons ---------- */
const m = JSON.parse(read('manifest.webmanifest').toString());
check('manifest has name, short_name, standalone display, start_url inside scope', m.name && m.short_name && m.display === 'standalone' && m.start_url.startsWith('/admin/') && m.scope === '/');
check('manifest has theme and background colours', /^#[0-9a-f]{6}$/i.test(m.theme_color) && /^#[0-9a-f]{6}$/i.test(m.background_color));
for (const i of m.icons) { const [w, h] = (i.sizes || '').split('x').map(Number); const real = existsSync(new URL('..' + i.src, import.meta.url)) && pngSize(i.src.slice(1)); check(`icon ${i.src} exists and really is ${i.sizes} (${i.purpose})`, !!real && real[0] === w && real[1] === h); }
check('there is a 192, a 512 and a maskable icon (installability)', m.icons.some((i) => i.sizes === '192x192') && m.icons.some((i) => i.sizes === '512x512' && i.purpose === 'any') && m.icons.some((i) => i.purpose === 'maskable'));
check('apple-touch-icon is 180x180', JSON.stringify(pngSize('icons/apple-touch-icon.png')) === '[180,180]');
check('every shortcut points at a page that exists', m.shortcuts.every((s) => existsSync(new URL('..' + s.url, import.meta.url))));
for (const f of ['index.html', 'admin/index.html', 'admin/events.html', 'admin/upload.html', 'admin/signup.html', 'admin/reset.html']) {
  const t = read(f).toString();
  check(`${f} links the manifest and a theme colour`, t.includes('rel="manifest"') && t.includes('name="theme-color"') && t.includes('apple-touch-icon'));
}
check('the private gallery page does NOT link the manifest (guests are not offered an install)', !read('event.html').toString().includes('rel="manifest"'));
const headers = read('_headers').toString();
check('headers: the service worker is never cached long, the manifest has the right type', /\/sw\.js\s+Cache-Control: no-cache/.test(headers) && /application\/manifest\+json/.test(headers));
check('CSP allows the worker and manifest (script-src and default-src are self)', /\/admin\/\*[\s\S]*?default-src 'self'; script-src 'self'/.test(headers));

/* ---------- service worker behaviour ---------- */
function boot(net) {
  const handlers = {}; const store = new Map(); const added = [];
  const cacheObj = (name) => { if (!store.has(name)) store.set(name, new Map()); const c = store.get(name);
    return { add: async (u) => { if (net.failAdd && net.failAdd.includes(u)) throw new Error('404'); added.push(u); c.set(u, new Response('x')); }, put: async (r, res) => { c.set(typeof r === 'string' ? r : new URL(r.url).pathname + new URL(r.url).search, res); }, match: async (r, o) => { const key = typeof r === 'string' ? r : new URL(r.url).pathname + new URL(r.url).search; if (c.has(key)) return c.get(key).clone(); if (o && o.ignoreSearch) { const p = new URL('https://site.test' + (typeof r === 'string' ? r : new URL(r.url).pathname)).pathname; for (const [k, v] of c) if (k.split('?')[0] === p) return v.clone(); } return undefined; } }; };
  const sandbox = {
    self: { addEventListener: (t, f) => { handlers[t] = f; }, location: { origin: 'https://site.test' }, skipWaiting: async () => {}, clients: { claim: async () => {} } },
    caches: { open: async (n) => cacheObj(n), keys: async () => [...store.keys()], delete: async (n) => store.delete(n) },
    fetch: async (req) => { net.calls.push(new URL(req.url).pathname); if (net.down) throw new TypeError('offline'); const res = net.respond ? net.respond(req) : new Response('net:' + new URL(req.url).pathname, { status: 200 }); Object.defineProperty(res, 'type', { value: 'basic' }); return res; }, // a same-site fetch is type 'basic' in browsers
    URL, Response, Request, Promise, setTimeout, clearTimeout, console,
  };
  vm.runInNewContext(readFileSync(new URL('../sw.js', import.meta.url), 'utf8'), sandbox);
  const fire = async (type, extra = {}) => { let p; const ev = { waitUntil: (x) => { p = x; }, respondWith: (x) => { ev.responded = true; p = x; }, ...extra }; handlers[type](ev); return { responded: !!ev.responded, result: p ? await p : undefined }; };
  return { fire, store, added, sandbox, handlers };
}
const req = (url, init = {}, mode = 'cors') => { const r = new Request(url, init); Object.defineProperty(r, 'mode', { value: mode }); return r; };

{
  const net = { calls: [], failAdd: ['/icons/icon-512.png'] }; const sw = boot(net);
  await sw.fire('install');
  check('install pre-caches the offline page and survives one missing file', sw.added.includes('/offline.html') && !sw.added.includes('/icons/icon-512.png'));
  (await sw.sandbox.caches.open('myfiles-v0')); (await sw.sandbox.caches.open('someone-elses-cache'));
  await sw.fire('activate');
  check('activate removes old MyFiles caches only', !sw.store.has('myfiles-v0') && sw.store.has('someone-elses-cache') && sw.store.has('myfiles-v1'));
  for (const [label, r] of [
    ['POST request', req('https://site.test/admin/x', { method: 'POST', body: '{}' })],
    ['API on workers.dev', req('https://myfiles.me.workers.dev/admin/events', { headers: { Authorization: 'Bearer t' } })],
    ['Supabase auth', req('https://abc.supabase.co/auth/v1/token')],
    ['R2 storage (photos/videos)', req('https://acc.r2.cloudflarestorage.com/b/events/1/originals/2?X-Amz=1')],
    ['private gallery page /e/token', req('https://site.test/e/SECRETTOKEN', {}, 'navigate')],
    ['gallery shell /event.html', req('https://site.test/event.html', {}, 'navigate')],
    ['range request', req('https://site.test/js/app.js', { headers: { range: 'bytes=0-9' } })],
    ['the worker script itself', req('https://site.test/sw.js')],
  ]) { const out = await sw.fire('fetch', { request: r }); check(`never intercepts: ${label}`, !out.responded); }
  check('same-site non-page, non-asset GET (e.g. /api) is left alone', !(await sw.fire('fetch', { request: req('https://site.test/some/data') })).responded);
}
{
  const net = { calls: [] }; const sw = boot(net); await sw.fire('install');
  const r1 = await sw.fire('fetch', { request: req('https://site.test/admin/events.html', {}, 'navigate') });
  check('online navigation is served from the network and saved', r1.responded && (await r1.result.text()) === 'net:/admin/events.html' && sw.store.get('myfiles-v1').has('/admin/events.html'));
  net.down = true;
  const r2 = await sw.fire('fetch', { request: req('https://site.test/admin/events.html', {}, 'navigate') });
  check('offline: the saved page opens', (await r2.result.text()) === 'net:/admin/events.html');
  const r3 = await sw.fire('fetch', { request: req('https://site.test/admin/never-visited.html', {}, 'navigate') });
  check('offline + never visited: the friendly offline page is shown', (await r3.result.text()) === 'x' && sw.store.get('myfiles-v1').has('/offline.html'));
  net.down = false;
  const a1 = await sw.fire('fetch', { request: req('https://site.test/js/admin/auth.js') });
  net.down = true;
  const a2 = await sw.fire('fetch', { request: req('https://site.test/js/admin/auth.js') });
  check('scripts: network first, saved copy offline', (await a1.result.text()) === 'net:/js/admin/auth.js' && (await a2.result.text()) === 'net:/js/admin/auth.js');
  net.down = false; net.respond = () => new Response('missing', { status: 404 });
  await sw.fire('fetch', { request: req('https://site.test/js/gone.js') });
  check('an error response (404) is never saved', !sw.store.get('myfiles-v1').has('/js/gone.js'));
  net.respond = (rq) => new Response('mine', { status: 200 });
  const online = await sw.fire('fetch', { request: req('https://site.test/js/admin/auth.js') });
  check('after a deploy the new file wins while online (no stale code)', (await online.result.text()) === 'mine');
  const net2 = { calls: [], down: true }; const sw2 = boot(net2);
  const dead = await sw2.fire('fetch', { request: req('https://site.test/admin/x.html', {}, 'navigate') });
  check('offline with nothing saved at all still answers (503), never hangs', dead.result.status === 503);
}
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
