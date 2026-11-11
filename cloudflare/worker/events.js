// cloudflare/worker/events.js
// Administrator event management.
import { ApiError, v, readJson, created, chunk } from './utils.js';
import { LIMITS } from './config.js';
import { generateToken, hashToken, encryptToken, decryptToken } from './tokens.js';
import { fileInfoMap, thumbUrl } from './media.js';
import { ownedEvent } from './owner.js';
import { renameFiles, renameQuietly } from './renamer.js';

const shareUrl = (env, token) => `${String(env.PUBLIC_SITE_URL || '').replace(/\/+$/, '')}/e/${token}`;

function stateOf(e) {
  if (e.deleted_at) return 'pending_deletion';
  if (e.suspended_at) return 'suspended';
  if (e.is_published) return 'published';
  if (e.publish_at) return 'scheduled';
  return 'unpublished';
}

async function shapeEvents(env, db, rows) {
  const ids = [...new Set(rows.map((r) => r.resolved_cover_id).filter(Boolean))];
  const info = await fileInfoMap(db, ids);
  const pos = new Map();
  for (const part of chunk(rows.map((r) => r.id), 100)) {
    if (!part.length) continue;
    (await db.select('events', { select: 'id,cover_pos_x,cover_pos_y', id: `in.(${part.join(',')})` })).forEach((p) => pos.set(p.id, p));
  }
  return Promise.all(rows.map(async (r) => {
    const cover = r.resolved_cover_id ? info.get(r.resolved_cover_id) : null;
    return {
      id: r.id,
      title: r.title,
      event_date: r.event_date,
      description: r.description,
      location: r.location,
      state: stateOf(r),
      suspended: !!r.suspended_at,
      is_published: r.is_published,
      publish_at: r.publish_at,
      unpublish_at: r.unpublish_at,
      cover_mode: r.cover_mode,
      cover_file_id: r.cover_file_id,
      cover_url: await thumbUrl(env, cover && cover.thumbnail_key),
      cover_pos_x: pos.has(r.id) ? pos.get(r.id).cover_pos_x : 50,
      cover_pos_y: pos.has(r.id) ? pos.get(r.id).cover_pos_y : 50,
      file_count: r.file_count,
      total_bytes: r.total_bytes,
      deleted_at: r.deleted_at,
      recovery_deadline: r.purge_after,
      created_at: r.created_at,
      updated_at: r.updated_at,
    };
  }));
}

// ownerId is always the signed-in host, so the database function can only ever return that host's own event.
export async function getShaped(env, db, id, ownerId) {
  const rows = await db.rpc('admin_events_overview', { p_owner: ownerId, p_deleted: false, p_id: id });
  if (!rows.length) throw new ApiError(404, 'EVENT_NOT_FOUND', 'Event not found');
  return (await shapeEvents(env, db, rows))[0];
}

const getRow = (db, user, id) =>
  ownedEvent(db, user, id, 'id,title,deleted_at,purge_after,suspended_at,is_published,publish_at,unpublish_at,cover_mode,cover_file_id');

const notDeleted = (e) => {
  if (e.deleted_at) throw new ApiError(409, 'EVENT_DELETED', 'Restore this event before changing it');
};

export async function list({ env, db, url, admin }) {
  const deleted = url.searchParams.get('status') === 'deleted';
  const rows = await db.rpc('admin_events_overview', { p_owner: admin.id, p_deleted: deleted });
  return { events: await shapeEvents(env, db, rows) };
}

export async function get({ env, db, params, admin }) {
  return { event: await getShaped(env, db, (await ownedEvent(db, admin, params.id)).id, admin.id) };
}

export async function create({ request, env, db, admin }) {
  const b = await readJson(request);
  const token = generateToken();
  // Atomic in the database: active host only, at most MAX_ACTIVE_EVENTS events outside the bin, creation rate limit.
  const r = await db.rpc('create_event_guarded', {
    p_user: admin.id, p_max: LIMITS.MAX_ACTIVE_EVENTS, p_per_hour: LIMITS.EVENTS_PER_HOUR,
    p_title: v.str(b.title, 'title', { max: 200 }),
    p_date: v.date(b.event_date, 'event_date'),
    p_desc: v.str(b.description, 'description', { max: 5000, optional: true }),
    p_loc: v.str(b.location, 'location', { max: 200, optional: true }),
    p_hash: await hashToken(token),
    p_enc: await encryptToken(env, token),
  });
  if (!r || !r.ok) {
    if (r && r.reason === 'limit') throw new ApiError(409, 'EVENT_LIMIT', `You can have at most ${LIMITS.MAX_ACTIVE_EVENTS} active events. Delete an event you no longer need (events in the recycle bin do not count), then try again.`, { max: LIMITS.MAX_ACTIVE_EVENTS });
    if (r && r.reason === 'rate') throw new ApiError(429, 'RATE_LIMITED', 'You are creating events too fast. Try again later.', { retry_after: 3600 });
    throw new ApiError(403, 'NOT_ALLOWED', 'This account cannot create events right now');
  }
  return created({ event: await getShaped(env, db, r.id, admin.id), share_url: shareUrl(env, token) });
}

