// js/public/api.js  -  visitor API client. No login: access is the share token in the link.
import { CONFIG } from '../config.js';

export class PublicError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.status = status; this.code = code; this.details = details;
  }
}

export const qs = (o) => {
  const p = Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  return p ? `?${p}` : '';
};

export async function pub(method, path, body) {
  let res;
  try {
    res = await fetch(CONFIG.API_URL + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new PublicError(0, 'NETWORK', 'Cannot reach the server. Check your connection.');
  }
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || json.success === false) {
    const e = (json && json.error) || {};
    throw new PublicError(res.status, e.code || 'ERROR', e.message || `Request failed (${res.status})`, e.details || null);
  }
  return json.data;
}

// Share links look like  https://site/e/TOKEN  (served by the /e/* rewrite). ?t=TOKEN also works for local testing.
export function tokenFromLocation(loc = location) {
  const m = /^\/e\/([^/]+)/.exec(loc.pathname);
  if (m) return decodeURIComponent(m[1]);
  return new URLSearchParams(loc.search).get('t');
}
