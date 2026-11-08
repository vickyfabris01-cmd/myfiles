// cloudflare/worker/utils.js
export class ApiError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class Created {
  constructor(data) { this.data = data; }
}
export const created = (data) => new Created(data);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bad = (message, details) => new ApiError(400, 'VALIDATION_ERROR', message, details);

export const v = {
  uuid(x, name, { optional = false } = {}) {
    if (x === undefined || x === null || x === '') {
      if (optional) return null;
      throw bad(`${name} is required`);
    }
    if (typeof x !== 'string' || !UUID_RE.test(x)) throw bad(`${name} must be a valid id`);
    return x.toLowerCase();
  },
  str(x, name, { min = 1, max = 255, optional = false } = {}) {
    if (x === undefined || x === null) {
      if (optional) return null;
      throw bad(`${name} is required`);
    }
    if (typeof x !== 'string') throw bad(`${name} must be text`);
    const s = x.trim();
    if (s.length === 0 && optional) return null;
    if (s.length < min || s.length > max) throw bad(`${name} must be ${min} to ${max} characters`);
    return s;
  },
  int(x, name, { min = -Infinity, max = Infinity, optional = false } = {}) {
    if (x === undefined || x === null) {
      if (optional) return null;
      throw bad(`${name} is required`);
    }
    if (!Number.isInteger(x) || x < min || x > max) throw bad(`${name} must be a whole number from ${min} to ${max}`);
    return x;
  },
  num(x, name, { min = 0, max = Infinity, optional = false } = {}) {
    if (x === undefined || x === null) {
      if (optional) return null;
      throw bad(`${name} is required`);
    }
    if (typeof x !== 'number' || !Number.isFinite(x) || x < min || x > max) throw bad(`${name} is not a valid number`);
    return x;
  },
  bool(x, name) {
    if (typeof x !== 'boolean') throw bad(`${name} must be true or false`);
    return x;
  },
  date(x, name) {
    const ok = typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x) &&
      !Number.isNaN(Date.parse(`${x}T00:00:00Z`)) &&
      new Date(`${x}T00:00:00Z`).toISOString().slice(0, 10) === x;
    if (!ok) throw bad(`${name} must be a date like 2026-05-31`);
    return x;
  },
  iso(x, name) {
    if (typeof x !== 'string' || Number.isNaN(Date.parse(x))) throw bad(`${name} must be an ISO date-time`);
    return new Date(x).toISOString();
  },
  oneOf(x, name, list) {
    if (!list.includes(x)) throw bad(`${name} must be one of: ${list.join(', ')}`);
    return x;
  },
};

export async function readJson(request, maxBytes = 100000) {
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > maxBytes) throw new ApiError(413, 'BODY_TOO_LARGE', 'Request body is too large');
  let text = '';
  try { text = await request.text(); } catch { throw bad('Could not read request body'); }
  if (text.length > maxBytes) throw new ApiError(413, 'BODY_TOO_LARGE', 'Request body is too large');
  if (!text) return {};
  try {
    const b = JSON.parse(text);
    if (b === null || typeof b !== 'object' || Array.isArray(b)) throw new Error('shape');
    return b;
  } catch {
    throw bad('Body must be a JSON object');
  }
}

export function clampInt(raw, min, max, dflt) {
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

export const chunk = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

// ---- rate limiting (in-memory, best effort per isolate) ----
const hits = new Map();
export function rateLimit(request, bucket, max, windowMs = 60000) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const key = `${bucket}:${ip}`;
  const now = Date.now();
  let e = hits.get(key);
  if (!e || e.reset <= now) {
    e = { count: 0, reset: now + windowMs };
    hits.set(key, e);
    if (hits.size > 5000) for (const [k, val] of hits) if (val.reset <= now) hits.delete(k);
  }
  e.count += 1;
  if (e.count > max) {
    throw new ApiError(429, 'RATE_LIMITED', 'Too many requests, slow down',
      { retry_after: Math.max(1, Math.ceil((e.reset - now) / 1000)) });
  }
}

// ---- CORS ----
export function originAllowed(env, origin) {
  if (!origin) return false;
  return (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean).some((p) => {
    if (p === origin) return true;
    if (!p.includes('*')) return false;
    const re = new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[a-z0-9-]+') + '$');
    return re.test(origin);
  });
}

export function corsHeaders(env, origin) {
  const h = { Vary: 'Origin' };
  if (originAllowed(env, origin)) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Methods'] = 'GET,POST,PATCH,DELETE,OPTIONS';
    h['Access-Control-Allow-Headers'] = 'Authorization,Content-Type';
    h['Access-Control-Max-Age'] = '86400';
  }
  return h;
}
