// cloudflare/worker/uploads.js
// Upload authorization. Bytes never pass through the Worker: the browser PUTs straight to R2.
import { nameForUpload } from './renamer.js';
import { ApiError, v, readJson, created } from './utils.js';
import { LIMITS, OBJECT_KEYS } from './config.js';
import { presign, listParts } from './r2.js';
import { shapeFile } from './media.js';
import { purgeFiles } from './storage.js';
import { ownedSession, ownedEvent, ownedFolder } from './owner.js';

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
const gb = (n) => `${(n / 1073741824).toFixed(n < 1073741824 * 10 ? 1 : 0)} GB`;

function reserveError(r) {
  switch (r && r.reason) {
    case 'quota': {
      const bin = Number(r.bin_bytes) || 0;
      const msg = bin > 0
        ? `Your storage is full (${gb(r.used)} of ${gb(r.quota)}). Empty your recycle bin to free ${mb(bin)}, or delete files you no longer need.`
        : `Your storage is full (${gb(r.used)} of ${gb(r.quota)}). Delete files you no longer need.`;
      return new ApiError(413, 'QUOTA_EXCEEDED', msg, { used_bytes: Number(r.used), quota_bytes: Number(r.quota), bin_bytes: bin });
    }
    case 'event_not_found': return new ApiError(404, 'EVENT_NOT_FOUND', 'Event not found');
    case 'event_deleted': return new ApiError(409, 'EVENT_DELETED', 'Restore this event before uploading');
    case 'folder_not_found': return new ApiError(404, 'FOLDER_NOT_FOUND', 'Folder not found in this event');
    case 'rate': return new ApiError(429, 'RATE_LIMITED', 'You are uploading too fast. Wait a minute and try again.', { retry_after: 60 });
    default: return new ApiError(403, 'NOT_ALLOWED', 'This account cannot upload right now');
  }
}

