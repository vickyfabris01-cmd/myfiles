// tests/isolation.mjs  -  offline proof that one host can never touch another host's data:  node tests/isolation.mjs
// A tiny in-memory Supabase (auth + PostgREST filters + the few SQL functions the Worker calls) and a fake R2 bucket
// run the REAL Worker code. Host B then tries every host route against host A's event, folder, file, upload and bin items.
// Note: the SQL functions themselves are tested separately against real PostgreSQL (see docs/testing-notes.md).
import worker from '../cloudflare/worker/index.js';
import { hashToken, generateToken, encryptToken } from '../cloudflare/worker/tokens.js';

let pass = 0, fail = 0;
const check = (n, c) => { c ? pass++ : (fail++, console.log('FAIL', n)); if (c) console.log('PASS', n); };
const U = (n) => `${n}0000000-0000-4000-8000-000000000000`;
const USERS = { tokA: U(1), tokB: U(2), tokC: U(3), tokD: U(4), tokS: U(5) };
const env = {
  ALLOWED_ORIGINS: 'https://app.pages.dev', SUPABASE_URL: 'http://supabase.test', SUPABASE_ANON_KEY: 'a', SUPABASE_SERVICE_KEY: 's',
  TOKEN_ENC_KEY: Buffer.alloc(32, 1).toString('base64'), PUBLIC_SITE_URL: 'https://site.test',
  R2_ACCOUNT_ID: 'acc', R2_ACCESS_KEY_ID: 'k', R2_SECRET_ACCESS_KEY: 'sk', R2_BUCKET_NAME: 'b',
};

/* ---------------- fake database ---------------- */
const T = { profiles: [], app_settings: [{ id: true, approval_required: true, r2_budget_bytes: 1e10, default_quota_bytes: 2147483648 }],
  events: [], media_folders: [], media_files: [], upload_sessions: [], reports: [] };
const uuid = () => crypto.randomUUID();
const own = (id) => T.events.find((e) => e.created_by === id);
const matchRow = (row, params) => {
  for (const [k, raw] of params) {
    if (['select', 'order', 'limit', 'offset'].includes(k)) continue;
    const dot = raw.indexOf('.'); const op = raw.slice(0, dot); const val = raw.slice(dot + 1);
    const x = row[k];
    if (op === 'eq') { if (String(x) !== val) return false; }
    else if (op === 'neq') { if (String(x) === val) return false; }
    else if (op === 'in') { if (!val.slice(1, -1).split(',').includes(String(x))) return false; }
    else if (op === 'is') { if (val === 'null' ? (x !== null && x !== undefined) : x === null) return false; }
    else if (op === 'not') { if (val === 'is.null' ? (x === null || x === undefined) : false) return false; }
    else if (op === 'lte') { if (!(x <= val)) return false; }
    else if (op === 'lt') { if (!(x < val)) return false; }
    else if (op === 'gte') { if (!(x >= val)) return false; }
    else if (op === 'ilike') { if (!String(x).toLowerCase().includes(val.replaceAll('*', '').toLowerCase())) return false; }
  }
  return true;
};
const withEmbed = (table, row) => (table === 'events' ? { ...row, owner: { status: (T.profiles.find((p) => p.user_id === row.created_by) || {}).status } } : row);
const fileUsed = (uid) => T.media_files.filter((f) => ['ready', 'uploading'].includes(f.status) && own2(f.event_id) === uid).reduce((a, f) => a + f.size_bytes, 0);
const own2 = (eid) => (T.events.find((e) => e.id === eid) || {}).created_by;
const sub = (id) => { const out = [id]; for (const f of T.media_folders) if (f.parent_id && out.includes(f.parent_id) && !out.includes(f.id)) out.push(f.id); return out; };

