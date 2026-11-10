// tests/reset.mjs  -  password reset plumbing:  node tests/reset.mjs
import { parseAuthRedirect, requestPasswordReset, updatePassword } from '../js/supabase.js';
let pass = 0, fail = 0;
const check = (n, c) => { c ? pass++ : (fail++, console.log('FAIL', n)); if (c) console.log('PASS', n); };
check('good recovery link -> token', parseAuthRedirect('#access_token=abc&expires_in=3600&refresh_token=r&token_type=bearer&type=recovery').token === 'abc');
check('a normal sign-in link is NOT accepted as recovery', !parseAuthRedirect('#access_token=abc&type=signup').token);
check('expired link -> error, no token', (() => { const r = parseAuthRedirect('#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired'); return !r.token && /expired/.test(r.error); })());
check('error in the query string is also understood', !!parseAuthRedirect('', '?error=access_denied').error);
check('empty address -> nothing', Object.keys(parseAuthRedirect('', '')).length === 0);
const calls = [];
globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }); };
await requestPasswordReset('a@b.co', 'https://site.test/admin/reset.html');
check('recover request goes to Supabase with the redirect', /\/auth\/v1\/recover\?redirect_to=https%3A%2F%2Fsite\.test%2Fadmin%2Freset\.html$/.test(calls[0].url) && JSON.parse(calls[0].init.body).email === 'a@b.co' && calls[0].init.method === 'POST');
await updatePassword('TOKEN', 'newpassword1');
check('new password is sent with PUT and the recovery token', /\/auth\/v1\/user$/.test(calls[1].url) && calls[1].init.method === 'PUT' && calls[1].init.headers.Authorization === 'Bearer TOKEN' && JSON.parse(calls[1].init.body).password === 'newpassword1');
globalThis.fetch = async () => new Response(JSON.stringify({ error_code: 'same_password', msg: 'New password should be different' }), { status: 422, headers: { 'Content-Type': 'application/json' } });
let err = null; try { await updatePassword('T', 'x'); } catch (e) { err = e; }
check('errors keep their code so the page can explain them', err && err.code === 'same_password' && err.status === 422);
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
