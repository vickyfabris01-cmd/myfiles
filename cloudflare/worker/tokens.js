// cloudflare/worker/tokens.js
// Share tokens: hashed for public lookups, AES-GCM encrypted so the admin can re-copy the same link.
const enc = new TextEncoder();
const dec = new TextDecoder();

const b64u = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const unb64u = (s) => {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
};

export function generateToken() {
  return b64u(crypto.getRandomValues(new Uint8Array(32))); // 256 bits, 43 chars
}

export async function hashToken(token) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(token));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

let keyCache = null;
async function getKey(env) {
  if (keyCache && keyCache.raw === env.TOKEN_ENC_KEY) return keyCache.key;
  const raw = Uint8Array.from(atob(env.TOKEN_ENC_KEY), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  keyCache = { raw: env.TOKEN_ENC_KEY, key };
  return key;
}

export async function encryptToken(env, token) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await getKey(env), enc.encode(token));
  return `${b64u(iv)}.${b64u(ct)}`;
}

export async function decryptToken(env, stored) {
  const [iv, ct] = stored.split('.');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64u(iv) }, await getKey(env), unb64u(ct));
  return dec.decode(pt);
}
