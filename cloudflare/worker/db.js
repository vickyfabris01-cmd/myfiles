// cloudflare/worker/db.js
// Minimal Supabase PostgREST client. Uses the service key, which stays in the Worker.
import { ApiError } from './utils.js';

const qs = (o) =>
  Object.entries(o)
    .filter(([, val]) => val !== undefined && val !== null)
    .map(([k, val]) => `${encodeURIComponent(k)}=${encodeURIComponent(val)}`)
    .join('&');

async function dbError(res) {
  let body = null;
  try { body = await res.json(); } catch { /* ignore */ }
  const code = body && body.code;
  if (code === '23505') return new ApiError(409, 'CONFLICT', 'A record with these values already exists');
  if (code === '23503') return new ApiError(409, 'REFERENCE_ERROR', 'Related record not found or still in use');
  if (code === '22P02' || code === '22007') return new ApiError(400, 'VALIDATION_ERROR', 'Invalid value');
  console.error('DB error', res.status, JSON.stringify(body));
  return new ApiError(500, 'DB_ERROR', 'Database error');
}

export function makeDb(env) {
  const key = env.SUPABASE_SERVICE_KEY;
  const base = `${env.SUPABASE_URL}/rest/v1`;
  const baseHeaders = { apikey: key, 'Content-Type': 'application/json' };
  if (key && key.startsWith('eyJ')) baseHeaders.Authorization = `Bearer ${key}`; // legacy JWT keys only

  async function call(method, path, { body, prefer, count } = {}) {
    const headers = { ...baseHeaders };
    const pref = [];
    if (prefer) pref.push(prefer);
    if (count) pref.push('count=exact');
    if (pref.length) headers.Prefer = pref.join(',');
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw await dbError(res);
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    let total = null;
    const cr = res.headers.get('Content-Range');
    if (count && cr && cr.includes('/')) {
      const t = cr.split('/')[1];
      total = t === '*' ? null : Number(t);
    }
    return { data, total };
  }

  const needFilter = (f) => {
    if (!f || Object.keys(f).length === 0) throw new Error('Refusing update/delete without a filter');
  };

  return {
    async select(table, query) {
      return (await call('GET', `/${table}?${qs(query)}`)).data ?? [];
    },
    async selectCount(table, query) {
      const r = await call('GET', `/${table}?${qs(query)}`, { count: true });
      return { rows: r.data ?? [], total: r.total ?? 0 };
    },
    async insert(table, rows) {
      return (await call('POST', `/${table}`, { body: rows, prefer: 'return=representation' })).data ?? [];
    },
    async update(table, filter, patch) {
      needFilter(filter);
      return (await call('PATCH', `/${table}?${qs(filter)}`, { body: patch, prefer: 'return=representation' })).data ?? [];
    },
    async remove(table, filter) {
      needFilter(filter);
      return (await call('DELETE', `/${table}?${qs(filter)}`, { prefer: 'return=representation' })).data ?? [];
    },
    async rpc(fn, args = {}) {
      return (await call('POST', `/rpc/${fn}`, { body: args })).data;
    },
  };
}
