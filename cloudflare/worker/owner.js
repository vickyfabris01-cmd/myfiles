// cloudflare/worker/owner.js
// OWNERSHIP CHECKS. Every host route that touches an event, folder, file or upload session goes through one of these,
// so host A can never read, change, download or delete host B's data, by id or by guessing.
// A thing that belongs to someone else answers exactly like a thing that does not exist (404), so ids cannot be probed.
import { ApiError, v } from './utils.js';

export async function ownedEvent(db, user, eventId, cols = 'id,deleted_at') {
  const [e] = await db.select('events', { select: cols, id: `eq.${v.uuid(eventId, 'event_id')}`, created_by: `eq.${user.id}`, limit: 1 });
  if (!e) throw new ApiError(404, 'EVENT_NOT_FOUND', 'Event not found');
  return e;
}

export async function ownedActiveEvent(db, user, eventId, cols = 'id,deleted_at') {
  const e = await ownedEvent(db, user, eventId, cols.includes('deleted_at') ? cols : `${cols},deleted_at`);
  if (e.deleted_at) throw new ApiError(409, 'EVENT_DELETED', 'Restore this event before changing it');
  return e;
}

// A folder the caller owns (through its event). Binned folders are hidden unless allowDeleted.
export async function ownedFolder(db, user, folderId, { allowDeleted = false } = {}) {
  const [f] = await db.select('media_folders', { select: '*', id: `eq.${v.uuid(folderId, 'folder_id')}`, limit: 1 });
  if (!f) throw new ApiError(404, 'FOLDER_NOT_FOUND', 'Folder not found');
  try { await ownedEvent(db, user, f.event_id); } catch { throw new ApiError(404, 'FOLDER_NOT_FOUND', 'Folder not found'); }
  if (f.deleted_at && !allowDeleted) throw new ApiError(404, 'FOLDER_NOT_FOUND', 'Folder not found');
  return f;
}

// A file the caller owns (through its event). Binned files are hidden unless allowDeleted.
export async function ownedFile(db, user, fileId, cols = '*', { allowDeleted = false } = {}) {
  const need = ['event_id', 'deleted_at'].filter((c) => cols !== '*' && !cols.split(',').includes(c));
  const select = cols === '*' ? '*' : [cols, ...need].join(',');
  const [f] = await db.select('media_files', { select, id: `eq.${v.uuid(fileId, 'file_id')}`, limit: 1 });
  if (!f) throw new ApiError(404, 'FILE_NOT_FOUND', 'File not found');
  try { await ownedEvent(db, user, f.event_id); } catch { throw new ApiError(404, 'FILE_NOT_FOUND', 'File not found'); }
  if (f.deleted_at && !allowDeleted) throw new ApiError(404, 'FILE_NOT_FOUND', 'File not found');
  return f;
}

export async function ownedSession(db, user, sessionId, cols = '*') {
  const [s] = await db.select('upload_sessions', { select: cols, id: `eq.${v.uuid(sessionId, 'session_id')}`, created_by: `eq.${user.id}`, limit: 1 });
  if (!s) throw new ApiError(404, 'SESSION_NOT_FOUND', 'Upload session not found');
  return s;
}
