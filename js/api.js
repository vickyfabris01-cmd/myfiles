// js/api.js  -  every call to the Worker goes through here. Returns `data`, throws ApiError.
import { CONFIG } from './config.js';
import { getAccessToken, signOut } from './supabase.js';

export class ApiError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.status = status; this.code = code; this.details = details;
  }
}

const LOGIN_URL = new URL('../admin/index.html', import.meta.url).href;

export const qs = (o) => {
  const p = Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  return p ? `?${p}` : '';
};

export async function api(method, path, body, { retry = true } = {}) {
  let token;
  try { token = await getAccessToken(); } catch (e) { throw new ApiError(e.status || 0, 'AUTH', e.message); }
  if (!token) throw new ApiError(401, 'UNAUTHENTICATED', 'Please sign in again');
  let res;
  try {
    res = await fetch(CONFIG.API_URL + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Cannot reach the server. Check your connection.');
  }
  const json = await res.json().catch(() => null);
  if (res.status === 401 && retry) {
    try { await getAccessToken({ force: true }); return api(method, path, body, { retry: false }); } catch { /* fall through */ }
  }
  if (res.status === 401) {
    await signOut();
    if (typeof location !== 'undefined') location.replace(`${LOGIN_URL}?reason=expired`);
  }
  if (!res.ok || !json || json.success === false) {
    const e = (json && json.error) || {};
    throw new ApiError(res.status, e.code || 'ERROR', e.message || `Request failed (${res.status})`, e.details || null);
  }
  return json.data;
}

export const get = (p) => api('GET', p);
export const post = (p, b) => api('POST', p, b || {});
export const patch = (p, b) => api('PATCH', p, b);
export const del = (p) => api('DELETE', p);
