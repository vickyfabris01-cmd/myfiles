// cloudflare/worker/auth.js
// Every protected route: verify the Supabase JWT with Supabase Auth, then load the account's profile.
//   mode 'any'   : any signed-in confirmed account (used by /admin/me so pending and suspended people can see their status)
//   mode 'host'  : an ACTIVE host (the normal events / uploads / bin routes)
//   mode 'super' : the ACTIVE super admin (system routes only; the super admin has no events)
// The token check is cached for 30 s, but the profile is read on every request, so a suspension takes effect at once.
import { ApiError } from './utils.js';

const cache = new Map(); // token -> { user, until }

async function verifyToken(request, env) {
  const m = /^Bearer\s+(.+)$/i.exec(request.headers.get('Authorization') || '');
  if (!m) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in required');
  const token = m[1].trim();
  const hit = cache.get(token);
  if (hit && hit.until > Date.now()) return hit.user;

  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new ApiError(401, 'INVALID_TOKEN', 'Session is invalid or expired');
  const u = await res.json();
  if (!u || !u.id) throw new ApiError(401, 'INVALID_TOKEN', 'Session is invalid or expired');
  if (!u.email_confirmed_at) throw new ApiError(403, 'EMAIL_NOT_CONFIRMED', 'Confirm your email address first');
  const user = { id: u.id, email: u.email || '' };
  if (cache.size > 200) cache.clear();
  cache.set(token, { user, until: Date.now() + 30000 });
  return user;
}

// First sign-in of a new account creates its profile: pending when approval is ON, otherwise active.
async function loadProfile(db, user) {
  const cols = 'user_id,email,role,status';
  let [p] = await db.select('profiles', { select: cols, user_id: `eq.${user.id}`, limit: 1 });
  if (p) return p;
  const [s] = await db.select('app_settings', { select: 'approval_required', limit: 1 });
  const approval = s ? s.approval_required : true;
  try {
    [p] = await db.insert('profiles', { user_id: user.id, email: user.email, role: 'host', status: approval ? 'pending' : 'active' });
  } catch (e) {
    if (e.status !== 409) throw e;
    [p] = await db.select('profiles', { select: cols, user_id: `eq.${user.id}`, limit: 1 });
  }
  return p;
}

export async function requireUser(request, env, db, mode = 'host') {
  const user = await verifyToken(request, env);
  const p = await loadProfile(db, user);
  const me = { id: user.id, email: p.email || user.email, role: p.role, status: p.status };
  if (mode === 'any') return me;
  if (p.status === 'suspended') throw new ApiError(403, 'ACCOUNT_SUSPENDED', 'This account has been suspended');
  if (p.status === 'pending') throw new ApiError(403, 'ACCOUNT_PENDING', 'This account is waiting for approval');
  if (mode === 'super') {
    if (p.role !== 'super_admin') throw new ApiError(403, 'NOT_SUPER_ADMIN', 'Not allowed');
    return me;
  }
  if (p.role !== 'host') throw new ApiError(403, 'SUPER_ADMIN_NO_EVENTS', 'The super admin account does not host events. Use a separate host account.');
  return me;
}

export function clearAuthCache() { cache.clear(); }
