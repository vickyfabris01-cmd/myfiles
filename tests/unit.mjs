// tests/unit.mjs  -  no network or database needed:  node tests/unit.mjs
import worker from '../cloudflare/worker/index.js';
import { signUrl } from '../cloudflare/worker/r2.js';
import { pickFiles, layoutFor, sourceKey, OG_W, OG_H } from '../cloudflare/worker/og.js';
import { generateToken, hashToken, encryptToken, decryptToken } from '../cloudflare/worker/tokens.js';

let pass = 0, fail = 0;
const check = (n, c) => { c ? pass++ : fail++; console.log(c ? 'PASS' : 'FAIL', n); };
const env = {
  ALLOWED_ORIGINS: 'https://app.pages.dev,https://*.app.pages.dev',
  SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_ANON_KEY: 'x', SUPABASE_SERVICE_KEY: 'x',
  TOKEN_ENC_KEY: Buffer.alloc(32, 1).toString('base64'),
};
const req = (m, p, h = {}) => worker.fetch(new Request('https://api.test' + p, { method: m, headers: h }), env, {});

// SigV4 against the published AWS example (proves presigned URLs are computed correctly)
const url = await signUrl({
  host: 'examplebucket.s3.amazonaws.com', path: '/test.txt', method: 'GET', expires: 86400,
  date: new Date('2013-05-24T00:00:00Z'), region: 'us-east-1',
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
});
check('SigV4 matches AWS test vector', url.endsWith('aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404'));

// tokens
const t = generateToken();
check('token is 43 url-safe chars', /^[A-Za-z0-9_-]{43}$/.test(t));
check('two tokens differ', t !== generateToken());
check('hash is stable sha256 hex', (await hashToken(t)).length === 64 && (await hashToken(t)) === (await hashToken(t)));
check('encrypt/decrypt roundtrip', (await decryptToken(env, await encryptToken(env, t))) === t);
check('ciphertext differs each time', (await encryptToken(env, t)) !== (await encryptToken(env, t)));

// routing, CORS, auth guard (none of these touch the database)
check('health ok', (await req('GET', '/health')).status === 200);
check('unknown route 404', (await req('GET', '/nope')).status === 404);
const body = await (await req('GET', '/admin/events')).json();
check('admin route without token -> 401 envelope', body.success === false && body.error.code === 'UNAUTHENTICATED' && body.data === null);
check('CORS allows configured origin', (await req('OPTIONS', '/admin/events', { Origin: 'https://app.pages.dev' })).headers.get('Access-Control-Allow-Origin') === 'https://app.pages.dev');
check('CORS allows preview subdomain', (await req('OPTIONS', '/x', { Origin: 'https://abc.app.pages.dev' })).headers.get('Access-Control-Allow-Origin') === 'https://abc.app.pages.dev');
check('CORS blocks other origins', !(await req('OPTIONS', '/x', { Origin: 'https://evil.example' })).headers.get('Access-Control-Allow-Origin'));
const bad = await worker.fetch(new Request('https://api.test/event/validate', { method: 'POST', body: JSON.stringify({ token: 'nope' }) }), env, {});
check('malformed public token -> 404 EVENT_UNAVAILABLE without DB access', bad.status === 404 && (await bad.json()).error.code === 'EVENT_UNAVAILABLE');

// link preview collage: which files are picked and how they are laid out
const ph = (id, o = {}) => ({ id, media_type: 'photo', mime_type: 'image/jpeg', size_bytes: 2e6, object_key: `o/${id}`, thumbnail_key: `t/${id}`, ...o });
const vid = (id, o = {}) => ({ id, media_type: 'video', mime_type: 'video/mp4', size_bytes: 9e7, object_key: `o/${id}`, thumbnail_key: `t/${id}`, ...o });
let pf = pickFiles(ph('c'), [ph('c'), ph('a'), ph('b'), ph('d')]);
check('preview: cover + two most recent others, cover not repeated', pf.map((f) => f.id).join() === 'c,a,b');
check('preview: cover uses the sharp original, tiles use thumbnails', pf[0].key === 'o/c' && pf[1].key === 't/a');
pf = pickFiles(ph('c'), [vid('v1'), ph('a'), ph('b')]);
check('preview: a video contributes its thumbnail', pf[1].id === 'v1' && pf[1].key === 't/v1');
pf = pickFiles(ph('c'), [vid('v1', { thumbnail_key: null }), ph('heic', { mime_type: 'image/heic', thumbnail_key: null }), ph('a')]);
check('preview: skips files a crawler cannot show (video or HEIC without thumbnail)', pf.map((f) => f.id).join() === 'c,a');
pf = pickFiles(ph('c', { mime_type: 'image/heic', thumbnail_key: null }), [ph('a'), ph('b'), ph('d')]);
check('preview: unusable cover -> newest usable file takes the big slot', pf.map((f) => f.id).join() === 'a,b,d' && pf[0].key === 'o/a');
check('preview: big photo over 12 MB falls back to its thumbnail', sourceKey(ph('x', { size_bytes: 20e6 }), 'big') === 't/x');
check('preview: no files -> nothing picked', pickFiles(null, []).length === 0);
for (const n of [1, 2, 3]) {
  const L = layoutFor(n);
  check(`preview: layout for ${n} fits the ${OG_W}x${OG_H} canvas without overlap`,
    L.length === n && L.every((r) => r.left >= 0 && r.top >= 0 && r.left + r.width <= OG_W && r.top + r.height <= OG_H) &&
    L.every((a, i) => L.every((b, j) => i === j || a.left + a.width <= b.left || b.left + b.width <= a.left || a.top + a.height <= b.top || b.top + b.height <= a.top)));
}
const pv = await req('GET', '/event/nope/preview');
check('preview route: malformed token -> 404 EVENT_UNAVAILABLE without DB access', pv.status === 404 && (await pv.json()).error.code === 'EVENT_UNAVAILABLE');
const pi = await req('GET', '/event/nope/og.jpg');
check('preview image route: malformed token -> 404 JSON, not an image', pi.status === 404 && /json/.test(pi.headers.get('Content-Type')));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
