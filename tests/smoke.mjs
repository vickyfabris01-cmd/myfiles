// tests/smoke.mjs  -  live check against your deployed Worker.
// API_URL=https://myfiles-api.xxx.workers.dev SUPABASE_URL=... SUPABASE_ANON_KEY=... \
// ADMIN_EMAIL=... ADMIN_PASSWORD=... node tests/smoke.mjs        (add BIG=1 to test a 60 MB multipart upload)
const { API_URL, SUPABASE_URL, SUPABASE_ANON_KEY, ADMIN_EMAIL, ADMIN_PASSWORD, BIG } = process.env;
let pass = 0, fail = 0;
const check = (n, c, x) => { c ? pass++ : fail++; console.log(c ? 'PASS' : 'FAIL', n, c ? '' : JSON.stringify(x ?? '')); };
let token = null;
async function api(method, path, body) {
  const r = await fetch(API_URL + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({})); return { status: r.status, data: j.data, error: j.error };
}
const bytes = (n) => { const b = new Uint8Array(n); for (let i = 0; i < n; i += 65536) crypto.getRandomValues(b.subarray(i, Math.min(n, i + 65536))); return b; };
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

check('anonymous admin call rejected', (await api('GET', '/admin/events')).status === 401);
const login = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }) });
token = (await login.json()).access_token;
check('admin sign-in', !!token); if (!token) process.exit(1);
check('admin/me', (await api('GET', '/admin/me')).status === 200);

const ev = await api('POST', '/admin/events', { title: 'Smoke test ' + new Date().toISOString(), event_date: '2026-01-01' });
check('create event', ev.status === 201, ev); const id = ev.data.event.id; const tok = ev.data.share_url.split('/e/')[1];
check('unpublished event hidden', (await api('POST', '/event/validate', { token: tok })).status === 404);

const photo = bytes(300000), thumb = bytes(4000);
const a = await api('POST', '/admin/upload/authorize', { event_id: id, filename: 'smoke.jpg', mime_type: 'image/jpeg', size_bytes: photo.length });
check('authorize upload', a.status === 201, a);
const p1 = await fetch(a.data.upload_url, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: photo });
const p2 = await fetch(a.data.thumbnail_upload_url, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: thumb });
check('direct browser-style PUT to R2 (original + thumbnail)', p1.ok && p2.ok, [p1.status, p2.status]);
const c = await api('POST', '/admin/upload/complete', { session_id: a.data.session_id });
check('complete -> ready', c.data?.file?.status === 'ready', c);

if (BIG) {
  const size = 60 * 1048576, big = bytes(size);
  const m = await api('POST', '/admin/upload/authorize', { event_id: id, filename: 'big.mp4', mime_type: 'video/mp4', size_bytes: size });
  const nums = Array.from({ length: m.data.total_parts }, (_, i) => i + 1);
  const urls = (await api('POST', '/admin/upload/parts', { session_id: m.data.session_id, part_numbers: nums })).data.parts;
  for (const { part_number, url } of urls) {
    const chunk = big.subarray((part_number - 1) * m.data.part_size, Math.min(size, part_number * m.data.part_size));
    const r = await fetch(url, { method: 'PUT', body: chunk }); if (!r.ok) check('part ' + part_number, false, r.status);
  }
  const mc = await api('POST', '/admin/upload/complete', { session_id: m.data.session_id });
  check('multipart upload completes', mc.data?.file?.status === 'ready', mc);
}

check('publish', (await api('POST', `/admin/events/${id}/publish`, { published: true })).status === 200);
const v = await api('POST', '/event/validate', { token: tok });
check('visitor opens link', v.status === 200 && v.data.event.title.startsWith('Smoke'), v);
const files = await api('GET', `/event/${tok}/files`);
check('visitor lists files', files.data?.total >= 1, files);
const dl = await api('POST', `/event/${tok}/download`, { file_ids: [c.data.file.id] });
const got = new Uint8Array(await (await fetch(dl.data.items[0].url)).arrayBuffer());
check('downloaded original is byte-identical to the upload', same(got, photo));
const rng = await fetch(dl.data.items[0].url, { headers: { Range: 'bytes=10-19' } });
check('HTTP Range supported (video seeking)', rng.status === 206 && (await rng.arrayBuffer()).byteLength === 10, rng.status);

check('delete event', (await api('DELETE', `/admin/events/${id}`)).data?.event?.state === 'pending_deletion');
check('deleted event immediately unavailable', (await api('POST', '/event/validate', { token: tok })).status === 404);
check('restore event', (await api('POST', `/admin/events/${id}/restore`)).status === 200);
await api('DELETE', `/admin/events/${id}`);
console.log(`\n${pass} passed, ${fail} failed. The smoke event is left in its 7-day recovery period and will be purged automatically.`);
process.exit(fail ? 1 : 0);
