// cloudflare/worker/files.js
// Administrator media metadata: rename, move, delete, thumbnails.
import { ApiError, v, readJson, chunk } from './utils.js';
import { LIMITS, OBJECT_KEYS } from './config.js';
import { presign } from './r2.js';
import { purgeFiles } from './storage.js';
import { ownedEvent, ownedFile } from './owner.js';

const COLS = 'id,event_id,folder_id,original_filename,object_key,thumbnail_key,media_type,status,deleted_at';

const getFile = (db, user, id) => ownedFile(db, user, id, COLS);

async function assertFolderInEvent(db, folderId, eventId) {
  if (!folderId) return;
  const [f] = await db.select('media_folders', { select: 'id', id: `eq.${folderId}`, event_id: `eq.${eventId}`, deleted_at: 'is.null', limit: 1 });
  if (!f) throw new ApiError(400, 'VALIDATION_ERROR', 'folder_id does not belong to this event');
}

export async function update({ request, db, params, admin }) {
  const cur = await getFile(db, admin, params.id);
  const b = await readJson(request);
  const patch = {};
  if ('folder_id' in b) {
    patch.folder_id = v.uuid(b.folder_id, 'folder_id', { optional: true });
    await assertFolderInEvent(db, patch.folder_id, cur.event_id);
  }
  if ('filename' in b) {
    const n = v.str(b.filename, 'filename', { max: 255 });
    if (/[\u0000-\u001f\u007f/\\]/.test(n)) throw new ApiError(400, 'VALIDATION_ERROR', 'filename contains invalid characters');
    patch.original_filename = n;
  }
  if (!Object.keys(patch).length) throw new ApiError(400, 'VALIDATION_ERROR', 'Nothing to update');
  const [row] = await db.update('media_files', { id: `eq.${cur.id}` }, patch);
  return { file: { id: row.id, folder_id: row.folder_id, filename: row.original_filename } };
}

// A finished file goes to the recycle bin (2 days, still counts toward storage). An unfinished or failed upload
// has nothing worth keeping, so it is removed at once and its reserved space is freed.
async function binOrPurge(env, db, files) {
  const done = files.filter((f) => f.status === 'ready');
  const rest = files.filter((f) => f.status !== 'ready');
  if (done.length) {
    const now = Date.now();
    await db.update('media_files', { id: `in.(${done.map((f) => f.id).join(',')})`, deleted_at: 'is.null' },
      { deleted_at: new Date(now).toISOString(), purge_after: new Date(now + LIMITS.DELETE_GRACE_MS).toISOString() });
  }
  if (rest.length) {
    await purgeFiles(env, db, rest);
    await db.remove('media_files', { id: `in.(${rest.map((f) => f.id).join(',')})` });
  }
}

export async function remove({ env, db, params, admin }) {
  const cur = await getFile(db, admin, params.id);
  await ownedEvent(db, admin, cur.event_id); // the event must not be in the bin either
  await binOrPurge(env, db, [cur]);
  return { deleted_file_id: cur.id, moved_to_bin: cur.status === 'ready' };
}

// POST /admin/files/bulk  { action: "move"|"delete", file_ids: [...up to 200], folder_id?: uuid|null }
export async function bulk({ request, env, db, admin }) {
  const b = await readJson(request);
  const action = v.oneOf(b.action, 'action', ['move', 'delete']);
  if (!Array.isArray(b.file_ids) || b.file_ids.length < 1 || b.file_ids.length > 200) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'file_ids must contain 1 to 200 ids');
  }
  const ids = [...new Set(b.file_ids.map((i) => v.uuid(i, 'file_ids[]')))];
  const files = await db.select('media_files', { select: COLS, id: `in.(${ids.join(',')})`, deleted_at: 'is.null' });
  if (files.length !== ids.length) throw new ApiError(404, 'FILE_NOT_FOUND', 'One or more files were not found');
  const events = new Set(files.map((f) => f.event_id));
  if (events.size > 1) throw new ApiError(400, 'VALIDATION_ERROR', 'All files must belong to the same event');
  // ownership: the one event all these files sit in must belong to the caller; otherwise they look like they do not exist
  try { await ownedEvent(db, admin, files[0].event_id); } catch { throw new ApiError(404, 'FILE_NOT_FOUND', 'One or more files were not found'); }
  if (action === 'move') {
    const folderId = v.uuid(b.folder_id, 'folder_id', { optional: true });
    await assertFolderInEvent(db, folderId, files[0].event_id);
    await db.update('media_files', { id: `in.(${ids.join(',')})` }, { folder_id: folderId });
    return { moved: ids.length };
  }
  await binOrPurge(env, db, files);
  return { deleted: ids.length, moved_to_bin: files.filter((f) => f.status === 'ready').length };
}

// Fresh presigned PUT for a missing or replaced thumbnail. Each call gets its own key so a replaced thumbnail
// is never served from a browser or CDN cache. Send the returned `key` to /thumbnail/confirm.
export async function thumbnailUrl({ env, db, params, admin }) {
  const f = await getFile(db, admin, params.id);
  const tag = [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const key = OBJECT_KEYS.thumbV(f.event_id, f.id, tag);
  return {
    upload_url: await presign(env, 'PUT', key, { expires: LIMITS.UPLOAD_URL_SECONDS }),
    content_type: 'image/jpeg',
    key,
  };
}

// POST /admin/files/:id/thumbnail/confirm  { key? }   (no key = the original upload's canonical thumbnail key)
export async function thumbnailConfirm({ request, env, db, params, admin }) {
  const f = await getFile(db, admin, params.id);
  const b = await readJson(request);
  const canonical = OBJECT_KEYS.thumb(f.event_id, f.id);
  let key = canonical;
  if (b.key !== undefined && b.key !== null) {
    const ok = typeof b.key === 'string' && b.key.startsWith(`events/${f.event_id}/thumbs/${f.id}-`) &&
      /^events\/[0-9a-f-]{36}\/thumbs\/[0-9a-f-]{36}-[0-9a-f]{8}\.jpg$/.test(b.key);
    if (!ok) throw new ApiError(400, 'VALIDATION_ERROR', 'key is not valid for this file');
    key = b.key;
  }
  const h = await env.BUCKET.head(key);
  if (!h || h.size === 0 || h.size > LIMITS.MAX_THUMB_BYTES) {
    if (h) await env.BUCKET.delete(key);
    throw new ApiError(409, 'THUMBNAIL_MISSING', `Thumbnail not found or larger than ${LIMITS.MAX_THUMB_BYTES} bytes`);
  }
  await db.update('media_files', { id: `eq.${f.id}` }, { thumbnail_key: key });
  // the thumbnail it replaces is no longer referenced
  if (f.thumbnail_key && f.thumbnail_key !== key) {
    try { await env.BUCKET.delete(f.thumbnail_key); } catch { /* harmless leftover, removed with the event */ }
  }
  return { file_id: f.id, thumbnail_key: key };
}

// GET /admin/files/:id/source  ->  { url }  Short-lived link to the original, so the admin can scrub a video to pick a thumbnail.
export async function sourceUrl({ env, db, params, admin }) {
  const f = await getFile(db, admin, params.id);
  if (f.status !== 'ready') throw new ApiError(409, 'NOT_READY', 'This upload has not finished');
  return { url: await presign(env, 'GET', f.object_key, { expires: 3600 }), media_type: f.media_type };
}