const RPC = {
  admin_events_overview: ({ p_owner, p_deleted, p_id }) => T.events.filter((e) => e.created_by === p_owner && (p_id ? e.id === p_id : !!e.deleted_at === p_deleted))
    .map((e) => ({ ...e, resolved_cover_id: null, file_count: 0, total_bytes: 0 })),
  folder_subtree: ({ p_folder }) => sub(p_folder),
  folder_breadcrumb: ({ p_folder }) => { const f = T.media_folders.find((x) => x.id === p_folder); return f ? [{ id: f.id, name: f.name, depth: 1 }] : []; },
  folder_cards: ({ p_event, p_parent }) => T.media_folders.filter((f) => f.event_id === p_event && (f.parent_id ?? null) === (p_parent ?? null) && !f.deleted_at).map((f) => ({ ...f, resolved_cover_id: null, file_count: 0, recent_file_ids: [] })),
  event_cover_file: () => null,
  bin_items: ({ p_user }) => T.events.filter((e) => e.created_by === p_user && e.deleted_at).map((e) => ({ kind: 'event', id: e.id, name: e.title, event_id: e.id, event_title: e.title, blocked_by: null, size_bytes: 0, file_count: 0, deleted_at: e.deleted_at, purge_after: e.purge_after })),
  host_storage_summary: ({ p_user }) => ({ quota_bytes: 2147483648, photos_bytes: fileUsed(p_user), videos_bytes: 0, bin_bytes: 0, pending_bytes: 0 }),
  host_event_usage: ({ p_user }) => T.events.filter((e) => e.created_by === p_user).map((e) => ({ event_id: e.id, title: e.title, deleted: !!e.deleted_at, total_bytes: 0, bin_bytes: 0 })),
  create_event_guarded: (a) => {
    const p = T.profiles.find((x) => x.user_id === a.p_user);
    if (!p || p.role !== 'host' || p.status !== 'active') return { ok: false, reason: 'not_allowed' };
    if (T.events.filter((e) => e.created_by === a.p_user && !e.deleted_at).length >= a.p_max) return { ok: false, reason: 'limit' };
    const id = uuid(); T.events.push({ id, title: a.p_title, event_date: a.p_date, description: a.p_desc, location: a.p_loc, share_token_hash: a.p_hash, share_token_enc: a.p_enc, is_published: false, deleted_at: null, purge_after: null, suspended_at: null, created_by: a.p_user, cover_mode: 'auto', cover_pos_x: 50, cover_pos_y: 50 });
    return { ok: true, id };
  },
  restore_event_guarded: (a) => {
    const e = T.events.find((x) => x.id === a.p_event && x.created_by === a.p_user);
    if (!e) return { ok: false, reason: 'not_found' };
    if (T.events.filter((x) => x.created_by === a.p_user && !x.deleted_at).length >= a.p_max) return { ok: false, reason: 'limit' };
    e.deleted_at = null; e.purge_after = null; return { ok: true };
  },
  reserve_upload: (a) => {
    const p = T.profiles.find((x) => x.user_id === a.p_user);
    if (!p || p.role !== 'host' || p.status !== 'active') return { ok: false, reason: 'not_allowed' };
    const e = T.events.find((x) => x.id === a.p_event && x.created_by === a.p_user);
    if (!e) return { ok: false, reason: 'event_not_found' };
    if (e.deleted_at) return { ok: false, reason: 'event_deleted' };
    const used = fileUsed(a.p_user);
    if (used + a.p_size > 2147483648) return { ok: false, reason: 'quota', used, quota: 2147483648, bin_bytes: 5 * 1048576 };
    T.media_files.push({ id: a.p_file_id, event_id: a.p_event, folder_id: a.p_folder, original_filename: a.p_filename, object_key: a.p_key, media_type: a.p_media_type, mime_type: a.p_mime, size_bytes: a.p_size, status: 'uploading', thumbnail_key: null, deleted_at: null, purge_after: null, bin_group: null });
    return { ok: true, used: used + a.p_size, quota: 2147483648 };
  },
  system_totals: () => ({ hosts: 4, pending: 1, events: T.events.length, bytes_used: 0 }),
  super_host_list: () => T.profiles.filter((p) => p.role === 'host').map((p) => ({ user_id: p.user_id, email: p.email, status: p.status, events: 0, used_bytes: 0, quota_bytes: 2147483648, created_at: 'x' })),
  super_reports_list: () => T.reports.map((r) => ({ id: r.id, event_id: r.event_id, host_id: own2(r.event_id), host_email: (T.profiles.find((p) => p.user_id === own2(r.event_id)) || {}).email, reason: r.reason, status: r.status, report_count: 1, event_suspended: !!T.events.find((e) => e.id === r.event_id).suspended_at, created_at: r.created_at })),
};

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const j = (b, status = 200) => new Response(b === undefined ? '' : JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
  if (url.pathname === '/auth/v1/user') {
    const tok = (init.headers.Authorization || '').replace('Bearer ', '');
    const id = USERS[tok];
    return id ? j({ id, email: `${tok}@x.test`, email_confirmed_at: '2026-01-01' }) : j({ msg: 'bad' }, 401);
  }
  if (url.pathname.startsWith('/auth/v1/admin/users/')) return j({});
  const m = /^\/rest\/v1\/(rpc\/)?([a-z_]+)$/.exec(url.pathname);
  if (!m) return j({ msg: 'unexpected ' + url.pathname }, 500);
  const body = init.body ? JSON.parse(init.body) : undefined;
  if (m[1]) { const f = RPC[m[2]]; if (!f) return j({ msg: 'no rpc ' + m[2] }, 500); const out = f(body || {}); return j(out === undefined ? null : out); }
  const table = T[m[2]]; const params = [...url.searchParams.entries()];
  if (init.method === 'GET') { let rows = table.filter((r) => matchRow(r, params)); const lim = url.searchParams.get('limit'); if (lim) rows = rows.slice(0, Number(lim)); return new Response(JSON.stringify(rows.map((r) => withEmbed(m[2], r))), { status: 200, headers: { 'Content-Type': 'application/json', 'Content-Range': `0-${rows.length}/${rows.length}` } }); }
  if (init.method === 'POST') { const rows = (Array.isArray(body) ? body : [body]).map((r) => ({ id: uuid(), created_at: new Date().toISOString(), deleted_at: null, ...r })); if (m[2] === 'profiles' && table.some((p) => p.user_id === body.user_id)) return j({ code: '23505' }, 409); table.push(...rows); return j(rows, 201); }
  if (init.method === 'PATCH') { const hit = table.filter((r) => matchRow(r, params)); hit.forEach((r) => Object.assign(r, body)); return j(hit); }
  if (init.method === 'DELETE') { const hit = table.filter((r) => matchRow(r, params)); hit.forEach((r) => table.splice(table.indexOf(r), 1)); return j(hit); }
  return j({}, 500);
};

