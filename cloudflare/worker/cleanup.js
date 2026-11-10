// cloudflare/worker/cleanup.js
// Hourly: permanent deletion after the 2-day recycle bin period (events, folders, files), and abandoned upload cleanup.
// Everything here is idempotent: a failed run is simply retried on the next tick.
import { OBJECT_KEYS } from './config.js';
import { purgeFiles, hardDeleteFolder, hardDeleteFiles } from './storage.js';
import { chunk } from './utils.js';

const MAX_ATTEMPTS = 10;
const MAX_BATCHES_PER_RUN = 20; // 20 x 1000 objects per event per run, the rest continues next run

export async function purgeEvent(env, db, eventId) {
  const nowIso = new Date().toISOString();
  const [e] = await db.select('events', {
    select: 'id', id: `eq.${eventId}`, deleted_at: 'not.is.null', purge_after: `lte.${nowIso}`, limit: 1,
  });
  if (!e) return 'skipped';

  // 1. abort unfinished multipart uploads
  const sessions = await db.select('upload_sessions', {
    select: 'file_id,r2_upload_id', event_id: `eq.${eventId}`, r2_upload_id: 'not.is.null', status: 'in.(pending,uploading)',
  });
  for (const s of sessions) {
    try { await env.BUCKET.resumeMultipartUpload(OBJECT_KEYS.original(eventId, s.file_id), s.r2_upload_id).abort(); } catch { /* already gone */ }
  }

  // 2. delete every object under the event prefix (originals + thumbnails)
  for (let i = 0; i < MAX_BATCHES_PER_RUN; i++) {
    const page = await env.BUCKET.list({ prefix: OBJECT_KEYS.prefix(eventId), limit: 1000 });
    if (!page.objects.length) {
      // 3. storage is empty: remove database records (folders, files, sessions cascade)
      await db.remove('events', { id: `eq.${eventId}`, deleted_at: 'not.is.null' });
      return 'purged';
    }
    await env.BUCKET.delete(page.objects.map((o) => o.key));
  }
  return 'partial';
}

export async function purgeExpiredEvents(env, db, max = 3) {
  const nowIso = new Date().toISOString();
  const due = await db.select('events', {
    select: 'id,purge_attempts', deleted_at: 'not.is.null', purge_after: `lte.${nowIso}`,
    purge_attempts: `lt.${MAX_ATTEMPTS}`, order: 'purge_after.asc', limit: max,
  });
  const results = [];
  for (const e of due) {
    try {
      results.push({ id: e.id, result: await purgeEvent(env, db, e.id) });
    } catch (err) {
      console.error('purge failed', e.id, err && err.message);
      await db.update('events', { id: `eq.${e.id}` }, {
        purge_attempts: e.purge_attempts + 1, purge_last_error: String((err && err.message) || err).slice(0, 500),
      }).catch(() => {});
      results.push({ id: e.id, result: 'error' });
    }
  }
  return results;
}

export async function cleanupExpiredUploads(env, db) {
  const nowIso = new Date().toISOString();
  const sessions = await db.select('upload_sessions', {
    select: 'id,file_id', status: 'in.(pending,uploading)', expires_at: `lt.${nowIso}`, limit: 50,
  });
  if (!sessions.length) return 0;
  const fileIds = sessions.map((s) => s.file_id);
  const files = [];
  for (const ids of chunk(fileIds, 100)) {
    files.push(...await db.select('media_files', { select: 'id,event_id,object_key', id: `in.(${ids.join(',')})`, status: 'eq.uploading' }));
  }
  await purgeFiles(env, db, files);
  for (const ids of chunk(files.map((f) => f.id), 100)) {
    await db.remove('media_files', { id: `in.(${ids.join(',')})` }); // cascades the session rows
  }
  for (const ids of chunk(sessions.map((s) => s.id), 100)) {
    await db.update('upload_sessions', { id: `in.(${ids.join(',')})`, status: 'in.(pending,uploading)' }, { status: 'expired' });
  }
  return sessions.length;
}

// Files and folders whose own 2-day timer ran out. Files first, then folders (a folder takes any leftovers with it).
// Only items in LIVE events are handled here: an event in the bin is purged as a whole by purgeExpiredEvents.
export async function purgeExpiredBin(env, db, max = 100) {
  const nowIso = new Date().toISOString();
  const files = await db.select('media_files', {
    select: 'id,event_id,object_key,thumbnail_key', deleted_at: 'not.is.null', purge_after: `lte.${nowIso}`, limit: max,
  });
  const nf = await hardDeleteFiles(env, db, files);
  const folders = await db.select('media_folders', {
    select: 'id', deleted_at: 'not.is.null', purge_after: `lte.${nowIso}`, limit: 20,
  });
  let nd = 0;
  for (const f of folders) {
    try { await hardDeleteFolder(env, db, f.id); nd++; } catch (err) { console.error('folder purge failed', f.id, err && err.message); }
  }
  return { files: nf, folders: nd };
}
