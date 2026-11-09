// cloudflare/worker/uploads.js
// Upload authorization. Bytes never pass through the Worker: the browser PUTs straight to R2.
import { ApiError, v, readJson, created } from './utils.js';
import { LIMITS, OBJECT_KEYS } from './config.js';
import { presign, listParts } from './r2.js';
import { shapeFile } from './media.js';
import { purgeFiles } from './storage.js';

const EXT = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  heic: 'image/heic', heif: 'image/heif', avif: 'image/avif', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  mkv: 'video/x-matroska', avi: 'video/x-msvideo', '3gp': 'video/3gpp',
};

function detectMime(input, filename) {
  const m = typeof input === 'string' ? input.toLowerCase().trim() : '';
  if (m === 'image/svg+xml') return null; // active content, never accepted
  if (m.startsWith('image/') || m.startsWith('video/')) return m;
  return EXT[filename.split('.').pop().toLowerCase()] || null;
}

const mb = (n) => `${Math.round(n / 1048576)} MB`;

async function getSession(db, id) {
  const [s] = await db.select('upload_sessions', { select: '*', id: `eq.${v.uuid(id, 'session_id')}`, limit: 1 });
  if (!s) throw new ApiError(404, 'SESSION_NOT_FOUND', 'Upload session not found');
  return s;
}

function assertUsable(s) {
  if (s.status === 'aborted' || s.status === 'expired' || Date.parse(s.expires_at) < Date.now()) {
    throw new ApiError(410, 'UPLOAD_EXPIRED', 'This upload session has expired. Start the upload again.');
  }
}

const totalParts = (s) => Math.ceil(Number(s.size_bytes) / s.part_size);

export async function authorize({ request, env, db, admin }) {
  const b = await readJson(request);
  const eventId = v.uuid(b.event_id, 'event_id');
  const folderId = v.uuid(b.folder_id, 'folder_id', { optional: true });
  const filename = v.str(b.filename, 'filename', { max: 255 }).replace(/[\u0000-\u001f\u007f/\\]/g, '_');
  const size = v.int(b.size_bytes, 'size_bytes', { min: 1 });
  const width = v.int(b.width, 'width', { min: 1, max: 100000, optional: true });
  const height = v.int(b.height, 'height', { min: 1, max: 100000, optional: true });
  const duration = v.num(b.duration_seconds, 'duration_seconds', { min: 0, max: 86400 * 3, optional: true });

  const mime = detectMime(b.mime_type, filename);
  if (!mime) throw new ApiError(415, 'UNSUPPORTED_MEDIA', 'Only photo and video files are supported');
  const mediaType = mime.startsWith('video/') ? 'video' : 'photo';
  const max = mediaType === 'video' ? LIMITS.MAX_VIDEO_BYTES : LIMITS.MAX_IMAGE_BYTES;
  if (size > max) {
    throw new ApiError(413, 'FILE_TOO_LARGE',
      `${mediaType === 'video' ? 'Videos' : 'Photos'} can be at most ${mb(max)}`, { max_bytes: max });
  }

  const [ev] = await db.select('events', { select: 'id,deleted_at', id: `eq.${eventId}`, limit: 1 });
  if (!ev) throw new ApiError(404, 'EVENT_NOT_FOUND', 'Event not found');
  if (ev.deleted_at) throw new ApiError(409, 'EVENT_DELETED', 'Restore this event before uploading');
  if (folderId) {
    const [f] = await db.select('media_folders', { select: 'id', id: `eq.${folderId}`, event_id: `eq.${eventId}`, limit: 1 });
    if (!f) throw new ApiError(404, 'FOLDER_NOT_FOUND', 'Folder not found in this event');
  }

  const fileId = crypto.randomUUID();
  const objectKey = OBJECT_KEYS.original(eventId, fileId);
  const multipart = size > LIMITS.SINGLE_PUT_MAX;
  const expiresAt = new Date(Date.now() + LIMITS.UPLOAD_SESSION_TTL_MS).toISOString();

  await db.insert('media_files', {
    id: fileId, event_id: eventId, folder_id: folderId, original_filename: filename, object_key: objectKey,
    media_type: mediaType, mime_type: mime, size_bytes: size, width, height, duration_seconds: duration, status: 'uploading',
  });

  let uploadId = null;
  let session;
  try {
    if (multipart) {
      const mp = await env.BUCKET.createMultipartUpload(objectKey, { httpMetadata: { contentType: mime } });
      uploadId = mp.uploadId;
    }
    [session] = await db.insert('upload_sessions', {
      event_id: eventId, folder_id: folderId, file_id: fileId, r2_upload_id: uploadId,
      part_size: multipart ? LIMITS.PART_SIZE : null, original_filename: filename, mime_type: mime,
      size_bytes: size, status: 'pending', expires_at: expiresAt, created_by: admin.id,
    });
  } catch (err) {
    if (uploadId) { try { await env.BUCKET.resumeMultipartUpload(objectKey, uploadId).abort(); } catch { /* ignore */ } }
    await db.remove('media_files', { id: `eq.${fileId}` }).catch(() => {});
    throw err;
  }

  const out = {
    file_id: fileId,
    session_id: session.id,
    mode: multipart ? 'multipart' : 'single',
    expires_at: expiresAt,
    thumbnail_upload_url: await presign(env, 'PUT', OBJECT_KEYS.thumb(eventId, fileId), { expires: LIMITS.UPLOAD_URL_SECONDS }),
    thumbnail_content_type: 'image/jpeg',
    content_type: mime,
  };
  if (multipart) {
    out.part_size = LIMITS.PART_SIZE;
    out.total_parts = Math.ceil(size / LIMITS.PART_SIZE);
  } else {
    out.upload_url = await presign(env, 'PUT', objectKey, { expires: LIMITS.UPLOAD_URL_SECONDS });
  }
  return created(out);
}

