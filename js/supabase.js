// js/supabase.js  -  minimal Supabase Auth (GoTrue REST) client. No library, no build step.
import { CONFIG } from './config.js';

const KEY = 'myfiles.session';
const listeners = new Set();
let refreshing = null;

const read = () => { try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; } };
function write(s) {
  if (s) localStorage.setItem(KEY, JSON.stringify(s)); else localStorage.removeItem(KEY);
  listeners.forEach((f) => f(s));
}

async function gotrue(path, body, token, method = 'POST') {
  const headers = { apikey: CONFIG.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(`${CONFIG.SUPABASE_URL}/auth/v1/${path}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
  } catch {
    const e = new Error('Cannot reach the server. Check your connection.'); e.status = 0; throw e;
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(json.error_description || json.msg || json.message || 'Request failed');
    e.status = res.status; e.code = json.error_code || json.error; throw e;
  }
  return json;
}

function toSession(j, prev) {
  return {
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    expires_at: j.expires_at ? j.expires_at * 1000 : Date.now() + (j.expires_in || 3600) * 1000,
    user: j.user ? { id: j.user.id, email: j.user.email } : (prev && prev.user) || null,
  };
}

export async function signIn(email, password) {
  const s = toSession(await gotrue('token?grant_type=password', { email, password }));
  write(s);
  return s;
}

// Public sign-up (email + password). With "Confirm email" ON in Supabase (recommended) there is no session yet:
// the person must click the link in the email first. With it OFF, a session comes back and they are signed in.
export async function signUp(email, password, name) {
  // FUTURE: Turnstile. When you switch it on in Supabase, send the widget token here: { email, password, gotrue_meta_security: { captcha_token } }
  const j = await gotrue('signup', { email, password, ...(name ? { data: { display_name: name } } : {}) });
  if (j.access_token) { write(toSession(j)); return { signedIn: true }; }
  return { signedIn: false };
}

// Forgot password: Supabase emails a link that opens `redirectTo` with a short-lived recovery token in the address (after the #).
// The answer is always the same whether or not the email has an account, so nobody can use this to find out who is registered.
export async function requestPasswordReset(email, redirectTo) {
  await gotrue(`recover?redirect_to=${encodeURIComponent(redirectTo)}`, { email });
}

// Reads what Supabase put in the address of the reset page. { token } for a good link, { error } for a used/expired one.
export function parseAuthRedirect(hash = '', search = '') {
  const p = new URLSearchParams(String(hash).replace(/^#/, ''));
  const q = new URLSearchParams(String(search).replace(/^\?/, ''));
  const get = (k) => p.get(k) || q.get(k);
  if (get('error') || get('error_code')) return { error: get('error_description') || get('error_code') || get('error') };
  if (get('access_token') && get('type') === 'recovery') return { token: get('access_token') };
  return {};
}

// Sets the new password using the recovery token. It does NOT sign the person in: they sign in with the new password afterwards.
export async function updatePassword(accessToken, password) {
  await gotrue('user', { password }, accessToken, 'PUT');
}

export async function signOut() {
  const s = read();
  write(null);
  if (s) { try { await gotrue('logout?scope=local', {}, s.access_token); } catch { /* already gone */ } }
}

export const getSession = read;

export function onSessionChange(fn) {
  listeners.add(fn);
  const onStorage = (e) => { if (e.key === KEY) fn(read()); };
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
  return () => { listeners.delete(fn); if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage); };
}

async function refresh(s) {
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const n = toSession(await gotrue('token?grant_type=refresh_token', { refresh_token: s.refresh_token }), s);
        write(n);
        return n.access_token;
      } catch (e) {
        if (e.status >= 400 && e.status < 500) write(null); // refresh token rejected: signed out
        throw e;
      } finally { refreshing = null; }
    })();
  }
  return refreshing;
}

// Returns a valid access token, refreshing it when it is about to expire.
export async function getAccessToken({ force = false } = {}) {
  const s = read();
  if (!s) return null;
  if (!force && s.expires_at - Date.now() > 60000) return s.access_token;
  return refresh(s);
}