export async function update({ request, env, db, params, admin }) {
  const cur = await getRow(db, admin, params.id);
  notDeleted(cur);
  const b = await readJson(request);
  const patch = {};
  if ('title' in b) patch.title = v.str(b.title, 'title', { max: 200 });
  if ('event_date' in b) patch.event_date = v.date(b.event_date, 'event_date');
  if ('description' in b) patch.description = v.str(b.description, 'description', { max: 5000, optional: true });
  if ('location' in b) patch.location = v.str(b.location, 'location', { max: 200, optional: true });
  if ('cover_mode' in b) patch.cover_mode = v.oneOf(b.cover_mode, 'cover_mode', ['auto', 'manual']);
  if ('cover_file_id' in b) {
    patch.cover_file_id = v.uuid(b.cover_file_id, 'cover_file_id', { optional: true });
    if (patch.cover_file_id) {
      const [f] = await db.select('media_files', { select: 'id', id: `eq.${patch.cover_file_id}`, event_id: `eq.${cur.id}`, status: 'eq.ready', deleted_at: 'is.null', limit: 1 });
      if (!f) throw new ApiError(400, 'VALIDATION_ERROR', 'cover_file_id must be a finished file of this event');
    }
  }
  if ('cover_pos_x' in b) patch.cover_pos_x = v.num(b.cover_pos_x, 'cover_pos_x', { min: 0, max: 100 });
  if ('cover_pos_y' in b) patch.cover_pos_y = v.num(b.cover_pos_y, 'cover_pos_y', { min: 0, max: 100 });
  // a different cover photo starts centred unless the request says where
  if (patch.cover_file_id && patch.cover_file_id !== cur.cover_file_id) {
    if (!('cover_pos_x' in patch)) patch.cover_pos_x = 50;
    if (!('cover_pos_y' in patch)) patch.cover_pos_y = 50;
  }
  const mode = patch.cover_mode ?? cur.cover_mode;
  const cover = 'cover_file_id' in patch ? patch.cover_file_id : cur.cover_file_id;
  if (mode === 'manual' && !cover) throw new ApiError(400, 'VALIDATION_ERROR', 'Choose a cover file for manual cover mode');
  if (!Object.keys(patch).length) throw new ApiError(400, 'VALIDATION_ERROR', 'Nothing to update');
  await db.update('events', { id: `eq.${cur.id}`, created_by: `eq.${admin.id}` }, patch);
  if (patch.title && patch.title !== cur.title) await renameQuietly(db, cur.id);   // the event name is part of every file name
  return { event: await getShaped(env, db, cur.id, admin.id) };
}

// POST /admin/events/:id/rename-files   store the naming convention on every file of the event (also files uploaded before it existed)
export async function renameAllFiles({ db, params, admin }) {
  const cur = await getRow(db, admin, params.id);
  notDeleted(cur);
  return { renamed: await renameFiles(db, cur.id) };
}

// Manual publish / unpublish. Never deletes anything.
export async function publish({ request, env, db, params, admin }) {
  const cur = await getRow(db, admin, params.id);
  notDeleted(cur);
  const b = await readJson(request);
  const on = v.bool(b.published, 'published');
  if (on && cur.suspended_at) throw new ApiError(403, 'EVENT_SUSPENDED', 'This event was suspended and cannot be published.');
  // a manual change cancels the matching pending schedule
  const patch = on ? { is_published: true, publish_at: null } : { is_published: false, unpublish_at: null };
  await db.update('events', { id: `eq.${cur.id}`, created_by: `eq.${admin.id}` }, patch);
  return { event: await getShaped(env, db, cur.id, admin.id) };
}

