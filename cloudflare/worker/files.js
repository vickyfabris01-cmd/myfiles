// cloudflare/worker/files.js
// Administrator media metadata: rename, move, delete, thumbnails.
import { ApiError, v, readJson, chunk } from './utils.js';
import { LIMITS, OBJECT_KEYS } from './config.js';
import { presign } from './r2.js';
import { purgeFiles } from './storage.js';

const COLS = 'id,event_id,folder_id,original_filename,object_key,status';

async function getFile(db, id) {
  const [f] = await db.select('media_files', { select: COLS, id: `eq.${v.uuid(id, 'id')}`, limit: 1 });
  if (!f) throw new ApiError(404, 'FILE_NOT_FOUND', 'File not found');
  return f;
}

async function assertFolderInEvent(db, folderId, eventId) {
  if (!folderId) return;
  const [f] = await db.select('media_folders', { select: 'id', id: `eq.${folderId}`, event_id: `eq.${eventId}`, limit: 1 });
  if (!f) throw new ApiError(400, 'VALIDATION_ERROR', 'folder_id does not belong to this event');
}

export async function update({ request, db, params }) {
  const cur = await getFile(db, params.id);
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

export async function remove({ env, db, params }) {
  const cur = await getFile(db, params.id);
  await purgeFiles(env, db, [cur]);
  await db.remove('media_files', { id: `eq.${cur.id}` });
  return { deleted_file_id: cur.id };
}

// POST /admin/files/bulk  { action: "move"|"delete", file_ids: [...up to 200], folder_id?: uuid|null }
export async function bulk({ request, env, db }) {
  const b = await readJson(request);
  const action = v.oneOf(b.action, 'action', ['move', 'delete']);
  if (!Array.isArray(b.file_ids) || b.file_ids.length < 1 || b.file_ids.length > 200) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'file_ids must contain 1 to 200 ids');
  }
  const ids = [...new Set(b.file_ids.map((i) => v.uuid(i, 'file_ids[]')))];
  const files = await db.select('media_files', { select: COLS, id: `in.(${ids.join(',')})` });
  if (files.length !== ids.length) throw new ApiError(404, 'FILE_NOT_FOUND', 'One or more files were not found');
  const events = new Set(files.map((f) => f.event_id));
  if (events.size > 1) throw new ApiError(400, 'VALIDATION_ERROR', 'All files must belong to the same event');
  if (action === 'move') {
    const folderId = v.uuid(b.folder_id, 'folder_id', { optional: true });
    await assertFolderInEvent(db, folderId, files[0].event_id);
    await db.update('media_files', { id: `in.(${ids.join(',')})` }, { folder_id: folderId });
    return { moved: ids.length };
  }
  await purgeFiles(env, db, files);
  await db.remove('media_files', { id: `in.(${ids.join(',')})` });
  return { deleted: ids.length };
}

// Fresh presigned PUT for a missing or regenerated thumbnail.
export async function thumbnailUrl({ env, db, params }) {
  const f = await getFile(db, params.id);
  return {
    upload_url: await presign(env, 'PUT', OBJECT_KEYS.thumb(f.event_id, f.id), { expires: LIMITS.UPLOAD_URL_SECONDS }),
    content_type: 'image/jpeg',
  };
}

export async function thumbnailConfirm({ env, db, params }) {
  const f = await getFile(db, params.id);
  const key = OBJECT_KEYS.thumb(f.event_id, f.id);
  const h = await env.BUCKET.head(key);
  if (!h || h.size === 0 || h.size > LIMITS.MAX_THUMB_BYTES) {
    if (h) await env.BUCKET.delete(key);
    throw new ApiError(409, 'THUMBNAIL_MISSING', `Thumbnail not found or larger than ${LIMITS.MAX_THUMB_BYTES} bytes`);
  }
  await db.update('media_files', { id: `eq.${f.id}` }, { thumbnail_key: key });
  return { file_id: f.id, thumbnail_key: key };
}
