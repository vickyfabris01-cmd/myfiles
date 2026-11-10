// cloudflare/worker/storage.js
// Shared R2 cleanup used by file delete, folder delete, aborted and expired uploads.
import { OBJECT_KEYS } from './config.js';
import { chunk } from './utils.js';

export async function deleteKeys(env, keys) {
  for (const part of chunk([...new Set(keys.filter(Boolean))], 1000)) {
    if (part.length) await env.BUCKET.delete(part);
  }
}

// files: rows with { id, event_id, object_key, thumbnail_key? }. Aborts open multipart uploads, then removes originals + thumbnails.
export async function purgeFiles(env, db, files) {
  if (!files.length) return;
  const byId = new Map(files.map((f) => [f.id, f]));
  for (const ids of chunk(files.map((f) => f.id), 100)) {
    const sessions = await db.select('upload_sessions', {
      select: 'file_id,r2_upload_id',
      file_id: `in.(${ids.join(',')})`,
      r2_upload_id: 'not.is.null',
      status: 'in.(pending,uploading)',
    });
    for (const s of sessions) {
      const f = byId.get(s.file_id);
      try { await env.BUCKET.resumeMultipartUpload(f.object_key, s.r2_upload_id).abort(); } catch { /* already gone */ }
    }
  }
  await deleteKeys(env, files.flatMap((f) => [f.object_key, OBJECT_KEYS.thumb(f.event_id, f.id), f.thumbnail_key]));
}

// Permanently delete a folder: every subfolder and every file in the whole subtree, database rows AND R2 objects.
// This includes files that were binned on their own earlier, because they cannot outlive their folder.
export async function hardDeleteFolder(env, db, folderId) {
  const folderIds = await db.rpc('folder_subtree', { p_folder: folderId });
  const files = [];
  for (const ids of chunk(folderIds, 100)) {
    files.push(...await db.select('media_files', { select: 'id,event_id,object_key,thumbnail_key', folder_id: `in.(${ids.join(',')})` }));
  }
  await purgeFiles(env, db, files);
  await db.remove('media_folders', { id: `eq.${folderId}` }); // cascades subfolders and file rows
  return files.length;
}

// Permanently delete specific files (R2 objects and rows).
export async function hardDeleteFiles(env, db, files) {
  if (!files.length) return 0;
  await purgeFiles(env, db, files);
  for (const ids of chunk(files.map((f) => f.id), 100)) await db.remove('media_files', { id: `in.(${ids.join(',')})` });
  return files.length;
}
