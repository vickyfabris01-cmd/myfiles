// cloudflare/worker/auth.js
// Every protected route: verify the Supabase JWT with Supabase Auth, then require an active row in admins.
import { ApiError } from './utils.js';

const cache = new Map(); // token -> { admin, until }  (30 s, keeps latency down)

export async function requireAdmin(request, env, db) {
  const m = /^Bearer\s+(.+)$/i.exec(request.headers.get('Authorization') || '');
  if (!m) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in required');
  const token = m[1].trim();

  const hit = cache.get(token);
  if (hit && hit.until > Date.now()) return hit.admin;

  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new ApiError(401, 'INVALID_TOKEN', 'Session is invalid or expired');
  const user = await res.json();
  if (!user || !user.id) throw new ApiError(401, 'INVALID_TOKEN', 'Session is invalid or expired');

  const rows = await db.select('admins', { select: 'user_id', user_id: `eq.${user.id}`, is_active: 'eq.true', limit: 1 });
  if (!rows.length) throw new ApiError(403, 'NOT_ADMIN', 'This account is not an administrator');

  const admin = { id: user.id, email: user.email || null };
  if (cache.size > 200) cache.clear();
  cache.set(token, { admin, until: Date.now() + 30000 });
  return admin;
}