const R2 = { objects: new Set(), deleted: [] };
env.BUCKET = {
  head: async (k) => (R2.objects.has(k) ? { size: 10, key: k } : null),
  delete: async (k) => { for (const x of [].concat(k)) { R2.deleted.push(x); R2.objects.delete(x); } },
  list: async ({ prefix }) => ({ objects: [...R2.objects].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) }),
  createMultipartUpload: async () => ({ uploadId: 'u1' }),
  resumeMultipartUpload: () => ({ abort: async () => {}, complete: async () => {} }),
};

/* ---------------- helpers ---------------- */
let ip = 0; let fixedIp = null;
const call = async (tok, method, path, body) => {
  const r = await worker.fetch(new Request('https://api.test' + path, { method, headers: { ...(tok ? { Authorization: `Bearer ${tok}` } : {}), 'CF-Connecting-IP': fixedIp || `10.0.${Math.floor(ip / 250)}.${ip++ % 250}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }), env, {});
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* raw */ }
  return { status: r.status, code: j && j.error && j.error.code, data: j && j.data, text: t };
};
const prof = (n, email, role, status) => T.profiles.push({ user_id: U(n), email, role, status, extra_storage_bytes: 0 });
prof(1, 'a@x.test', 'host', 'active'); prof(2, 'b@x.test', 'host', 'active'); prof(3, 'c@x.test', 'host', 'pending'); prof(4, 'd@x.test', 'host', 'suspended'); prof(5, 'vickyfabris01@gmail.com', 'super_admin', 'active');

/* ---------------- host A builds a world ---------------- */
const TOKEN_A = generateToken();
const EA = uuid(), FA = uuid(), FILEA = uuid(), FILEA2 = uuid(), SA = uuid();
T.events.push({ id: EA, title: 'SECRET WEDDING', event_date: '2026-05-01', description: null, location: null, share_token_hash: await hashToken(TOKEN_A), share_token_enc: await encryptToken(env, TOKEN_A), is_published: true, deleted_at: null, purge_after: null, suspended_at: null, created_by: U(1), cover_mode: 'auto', cover_pos_x: 50, cover_pos_y: 50 });
T.media_folders.push({ id: FA, event_id: EA, parent_id: null, name: 'Folder A', deleted_at: null, purge_after: null, bin_group: null, cover_mode: 'auto' });
const mkFile = (id, folder) => T.media_files.push({ id, event_id: EA, folder_id: folder, original_filename: id.slice(0, 4) + '.jpg', object_key: `events/${EA}/originals/${id}`, thumbnail_key: null, media_type: 'photo', mime_type: 'image/jpeg', size_bytes: 1000, status: 'ready', deleted_at: null, purge_after: null, bin_group: null, created_at: new Date().toISOString() });
mkFile(FILEA, FA); mkFile(FILEA2, FA);
R2.objects.add(`events/${EA}/originals/${FILEA}`); R2.objects.add(`events/${EA}/originals/${FILEA2}`);
T.media_files.push({ id: uuid(), event_id: EA, folder_id: null, original_filename: 'up.mp4', object_key: 'k-up', media_type: 'video', mime_type: 'video/mp4', size_bytes: 100, status: 'uploading', deleted_at: null, purge_after: null, bin_group: null });
const upFile = T.media_files.at(-1).id;
T.upload_sessions.push({ id: SA, event_id: EA, folder_id: null, file_id: upFile, r2_upload_id: null, part_size: null, original_filename: 'up.mp4', mime_type: 'video/mp4', size_bytes: 100, status: 'pending', expires_at: new Date(Date.now() + 3600e3).toISOString(), created_by: U(1) });
const snapshot = () => JSON.stringify([T.events, T.media_folders, T.media_files, T.upload_sessions]);
const before = snapshot();

/* ---------------- 1. host B attacks host A ---------------- */
const B = 'tokB';
const attacks = [
  ['GET', `/admin/events/${EA}`], ['PATCH', `/admin/events/${EA}`, { title: 'hacked' }], ['DELETE', `/admin/events/${EA}`],
  ['POST', `/admin/events/${EA}/restore`], ['POST', `/admin/events/${EA}/publish`, { published: false }],
  ['POST', `/admin/events/${EA}/schedule`, { unpublish_at: new Date(Date.now() + 9e6).toISOString() }],
  ['GET', `/admin/events/${EA}/share-link`], ['POST', `/admin/events/${EA}/share-link/regenerate`], ['GET', `/admin/events/${EA}/contents`],
  ['GET', `/admin/events/${EA}/contents?folder_id=${FA}`],
  ['POST', '/admin/folders', { event_id: EA, name: 'planted' }], ['POST', '/admin/folders', { event_id: EA, parent_id: FA, name: 'planted2' }],
  ['PATCH', `/admin/folders/${FA}`, { name: 'hacked' }], ['DELETE', `/admin/folders/${FA}`],
  ['PATCH', `/admin/files/${FILEA}`, { filename: 'hacked.jpg' }], ['DELETE', `/admin/files/${FILEA}`], ['GET', `/admin/files/${FILEA}/source`],
  ['POST', `/admin/files/${FILEA}/thumbnail`], ['POST', `/admin/files/${FILEA}/thumbnail/confirm`, {}],
  ['POST', '/admin/files/bulk', { action: 'delete', file_ids: [FILEA, FILEA2] }], ['POST', '/admin/files/bulk', { action: 'move', file_ids: [FILEA], folder_id: null }],
  ['POST', '/admin/upload/authorize', { event_id: EA, filename: 'x.jpg', mime_type: 'image/jpeg', size_bytes: 10 }],
  ['POST', '/admin/upload/authorize', { event_id: EA, folder_id: FA, filename: 'x.jpg', mime_type: 'image/jpeg', size_bytes: 10 }],
  ['POST', '/admin/upload/parts', { session_id: SA, part_numbers: [1] }], ['GET', `/admin/upload/status?session_id=${SA}`],
  ['POST', '/admin/upload/complete', { session_id: SA }], ['POST', '/admin/upload/abort', { session_id: SA }],
  ['POST', '/admin/bin/restore', { kind: 'event', id: EA }], ['POST', '/admin/bin/restore', { kind: 'folder', id: FA }], ['POST', '/admin/bin/restore', { kind: 'file', id: FILEA }],
  ['POST', '/admin/bin/delete', { kind: 'event', id: EA }], ['POST', '/admin/bin/delete', { kind: 'folder', id: FA }], ['POST', '/admin/bin/delete', { kind: 'file', id: FILEA }],
];
for (const [m, p, b] of attacks) {
  const r = await call(B, m, p, b);
  check(`B cannot ${m} ${p.replace(/[0-9a-f-]{36}/g, ':id')}  (got ${r.status} ${r.code})`, r.status === 404 && /NOT_FOUND$/.test(r.code || ''));
}
check('A\'s database rows are completely unchanged after all of B\'s attacks', snapshot() === before);
check('nothing was removed from R2 by B', R2.deleted.length === 0);
const lb = await call(B, 'GET', '/admin/events');
check('B\'s event list is empty (A\'s events are not shown)', lb.status === 200 && lb.data.events.length === 0 && !lb.text.includes('SECRET'));
const sb = await call(B, 'GET', '/admin/storage');
check('B\'s storage dashboard shows none of A\'s usage or events', sb.status === 200 && sb.data.used_bytes === 0 && sb.data.events.length === 0);
const bb = await call(B, 'GET', '/admin/bin');
check('B\'s bin does not list A\'s items', bb.status === 200 && bb.data.items.length === 0);
const la = await call('tokA', 'GET', '/admin/events');
check('A still sees own event', la.data.events.length === 1 && la.data.events[0].title === 'SECRET WEDDING');
check('A can open own event, folder contents, share link', (await call('tokA', 'GET', `/admin/events/${EA}`)).status === 200 && (await call('tokA', 'GET', `/admin/events/${EA}/contents?folder_id=${FA}`)).status === 200 && (await call('tokA', 'GET', `/admin/events/${EA}/share-link`)).status === 200);
check('malformed ids are rejected, never crash', (await call(B, 'GET', '/admin/events/not-a-uuid')).status === 400);

/* ---------------- 2. account states and roles ---------------- */
check('no token -> 401', (await call(null, 'GET', '/admin/events')).status === 401);
check('bad token -> 401', (await call('nope', 'GET', '/admin/events')).status === 401);
check('pending host: events blocked (ACCOUNT_PENDING)', (await call('tokC', 'GET', '/admin/events')).code === 'ACCOUNT_PENDING');
check('pending host cannot create an event', (await call('tokC', 'POST', '/admin/events', { title: 't', event_date: '2026-01-01' })).status === 403);
const meC = await call('tokC', 'GET', '/admin/me');
check('pending host can still read own status via /admin/me', meC.status === 200 && meC.data.admin.status === 'pending');
check('suspended host: everything blocked (ACCOUNT_SUSPENDED)', (await call('tokD', 'GET', '/admin/events')).code === 'ACCOUNT_SUSPENDED' && (await call('tokD', 'POST', '/admin/upload/authorize', { event_id: EA })).code === 'ACCOUNT_SUSPENDED');
check('super admin has no events: host routes blocked', (await call('tokS', 'GET', '/admin/events')).code === 'SUPER_ADMIN_NO_EVENTS' && (await call('tokS', 'GET', `/admin/events/${EA}`)).status === 403);
check('super admin cannot upload', (await call('tokS', 'POST', '/admin/upload/authorize', { event_id: EA })).status === 403);
check('a host cannot call super routes', (await call(B, 'GET', '/super/overview')).code === 'NOT_SUPER_ADMIN' && (await call(B, 'GET', '/super/hosts')).status === 403 && (await call(B, 'PATCH', '/super/settings', { approval_required: false })).status === 403 && (await call(B, 'POST', `/super/hosts/${U(3)}/approve`)).status === 403);
check('new sign-in creates a PENDING profile while approval is ON', await (async () => { USERS.tokN = U(6); const r = await call('tokN', 'GET', '/admin/me'); return r.data.admin.status === 'pending' && r.data.admin.role === 'host'; })());
T.app_settings[0].approval_required = false;
check('new sign-in is ACTIVE when approval is OFF', await (async () => { USERS.tokM = U(7); const r = await call('tokM', 'GET', '/admin/me'); return r.data.admin.status === 'active'; })());
T.app_settings[0].approval_required = true;

/* ---------------- 3. super admin sees counts only ---------------- */
const sh = await call('tokS', 'GET', '/super/hosts'); const so = await call('tokS', 'GET', '/super/overview');
check('super admin: host list has email/status/events/storage', sh.status === 200 && sh.data.hosts.some((h) => h.email === 'a@x.test' && 'used_bytes' in h && 'events' in h));
check('super admin responses never contain event titles, files or links', ![sh.text, so.text].some((t) => /SECRET|WEDDING|originals|\/e\//.test(t)));
check('super admin approves a pending host', (await call('tokS', 'POST', `/super/hosts/${U(3)}/approve`)).data.status === 'active' && T.profiles.find((p) => p.user_id === U(3)).status === 'active');
check('approve is rejected for a host that is not pending', (await call('tokS', 'POST', `/super/hosts/${U(3)}/approve`)).status === 409);
check('super admin cannot act on the super admin itself', (await call('tokS', 'POST', `/super/hosts/${U(5)}/suspend`)).status === 404);
check('add storage beyond R2 space left is refused', (await call('tokS', 'POST', `/super/hosts/${U(1)}/storage`, { add_bytes: 2e10 })).code === 'NOT_ENOUGH_R2');
check('add storage within R2 space works', (await call('tokS', 'POST', `/super/hosts/${U(1)}/storage`, { add_bytes: 1e9 })).data.extra_storage_bytes === 1e9);
check('approval toggle can be switched', (await call('tokS', 'PATCH', '/super/settings', { approval_required: false })).data.settings.approval_required === false);
await call('tokS', 'PATCH', '/super/settings', { approval_required: true });

/* ---------------- 4. quotas and limits (worker mapping of the SQL result) ---------------- */
const big = await call('tokA', 'POST', '/admin/upload/authorize', { event_id: EA, filename: 'big.mp4', mime_type: 'video/mp4', size_bytes: 600 * 1048576 });
check('video over 500 MB is refused (FILE_TOO_LARGE)', big.status === 413 && big.code === 'FILE_TOO_LARGE');
const img = await call('tokA', 'POST', '/admin/upload/authorize', { event_id: EA, filename: 'big.jpg', mime_type: 'image/jpeg', size_bytes: 21 * 1048576 });
check('photo over 20 MB is refused', img.status === 413 && img.code === 'FILE_TOO_LARGE');
T.media_files.push({ id: uuid(), event_id: EA, folder_id: null, original_filename: 'fill', object_key: 'fill', media_type: 'video', mime_type: 'video/mp4', size_bytes: 2147483000, status: 'ready', deleted_at: null, purge_after: null, bin_group: null });
const full = await call('tokA', 'POST', '/admin/upload/authorize', { event_id: EA, filename: 'one.mp4', mime_type: 'video/mp4', size_bytes: 200 * 1048576 });
check('full storage: upload refused with QUOTA_EXCEEDED and a "empty your recycle bin" hint', full.status === 413 && full.code === 'QUOTA_EXCEEDED' && /Empty your recycle bin/.test(JSON.parse(full.text).error.message));
T.media_files.pop();
const ok1 = await call('tokA', 'POST', '/admin/upload/authorize', { event_id: EA, filename: 'ok.jpg', mime_type: 'image/jpeg', size_bytes: 1000 });
check('normal upload is authorized for the owner', ok1.status === 201 && ok1.data.session_id);
for (let i = 0; i < 4; i++) await call('tokA', 'POST', '/admin/events', { title: 'E' + i, event_date: '2026-01-01' });
const sixth = await call('tokA', 'POST', '/admin/events', { title: 'E6', event_date: '2026-01-01' });
check('6th active event is blocked with a clear message (EVENT_LIMIT)', sixth.status === 409 && sixth.code === 'EVENT_LIMIT' && /at most 5/.test(JSON.parse(sixth.text).error.message));

/* ---------------- 5. recycle bin behaviour ---------------- */
const delF = await call('tokA', 'DELETE', `/admin/folders/${FA}`);
check('deleting a folder moves it to the bin (nothing removed from R2)', delF.status === 200 && delF.data.moved_to_bin && R2.deleted.length === 0);
const fr = T.media_folders.find((f) => f.id === FA); const fl = T.media_files.filter((f) => f.folder_id === FA);
check('folder + its files form ONE bin group with a 2-day timer', fr.bin_group === FA && fl.every((f) => f.bin_group === FA && f.deleted_at) && Math.abs(Date.parse(fr.purge_after) - Date.now() - 2 * 86400e3) < 5000);
const cont = await call('tokA', 'GET', `/admin/events/${EA}/contents`);
check('binned folder disappears from the host\'s own listing', cont.data.folders.length === 0);
const pubC = await call(null, 'POST', '/event/validate', { token: TOKEN_A });
check('public link still works while only a folder is binned', pubC.status === 200);
const delEv = await call('tokA', 'DELETE', `/admin/events/${EA}`);
check('deleting the event moves it to the bin', delEv.status === 200 && T.events.find((e) => e.id === EA).deleted_at);
check('share link of a binned event stops working at once', (await call(null, 'POST', '/event/validate', { token: TOKEN_A })).code === 'EVENT_UNAVAILABLE');
const rf = await call('tokA', 'POST', '/admin/bin/restore', { kind: 'folder', id: FA });
check('folder cannot be restored while its event is in the bin ("Restore the event first")', rf.status === 409 && rf.code === 'RESTORE_PARENT_FIRST' && /Restore the event first/.test(JSON.parse(rf.text).error.message));
await call('tokA', 'POST', '/admin/events', { title: 'E5', event_date: '2026-01-01' }); // 5 active events again
const re = await call('tokA', 'POST', '/admin/bin/restore', { kind: 'event', id: EA });
check('restoring the event is blocked at 5 active events', re.status === 409 && re.code === 'EVENT_LIMIT');
await call('tokA', 'DELETE', `/admin/events/${T.events.find((e) => e.created_by === U(1) && !e.deleted_at && e.id !== EA).id}`);
const re2 = await call('tokA', 'POST', '/admin/bin/restore', { kind: 'event', id: EA });
check('event restores once a slot is free (comes back unpublished)', re2.status === 200 && !T.events.find((e) => e.id === EA).deleted_at && !T.events.find((e) => e.id === EA).is_published);
const rf2 = await call('tokA', 'POST', '/admin/bin/restore', { kind: 'folder', id: FA });
check('folder restores as a whole (folder + both files)', rf2.status === 200 && !T.media_folders.find((f) => f.id === FA).deleted_at && T.media_files.filter((f) => f.folder_id === FA).every((f) => !f.deleted_at && !f.bin_group));
const delFile = await call('tokA', 'DELETE', `/admin/files/${FILEA}`);
check('a finished file goes to the bin, not R2', delFile.data.moved_to_bin && R2.deleted.length === 0 && T.media_files.find((f) => f.id === FILEA).deleted_at);
await call('tokA', 'DELETE', `/admin/folders/${FA}`);
const rfile = await call('tokA', 'POST', '/admin/bin/restore', { kind: 'file', id: FILEA });
check('a file whose folder is binned needs the folder restored first', rfile.status === 409 && rfile.data === null && /folder/i.test(JSON.parse(rfile.text).error.message));
await call('tokA', 'POST', '/admin/bin/restore', { kind: 'folder', id: FA });
check('after the folder is back, the separately binned file is still in the bin', !!T.media_files.find((f) => f.id === FILEA).deleted_at && !T.media_files.find((f) => f.id === FILEA2).deleted_at);
const pd = await call('tokA', 'POST', '/admin/bin/delete', { kind: 'file', id: FILEA });
check('permanent delete of a binned file removes R2 object and row', pd.status === 200 && R2.deleted.includes(`events/${EA}/originals/${FILEA}`) && !T.media_files.find((f) => f.id === FILEA));
check('permanent delete refuses an item that is not in the bin', (await call('tokA', 'POST', '/admin/bin/delete', { kind: 'file', id: FILEA2 })).code === 'NOT_IN_BIN');

/* ---------------- 6. suspension and reports ---------------- */
T.events.find((e) => e.id === EA).is_published = true;
fixedIp = '203.0.113.9';
const rep1 = await call(null, 'POST', `/event/${TOKEN_A}/report`, { reason: 'This looks abusive' });
check('anyone can report an event', rep1.status === 200 && T.reports.length === 1);
await call(null, 'POST', `/event/${TOKEN_A}/report`, { reason: 'This looks abusive' });
check('the same person reporting again does not spam the list', T.reports.length === 1);
fixedIp = null;
check('report on an unknown link is refused', (await call(null, 'POST', '/event/' + 'x'.repeat(30) + '/report', { reason: 'abc' })).status === 404);
check('too-short report is refused', (await call(null, 'POST', `/event/${TOKEN_A}/report`, { reason: 'x' })).status === 400);
const rl = await call('tokS', 'GET', '/super/reports');
check('super admin sees the report as a notification, with host email but no title or link', rl.data.reports.length === 1 && rl.data.reports[0].host_email === 'a@x.test' && !/SECRET|WEDDING|\/e\//.test(rl.text));
const rid = rl.data.reports[0].id;
await call('tokS', 'POST', `/super/reports/${rid}/suspend-event`);
check('suspending an event from the report stops its link at once', (await call(null, 'POST', '/event/validate', { token: TOKEN_A })).code === 'EVENT_UNAVAILABLE' && T.events.find((e) => e.id === EA).suspended_at);
check('host cannot re-publish a suspended event', (await call('tokA', 'POST', `/admin/events/${EA}/publish`, { published: true })).code === 'EVENT_SUSPENDED');
await call('tokS', 'POST', `/super/reports/${rid}/unsuspend-event`);
check('super admin can undo an event suspension', !T.events.find((e) => e.id === EA).suspended_at);
T.events.find((e) => e.id === EA).is_published = true;
check('link works again after unsuspending and publishing', (await call(null, 'POST', '/event/validate', { token: TOKEN_A })).status === 200);
await call('tokS', 'POST', `/super/hosts/${U(1)}/suspend`);
check('suspending a HOST stops their links and uploads at once (data kept)', (await call(null, 'POST', '/event/validate', { token: TOKEN_A })).code === 'EVENT_UNAVAILABLE' && (await call('tokA', 'POST', '/admin/upload/authorize', { event_id: EA, filename: 'a.jpg', mime_type: 'image/jpeg', size_bytes: 10 })).code === 'ACCOUNT_SUSPENDED' && T.events.find((e) => e.id === EA));
await call('tokS', 'POST', `/super/hosts/${U(1)}/restore`);
check('restoring the host brings the link back', (await call(null, 'POST', '/event/validate', { token: TOKEN_A })).status === 200);

/* ---------------- 7. delete my account ---------------- */
check('delete account needs the word DELETE', (await call('tokA', 'POST', '/admin/account/delete', { confirm: 'no' })).status === 400);
const evB = await call(B, 'POST', '/admin/events', { title: 'B event', event_date: '2026-01-01' });
R2.objects.add(`events/${evB.data.event.id}/originals/zz`);
const dacc = await call(B, 'POST', '/admin/account/delete', { confirm: 'DELETE' });
check('delete account removes the host\'s events, files and profile', dacc.status === 200 && !T.events.some((e) => e.created_by === U(2)) && ![...R2.objects].some((k) => k.includes(evB.data.event.id)) && !T.profiles.some((p) => p.user_id === U(2)));
check('delete account never touched host A', T.events.some((e) => e.created_by === U(1)));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