// body: { publish_at?: ISO|null, unpublish_at?: ISO|null }  (missing = unchanged, null = cancel)
export async function schedule({ request, env, db, params, admin }) {
  const cur = await getRow(db, admin, params.id);
  notDeleted(cur);
  const b = await readJson(request);
  const patch = {};
  for (const k of ['publish_at', 'unpublish_at']) {
    if (!(k in b)) continue;
    if (b[k] === null) { patch[k] = null; continue; }
    const iso = v.iso(b[k], k);
    if (Date.parse(iso) <= Date.now()) throw new ApiError(400, 'VALIDATION_ERROR', `${k} must be in the future`);
    patch[k] = iso;
  }
  if (!Object.keys(patch).length) throw new ApiError(400, 'VALIDATION_ERROR', 'Provide publish_at and/or unpublish_at');
  const pub = 'publish_at' in patch ? patch.publish_at : cur.publish_at;
  const unpub = 'unpublish_at' in patch ? patch.unpublish_at : cur.unpublish_at;
  if (pub && unpub && Date.parse(unpub) <= Date.parse(pub)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'unpublish_at must be after publish_at');
  }
  if (cur.suspended_at && patch.publish_at) throw new ApiError(403, 'EVENT_SUSPENDED', 'This event was suspended and cannot be published.');
  await db.update('events', { id: `eq.${cur.id}`, created_by: `eq.${admin.id}` }, patch);
  return { event: await getShaped(env, db, cur.id, admin.id) };
}

// Move the event to the recycle bin (2 days). It is immediately unavailable to visitors.
export async function remove({ env, db, params, admin }) {
  const cur = await getRow(db, admin, params.id);
  if (!cur.deleted_at) {
    const now = Date.now();
    await db.update('events', { id: `eq.${cur.id}`, created_by: `eq.${admin.id}`, deleted_at: 'is.null' }, {
      deleted_at: new Date(now).toISOString(),
      purge_after: new Date(now + LIMITS.DELETE_GRACE_MS).toISOString(),
      purge_attempts: 0,
      purge_last_error: null,
      is_published: false,
      publish_at: null,
      unpublish_at: null,
    });
  }
  const rows = await db.rpc('admin_events_overview', { p_owner: admin.id, p_deleted: true, p_id: cur.id });
  return { event: (await shapeEvents(env, db, rows))[0] };
}

// Restore only while the host has fewer than MAX_ACTIVE_EVENTS active events (checked atomically in the database).
export async function restore({ env, db, params, admin }) {
  const cur = await getRow(db, admin, params.id);
  const r = await db.rpc('restore_event_guarded', { p_user: admin.id, p_event: cur.id, p_max: LIMITS.MAX_ACTIVE_EVENTS });
  if (!r || !r.ok) {
    if (r && r.reason === 'limit') throw new ApiError(409, 'EVENT_LIMIT', `You already have ${LIMITS.MAX_ACTIVE_EVENTS} active events. Delete one first, then restore this event.`, { max: LIMITS.MAX_ACTIVE_EVENTS });
    if (r && r.reason === 'expired') throw new ApiError(409, 'RECOVERY_EXPIRED', 'The 2-day recovery period has ended');
    if (r && r.reason === 'not_deleted') throw new ApiError(409, 'NOT_DELETED', 'This event is not in the recycle bin');
    throw new ApiError(404, 'EVENT_NOT_FOUND', 'Event not found');
  }
  // restored events come back unpublished; the host republishes deliberately
  await db.update('events', { id: `eq.${cur.id}`, created_by: `eq.${admin.id}` }, { purge_attempts: 0, purge_last_error: null, is_published: false });
  return { event: await getShaped(env, db, cur.id, admin.id) };
}

export async function shareLink({ env, db, params, admin }) {
  const e = await ownedEvent(db, admin, params.id, 'id,share_token_enc');
  try {
    return { url: shareUrl(env, await decryptToken(env, e.share_token_enc)) };
  } catch {
    throw new ApiError(409, 'TOKEN_UNRECOVERABLE', 'The stored link cannot be decrypted. Regenerate the link.');
  }
}

export async function regenerateShareLink({ env, db, params, admin }) {
  const cur = await getRow(db, admin, params.id);
  const token = generateToken();
  await db.update('events', { id: `eq.${cur.id}`, created_by: `eq.${admin.id}` }, {
    share_token_hash: await hashToken(token),
    share_token_enc: await encryptToken(env, token),
  });
  return { url: shareUrl(env, token) };
}
