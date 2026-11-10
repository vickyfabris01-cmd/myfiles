// cloudflare/worker/bin.js
// Recycle bin (per host). Deleted events, folders and files are separate items, each with its own 2-day timer.
// Binned items still count toward the host's storage. A folder is restored as a whole (it is one bin item).
import { ApiError, v, readJson } from './utils.js';
import { LIMITS } from './config.js';
import { ownedEvent, ownedFolder, ownedFile } from './owner.js';
import { hardDeleteFolder, hardDeleteFiles } from './storage.js';
import { purgeEvent } from './cleanup.js';
import { restore as restoreEvent } from './events.js';

const KINDS = ['event', 'folder', 'file'];
const MAX_PER_CALL = 10; // keeps one request small; the page repeats "empty" until nothing is left
const num = (x) => Number(x) || 0;

const shape = (i) => ({
  kind: i.kind, id: i.id, name: i.name, event_id: i.event_id, event_title: i.event_title,
  blocked_by: i.blocked_by, size_bytes: num(i.size_bytes), file_count: num(i.file_count),
  deleted_at: i.deleted_at, purge_after: i.purge_after,
});

export async function list({ db, admin }) {
  const items = await db.rpc('bin_items', { p_user: admin.id });
  return { retention_days: Math.round(LIMITS.DELETE_GRACE_MS / 86400000), items: (items || []).map(shape) };
}

const expired = (x) => x.purge_after && Date.parse(x.purge_after) <= Date.now();

export async function restore({ request, env, db, admin }) {
  const b = await readJson(request);
  const kind = v.oneOf(b.kind, 'kind', KINDS);
  const id = v.uuid(b.id, 'id');

  if (kind === 'event') return restoreEvent({ env, db, params: { id }, admin });

  if (kind === 'folder') {
    const f = await ownedFolder(db, admin, id, { allowDeleted: true });
    if (!f.deleted_at || f.bin_group !== f.id) throw new ApiError(409, 'NOT_IN_BIN', 'This folder is not in the recycle bin');
    if (expired(f)) throw new ApiError(409, 'RECOVERY_EXPIRED', 'The 2-day recovery period has ended');
    const ev = await ownedEvent(db, admin, f.event_id);
    if (ev.deleted_at) throw new ApiError(409, 'RESTORE_PARENT_FIRST', 'Restore the event first', { blocked_by: 'event' });
    if (f.parent_id) {
      const [p] = await db.select('media_folders', { select: 'id,deleted_at', id: `eq.${f.parent_id}`, limit: 1 });
      if (p && p.deleted_at) throw new ApiError(409, 'RESTORE_PARENT_FIRST', 'Restore the folder it was in first', { blocked_by: 'folder' });
    }
    const back = { deleted_at: null, purge_after: null, bin_group: null };
    try {
      await db.update('media_folders', { bin_group: `eq.${f.id}` }, back);
    } catch (e) {
      if (e.code === 'CONFLICT') throw new ApiError(409, 'NAME_TAKEN', 'A folder with this name already exists in that place. Rename that one first, then restore.');
      throw e;
    }
    await db.update('media_files', { bin_group: `eq.${f.id}` }, back);
    return { restored: 'folder', id: f.id };
  }

  const f = await ownedFile(db, admin, id, '*', { allowDeleted: true });
  if (!f.deleted_at || f.bin_group) throw new ApiError(409, 'NOT_IN_BIN', 'This file is not in the recycle bin');
  if (expired(f)) throw new ApiError(409, 'RECOVERY_EXPIRED', 'The 2-day recovery period has ended');
  const ev = await ownedEvent(db, admin, f.event_id);
  if (ev.deleted_at) throw new ApiError(409, 'RESTORE_PARENT_FIRST', 'Restore the event first', { blocked_by: 'event' });
  if (f.folder_id) {
    const [p] = await db.select('media_folders', { select: 'id,deleted_at', id: `eq.${f.folder_id}`, limit: 1 });
    if (p && p.deleted_at) throw new ApiError(409, 'RESTORE_PARENT_FIRST', 'Restore the folder first', { blocked_by: 'folder' });
  }
  await db.update('media_files', { id: `eq.${f.id}` }, { deleted_at: null, purge_after: null });
  return { restored: 'file', id: f.id };
}

async function deleteOne(env, db, admin, kind, id) {
  if (kind === 'event') {
    const e = await ownedEvent(db, admin, id, 'id,deleted_at');
    if (!e.deleted_at) throw new ApiError(409, 'NOT_IN_BIN', 'This event is not in the recycle bin');
    // all its items, including ones binned separately, go with it and their storage is freed
    await db.update('events', { id: `eq.${e.id}`, created_by: `eq.${admin.id}` }, { purge_after: new Date(Date.now() - 1000).toISOString() });
    return purgeEvent(env, db, e.id); // 'purged' or 'partial' (the rest finishes on the next scheduled run)
  }
  if (kind === 'folder') {
    const f = await ownedFolder(db, admin, id, { allowDeleted: true });
    if (!f.deleted_at || f.bin_group !== f.id) throw new ApiError(409, 'NOT_IN_BIN', 'This folder is not in the recycle bin');
    await hardDeleteFolder(env, db, f.id);
    return 'purged';
  }
  const f = await ownedFile(db, admin, id, 'id,event_id,object_key,thumbnail_key,deleted_at,bin_group', { allowDeleted: true });
  if (!f.deleted_at || f.bin_group) throw new ApiError(409, 'NOT_IN_BIN', 'This file is not in the recycle bin');
  await hardDeleteFiles(env, db, [f]);
  return 'purged';
}

// POST /admin/bin/delete  { kind, id }   delete one item permanently
export async function deleteItem({ request, env, db, admin }) {
  const b = await readJson(request);
  const status = await deleteOne(env, db, admin, v.oneOf(b.kind, 'kind', KINDS), v.uuid(b.id, 'id'));
  return { deleted: true, status };
}

// POST /admin/bin/empty   Deletes up to a few items per call and reports how many remain; the page repeats until 0.
export async function empty({ env, db, admin }) {
  const items = await db.rpc('bin_items', { p_user: admin.id });
  const order = { event: 0, folder: 1, file: 2 };
  const todo = [...(items || [])].sort((a, b) => order[a.kind] - order[b.kind]).slice(0, MAX_PER_CALL);
  let done = 0;
  for (const i of todo) {
    try { await deleteOne(env, db, admin, i.kind, i.id); done++; } catch (e) { if (!(e instanceof ApiError && e.status === 404)) throw e; }
  }
  const remaining = await db.rpc('bin_items', { p_user: admin.id });
  return { deleted: done, remaining: (remaining || []).length };
}