// Date taken, as read by the browser from the photo's EXIF or the video's header. Anything that is not a plausible date is ignored
// (the file then sorts by its upload time).
function parseTaken(x) {
  if (typeof x !== 'string') return null;
  const t = Date.parse(x);
  if (Number.isNaN(t) || t < Date.UTC(1990, 0, 1) || t > Date.now() + 2 * 86400000) return null;
  return new Date(t).toISOString();
}
const parseHash = (x) => (typeof x === 'string' && /^[0-9a-f]{64}$/.test(x) ? x : null);

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
  const takenAt = parseTaken(b.taken_at);

  const mime = detectMime(b.mime_type, filename);
  if (!mime) throw new ApiError(415, 'UNSUPPORTED_MEDIA', 'Only photo and video files are supported');
  const mediaType = mime.startsWith('video/') ? 'video' : 'photo';
  const hash = mediaType === 'photo' ? parseHash(b.content_hash) : null;
  const max = mediaType === 'video' ? LIMITS.MAX_VIDEO_BYTES : LIMITS.MAX_IMAGE_BYTES;
  if (size > max) {
    throw new ApiError(413, 'FILE_TOO_LARGE',
      `${mediaType === 'video' ? 'Videos' : 'Photos'} can be at most ${mb(max)}`, { max_bytes: max });
  }

  const storedName = await nameForUpload(db, { eventId, ownerId: admin.id, folderId, filename, mime, takenAt });   // Event_Folder_time.ext
  const fileId = crypto.randomUUID();
  const objectKey = OBJECT_KEYS.original(eventId, fileId);
  const multipart = size > LIMITS.SINGLE_PUT_MAX;
  const expiresAt = new Date(Date.now() + LIMITS.UPLOAD_SESSION_TTL_MS).toISOString();

  // One atomic step in the database: checks the host owns the event, the account is active, the rate limit,
  // and that the host's storage (stored files + recycle bin + uploads in progress) stays within the quota.
  // On success the space is reserved right now, so two uploads at once cannot slip past the cap.
  const r = await db.rpc('reserve_upload', {
    p_user: admin.id, p_event: eventId, p_folder: folderId, p_file_id: fileId, p_filename: storedName, p_key: objectKey,
    p_media_type: mediaType, p_mime: mime, p_size: size, p_width: width, p_height: height, p_duration: duration,
    p_per_minute: LIMITS.UPLOADS_PER_MINUTE, p_taken: takenAt, p_hash: hash,
  });
  if (!r || !r.ok) throw reserveError(r);
  // keep the camera name for the duplicate warning, and mark the convention name as stored (best effort: the upload does not depend on it)
  if (storedName !== filename) await db.update('media_files', { id: `eq.${fileId}` }, { source_filename: filename, name_applied: true }).catch((e) => console.error('source name failed', e && e.message));
  else await db.update('media_files', { id: `eq.${fileId}` }, { source_filename: filename }).catch(() => {});

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
export async function parts({ request, env, db, admin }) {
  const b = await readJson(request);
  const s = await ownedSession(db, admin, b.session_id);
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
export async function status({ env, db, url, admin }) {
  const s = await ownedSession(db, admin, url.searchParams.get('session_id'));
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
export async function complete({ request, env, db, admin }) {
  const b = await readJson(request);
  const s = await ownedSession(db, admin, b.session_id);
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
export async function abort({ request, env, db, admin }) {
  const b = await readJson(request);
  const s = await ownedSession(db, admin, b.session_id);
  if (s.status === 'completed') throw new ApiError(409, 'ALREADY_COMPLETED', 'Upload already completed. Delete the file instead.');
  const files = await db.select('media_files', { select: 'id,event_id,object_key,thumbnail_key', id: `eq.${s.file_id}` });
  await purgeFiles(env, db, files);
  await db.remove('media_files', { id: `eq.${s.file_id}` }); // cascades the session
  return { aborted: true };
}

// POST /admin/upload/check  { event_id, folder_id?, files: [{ name, size, hash? }] (max 100) }
// Duplicate warning. It compares ONLY inside the place the files are going to: the chosen folder, or the event's top level when
// no folder is chosen. Subfolders and other folders are not looked at.
//   "same_name_size": a file with the same name and size is already there (quick check, used for all files).
//   "same_content":   a photo with identical bytes (SHA-256) is already there (photos only; large videos use the quick check).
export async function check({ request, db, admin }) {
  const b = await readJson(request);
  const eventId = (await ownedEvent(db, admin, b.event_id)).id;
  const folderId = v.uuid(b.folder_id, 'folder_id', { optional: true });
  if (folderId) {
    const f = await ownedFolder(db, admin, folderId);
    if (f.event_id !== eventId) throw new ApiError(404, 'FOLDER_NOT_FOUND', 'Folder not found in this event');
  }
  if (!Array.isArray(b.files) || b.files.length < 1 || b.files.length > 100) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'files must contain 1 to 100 items');
  }
  const files = b.files.map((f, i) => ({
    i, name: v.str(f && f.name, 'name', { max: 255 }), size: v.int(f && f.size, 'size', { min: 1 }), hash: parseHash(f && f.hash),
  }));
  const scope = { event_id: `eq.${eventId}`, folder_id: folderId ? `eq.${folderId}` : 'is.null', deleted_at: 'is.null', status: 'in.(ready,uploading)' };
  const sizes = [...new Set(files.map((f) => f.size))];
  const hashes = [...new Set(files.map((f) => f.hash).filter(Boolean))];
  const bySize = new Map();
  for (let k = 0; k < sizes.length; k += 100) {
    const rows = await db.select('media_files', { select: 'original_filename,source_filename,size_bytes', ...scope, size_bytes: `in.(${sizes.slice(k, k + 100).join(',')})` });
    for (const r of rows) bySize.set(`${r.source_filename || r.original_filename}\u0000${r.size_bytes}`, r.source_filename || r.original_filename);
  }
  const byHash = new Map();
  for (let k = 0; k < hashes.length; k += 100) {
    const rows = await db.select('media_files', { select: 'original_filename,source_filename,content_hash', ...scope, content_hash: `in.(${hashes.slice(k, k + 100).join(',')})` });
    for (const r of rows) byHash.set(r.content_hash, r.source_filename || r.original_filename);
  }
  return {
    results: files.map((f) => {
      if (f.hash && byHash.has(f.hash)) return { index: f.i, duplicate: 'same_content', existing_filename: byHash.get(f.hash) };
      const n = bySize.get(`${f.name}\u0000${f.size}`);
      return n ? { index: f.i, duplicate: 'same_name_size', existing_filename: n } : { index: f.i, duplicate: null };
    }),
  };
}
