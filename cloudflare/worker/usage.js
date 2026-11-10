// cloudflare/worker/usage.js
// Host storage dashboard (own data only) and "delete my account".
import { ApiError, readJson } from './utils.js';
import { LIMITS } from './config.js';
import { purgeEvent } from './cleanup.js';
import { clearAuthCache } from './auth.js';

const num = (x) => Number(x) || 0;

export async function storage({ db, admin }) {
  const s = (await db.rpc('host_storage_summary', { p_user: admin.id })) || {};
  const rows = (await db.rpc('host_event_usage', { p_user: admin.id })) || [];
  const quota = num(s.quota_bytes), photos = num(s.photos_bytes), videos = num(s.videos_bytes), bin = num(s.bin_bytes), pending = num(s.pending_bytes);
  const used = photos + videos + bin + pending;
  return {
    quota_bytes: quota, used_bytes: used, free_bytes: Math.max(0, quota - used),
    photos_bytes: photos, videos_bytes: videos, bin_bytes: bin, pending_bytes: pending,
    active_events: rows.filter((r) => !r.deleted).length, max_active_events: LIMITS.MAX_ACTIVE_EVENTS,
    limits: { image_bytes: LIMITS.MAX_IMAGE_BYTES, video_bytes: LIMITS.MAX_VIDEO_BYTES },
    events: rows.map((r) => ({ id: r.event_id, title: r.title, in_bin: !!r.deleted, total_bytes: num(r.total_bytes), bin_bytes: num(r.bin_bytes) })),
  };
}

// POST /admin/account/delete  { confirm: "DELETE" }
// Permanently removes every event and file of this host (R2 and database), then the sign-in itself.
export async function deleteAccount({ request, env, db, admin }) {
  const b = await readJson(request);
  if (b.confirm !== 'DELETE') throw new ApiError(400, 'VALIDATION_ERROR', 'Type DELETE to confirm');
  const events = await db.select('events', { select: 'id', created_by: `eq.${admin.id}` });
  const past = new Date(Date.now() - 1000).toISOString();
  for (const e of events) {
    await db.update('events', { id: `eq.${e.id}`, deleted_at: 'is.null' }, { deleted_at: past, purge_after: past, is_published: false, publish_at: null, unpublish_at: null });
    await db.update('events', { id: `eq.${e.id}` }, { purge_after: past });
  }
  let partial = false;
  for (const e of events) if ((await purgeEvent(env, db, e.id)) === 'partial') partial = true;
  if (partial) throw new ApiError(409, 'ACCOUNT_DELETE_PARTIAL', 'Still removing your files. Press Delete again in a minute to finish.');
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users/${admin.id}`, {
    method: 'DELETE',
    // new-style secret keys (sb_secret_...) go in `apikey` only; legacy JWT service keys also go in Authorization
    headers: { apikey: env.SUPABASE_SERVICE_KEY, ...(String(env.SUPABASE_SERVICE_KEY).startsWith('eyJ') ? { Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}` } : {}) },
  });
  if (!res.ok && res.status !== 404) throw new ApiError(502, 'ACCOUNT_DELETE_FAILED', 'Your files were deleted but the sign-in could not be removed. Try again.');
  await db.remove('profiles', { user_id: `eq.${admin.id}` }).catch(() => {});
  clearAuthCache();
  return { deleted: true };
}