// POST /admin/upload/parts  { session_id, part_numbers: [1,2,3...] (max 50) }
export async function parts({ request, env, db }) {
  const b = await readJson(request);
  const s = await getSession(db, b.session_id);
  if (!s.r2_upload_id) throw new ApiError(400, 'NOT_MULTIPART', 'This upload is not multipart');
  assertUsable(s);
  if (s.status === 'completed') throw new ApiError(409, 'ALREADY_COMPLETED', 'Upload already completed');
  const total = totalParts(s);
  if (!Array.isArray(b.part_numbers) || b.part_numbers.length < 1 || b.part_numbers.length > 50) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'part_numbers must contain 1 to 50 numbers');
  }
  const key = OBJECT_KEYS.original(s.event_id, s.file_id);
  const out = [];
  for (const n of [...new Set(b.part_numbers)]) {
    v.int(n, 'part_numbers[]', { min: 1, max: total });
    out.push({
      part_number: n,
      url: await presign(env, 'PUT', key, { expires: LIMITS.UPLOAD_URL_SECONDS, query: { partNumber: String(n), uploadId: s.r2_upload_id } }),
    });
  }
  if (s.status === 'pending') await db.update('upload_sessions', { id: `eq.${s.id}` }, { status: 'uploading' });
  return { parts: out, expires_in: LIMITS.UPLOAD_URL_SECONDS };
}

// GET /admin/upload/status?session_id=   (used to resume after an interruption)
export async function status({ env, db, url }) {
  const s = await getSession(db, url.searchParams.get('session_id'));
  if (s.status === 'completed') return { status: 'completed', file_id: s.file_id };
  assertUsable(s);
  const key = OBJECT_KEYS.original(s.event_id, s.file_id);
  const out = {
    status: s.status,
    file_id: s.file_id,
    mode: s.r2_upload_id ? 'multipart' : 'single',
    expires_at: s.expires_at,
    thumbnail_upload_url: await presign(env, 'PUT', OBJECT_KEYS.thumb(s.event_id, s.file_id), { expires: LIMITS.UPLOAD_URL_SECONDS }),
  };
  if (s.r2_upload_id) {
    out.part_size = s.part_size;
    out.total_parts = totalParts(s);
    out.uploaded_parts = (await listParts(env, key, s.r2_upload_id)).map((p) => ({ part_number: p.partNumber, size: p.size }));
  } else {
    out.upload_url = await presign(env, 'PUT', key, { expires: LIMITS.UPLOAD_URL_SECONDS });
  }
  return out;
}

