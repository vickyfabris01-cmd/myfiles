// tests/unit.mjs  -  no network or database needed:  node tests/unit.mjs
import worker from '../cloudflare/worker/index.js';
import { signUrl } from '../cloudflare/worker/r2.js';
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
