// cloudflare/worker/renamer.js
// Stores the convention name (Event_Folder_YYYY-MM-DD-HH-MM-SS.ext, see names.js) on the files of an event.
// Called when: an event is renamed, a folder is renamed, files are moved to another folder, and when the host presses
// "Apply to all files" (this also names files uploaded before the convention existed).
// A file the host renamed by hand (name_is_custom) is never touched. Two files that would get the same name in the same
// folder get -2, -3 ... in date order, so names inside a folder stay unique.
// scope: {} = every file of the event | { folderId } = files directly in that folder | { fileIds } = those files.
import { downloadName, withSuffix } from './names.js';

const BATCH = 500;
const when = (r) => Date.parse(r.taken_at || r.created_at) || 0;

export async function renameFiles(db, eventId, scope = {}) {
  const [ev] = await db.select('events', { select: 'id,title', id: `eq.${eventId}`, limit: 1 });
  if (!ev) return 0;
  const folders = new Map((await db.select('media_folders', { select: 'id,name', event_id: `eq.${eventId}`, deleted_at: 'is.null', limit: 5000 })).map((f) => [f.id, f.name]));
  const rows = (await db.select('media_files', { select: 'id,folder_id,original_filename,mime_type,taken_at,created_at,name_is_custom,name_applied', event_id: `eq.${eventId}`, status: 'in.(ready,uploading)', limit: 10000 }))
    .filter((r) => !r.name_is_custom)
    .sort((a, b) => when(a) - when(b) || (a.id < b.id ? -1 : 1));
  const ids = scope.fileIds ? new Set(scope.fileIds) : null;
  const taken = new Map();                 // folder + name -> how many files already have it
  const updates = [];
  for (const r of rows) {
    const base = downloadName({ event: ev.title, folder: r.folder_id ? folders.get(r.folder_id) : null, file: { ...r, name_applied: false } });
    const key = `${r.folder_id || ''}\u0000${base.toLowerCase()}`;
    const n = (taken.get(key) || 0) + 1;
    taken.set(key, n);
    const inScope = ids ? ids.has(r.id) : scope.folderId ? r.folder_id === scope.folderId : true;
    const name = withSuffix(base, n);
    if (inScope && (!r.name_applied || name !== r.original_filename)) updates.push({ id: r.id, name });
  }
  let renamed = 0;
  for (let i = 0; i < updates.length; i += BATCH) {
    const n = await db.rpc('apply_file_names', { p_event: eventId, p_updates: updates.slice(i, i + BATCH) });
    renamed += Number(n) || 0;
  }
  return renamed;
}

// Never lets a failed rename break the action that triggered it (the title, folder or move itself already succeeded).
export async function renameQuietly(db, eventId, scope) {
  try { return await renameFiles(db, eventId, scope); } catch (e) { console.error('rename files failed', e && e.message); return 0; }
}

// The name for ONE new upload: the convention name, with -2, -3 ... if that name is already taken in the folder.
export async function nameForUpload(db, { eventId, ownerId, folderId, filename, mime, takenAt }) {
  try {
    const [ev] = await db.select('events', { select: 'title', id: `eq.${eventId}`, created_by: `eq.${ownerId}`, limit: 1 });
    if (!ev) return filename;
    let folder = null;
    if (folderId) { const [f] = await db.select('media_folders', { select: 'name', id: `eq.${folderId}`, event_id: `eq.${eventId}`, limit: 1 }); folder = f ? f.name : null; }
    const base = downloadName({ event: ev.title, folder, file: { original_filename: filename, mime_type: mime, taken_at: takenAt, created_at: new Date().toISOString() } });
    const cand = Array.from({ length: 30 }, (_, i) => withSuffix(base, i + 1));
    const used = await db.select('media_files', { select: 'original_filename', event_id: `eq.${eventId}`, folder_id: folderId ? `eq.${folderId}` : 'is.null', deleted_at: 'is.null', original_filename: `in.(${cand.map((c) => `"${c.replace(/"/g, '')}"`).join(',')})`, limit: 60 });
    const taken = new Set(used.map((u) => u.original_filename));
    return cand.find((c) => !taken.has(c)) || `${base.replace(/(\.[^.]*)?$/, '')}-${crypto.randomUUID().slice(0, 4)}${/(\.[^.]*)?$/.exec(base)[0] || ''}`;
  } catch (e) { console.error('upload name failed', e && e.message); return filename; }
}