// POST /admin/upload/complete  { session_id }   Idempotent. Verifies the object really exists with the declared size.
export async function complete({ request, env, db }) {
  const b = await readJson(request);
  const s = await getSession(db, b.session_id);
  const [file] = await db.select('media_files', { select: '*', id: `eq.${s.file_id}`, limit: 1 });
  if (!file) throw new ApiError(404, 'FILE_NOT_FOUND', 'File record not found');
  if (s.status === 'completed' && file.status === 'ready') return { file: await shapeFile(env, file, true) };
  assertUsable(s);

  const key = file.object_key;
  let head = await env.BUCKET.head(key);

  if (!head && s.r2_upload_id) {
    const total = totalParts(s);
    const lastSize = Number(s.size_bytes) - s.part_size * (total - 1);
    const uploaded = await listParts(env, key, s.r2_upload_id);
    const byNum = new Map(uploaded.map((p) => [p.partNumber, p]));
    const missing = [];
    for (let n = 1; n <= total; n++) {
      const p = byNum.get(n);
      const want = n < total ? s.part_size : lastSize;
      if (!p || p.size !== want) missing.push(n);
    }
    if (missing.length) {
      throw new ApiError(409, 'UPLOAD_INCOMPLETE', 'Some parts are missing or have the wrong size', { missing_parts: missing });
    }
    const ordered = [];
    for (let n = 1; n <= total; n++) ordered.push({ partNumber: n, etag: byNum.get(n).etag });
    await env.BUCKET.resumeMultipartUpload(key, s.r2_upload_id).complete(ordered);
    head = await env.BUCKET.head(key);
  }
  if (!head) throw new ApiError(409, 'UPLOAD_INCOMPLETE', 'The file has not reached storage yet');

  if (head.size !== Number(s.size_bytes)) {
    await env.BUCKET.delete(key);
    throw new ApiError(409, 'SIZE_MISMATCH', 'Stored size differs from the declared size. Upload the file again.',
      { expected: Number(s.size_bytes), actual: head.size });
  }

  // thumbnail is optional; accept it only if it exists and is small enough
  let thumbnailKey = null;
  const tkey = OBJECT_KEYS.thumb(file.event_id, file.id);
  const th = await env.BUCKET.head(tkey);
  if (th) {
    if (th.size > 0 && th.size <= LIMITS.MAX_THUMB_BYTES) thumbnailKey = tkey;
    else await env.BUCKET.delete(tkey);
  }

  const [row] = await db.update('media_files', { id: `eq.${file.id}` }, { status: 'ready', thumbnail_key: thumbnailKey });
  await db.update('upload_sessions', { id: `eq.${s.id}` }, { status: 'completed' });
  return { file: await shapeFile(env, row, true) };
}

// POST /admin/upload/abort  { session_id }   Cancels and removes everything stored so far.
export async function abort({ request, env, db }) {
  const b = await readJson(request);
  const s = await getSession(db, b.session_id);
  if (s.status === 'completed') throw new ApiError(409, 'ALREADY_COMPLETED', 'Upload already completed. Delete the file instead.');
  const files = await db.select('media_files', { select: 'id,event_id,object_key,thumbnail_key', id: `eq.${s.file_id}` });
  await purgeFiles(env, db, files);
  await db.remove('media_files', { id: `eq.${s.file_id}` }); // cascades the session
  return { aborted: true };
}
