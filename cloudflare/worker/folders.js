// cloudflare/worker/folders.js
// Administrator folder management and event contents listing.
import { renameQuietly } from './renamer.js';
import { ApiError, v, readJson, created, chunk } from './utils.js';
import { LIMITS } from './config.js';
import { parseListParams, queryFiles, shapeFile, shapeFolderCards } from './media.js';
import { ownedEvent, ownedActiveEvent, ownedFolder } from './owner.js';

const NAME_RE = /[\u0000-\u001f\u007f/\\]/;
const folderName = (x) => {
  const n = v.str(x, 'name', { max: 150 });
  if (NAME_RE.test(n)) throw new ApiError(400, 'VALIDATION_ERROR', 'name contains invalid characters');
  return n;
};

async function depthOf(db, folderId) {
  if (!folderId) return 0;
  const crumbs = await db.rpc('folder_breadcrumb', { p_folder: folderId });
  return crumbs.length;
}

export async function create({ request, db, admin }) {
  const b = await readJson(request);
  const eventId = v.uuid(b.event_id, 'event_id');
  const parentId = v.uuid(b.parent_id, 'parent_id', { optional: true });
  const name = folderName(b.name);
  await ownedActiveEvent(db, admin, eventId);
  if (parentId) {
    const parent = await ownedFolder(db, admin, parentId);
    if (parent.event_id !== eventId) throw new ApiError(400, 'VALIDATION_ERROR', 'parent_id belongs to another event');
    if ((await depthOf(db, parentId)) >= LIMITS.MAX_FOLDER_DEPTH) {
      throw new ApiError(400, 'MAX_DEPTH', `Folders can be nested at most ${LIMITS.MAX_FOLDER_DEPTH} levels deep`);
    }
  }
  const [row] = await db.insert('media_folders', { event_id: eventId, parent_id: parentId, name });
  return created({ folder: row });
}

export async function update({ request, db, params, admin }) {
  const cur = await ownedFolder(db, admin, params.id);
  await ownedActiveEvent(db, admin, cur.event_id);
  const b = await readJson(request);
  const patch = {};
  if ('name' in b) patch.name = folderName(b.name);
  if ('parent_id' in b) {
    const np = v.uuid(b.parent_id, 'parent_id', { optional: true });
    if (np) {
      const target = await ownedFolder(db, admin, np);
      if (target.event_id !== cur.event_id) throw new ApiError(400, 'VALIDATION_ERROR', 'Cannot move a folder to another event');
      const subtree = await db.rpc('folder_subtree', { p_folder: cur.id });
      if (subtree.includes(np)) throw new ApiError(400, 'VALIDATION_ERROR', 'Cannot move a folder into itself or its own subfolder');
      if ((await depthOf(db, np)) >= LIMITS.MAX_FOLDER_DEPTH) throw new ApiError(400, 'MAX_DEPTH', 'Folder nesting limit reached');
    }
    patch.parent_id = np;
  }
  if ('cover_mode' in b) patch.cover_mode = v.oneOf(b.cover_mode, 'cover_mode', ['auto', 'manual']);
  if ('cover_file_id' in b) {
    const fid = v.uuid(b.cover_file_id, 'cover_file_id', { optional: true });
    if (fid) {
      const subtree = await db.rpc('folder_subtree', { p_folder: cur.id });
      const [f] = await db.select('media_files', { select: 'id,folder_id', id: `eq.${fid}`, status: 'eq.ready', deleted_at: 'is.null', limit: 1 });
      if (!f || !subtree.includes(f.folder_id)) {
        throw new ApiError(400, 'VALIDATION_ERROR', 'cover_file_id must be a finished file inside this folder');
      }
    }
    patch.cover_file_id = fid;
  }
  if ('cover_pos_x' in b) patch.cover_pos_x = v.num(b.cover_pos_x, 'cover_pos_x', { min: 0, max: 100 });
  if ('cover_pos_y' in b) patch.cover_pos_y = v.num(b.cover_pos_y, 'cover_pos_y', { min: 0, max: 100 });
  if (patch.cover_file_id && patch.cover_file_id !== cur.cover_file_id) {
    if (!('cover_pos_x' in patch)) patch.cover_pos_x = 50;
    if (!('cover_pos_y' in patch)) patch.cover_pos_y = 50;
  }
  const mode = patch.cover_mode ?? cur.cover_mode;
  const cover = 'cover_file_id' in patch ? patch.cover_file_id : cur.cover_file_id;
  if (mode === 'manual' && !cover) throw new ApiError(400, 'VALIDATION_ERROR', 'Choose a cover file for manual cover mode');
  if (!Object.keys(patch).length) throw new ApiError(400, 'VALIDATION_ERROR', 'Nothing to update');
  const [row] = await db.update('media_folders', { id: `eq.${cur.id}` }, patch);
  if (patch.name && patch.name !== cur.name) await renameQuietly(db, cur.event_id, { folderId: cur.id });   // the folder name is part of its files' names
  return { folder: row };
}

// Move the folder to the recycle bin. The folder, its subfolders and the files inside become ONE bin item
// (bin_group = this folder's id) with one 2-day timer, and are restored as a whole. Items that were already in the
// bin keep their own timer. Nothing is removed from storage yet, so the space still counts toward the host's quota.
export async function remove({ db, params, admin }) {
  const cur = await ownedFolder(db, admin, params.id);
  await ownedActiveEvent(db, admin, cur.event_id);
  const folderIds = await db.rpc('folder_subtree', { p_folder: cur.id });
  const now = Date.now();
  const bin = { deleted_at: new Date(now).toISOString(), purge_after: new Date(now + LIMITS.DELETE_GRACE_MS).toISOString(), bin_group: cur.id };
  let files = 0;
  for (const ids of chunk(folderIds, 100)) {
    await db.update('media_folders', { id: `in.(${ids.join(',')})`, deleted_at: 'is.null' }, bin);
    const moved = await db.update('media_files', { folder_id: `in.(${ids.join(',')})`, deleted_at: 'is.null' }, bin);
    files += moved.length;
  }
  return { deleted_folder_id: cur.id, deleted_files: files, moved_to_bin: true };
}

// GET /admin/events/:id/contents?folder_id=&status=&q=&type=&sort=&limit=&offset=&scope=event
export async function contents({ env, db, params, url, admin }) {
  const eventId = (await ownedEvent(db, admin, params.id)).id;
  const folderId = v.uuid(url.searchParams.get('folder_id'), 'folder_id', { optional: true });
  let current = null;
  let breadcrumbs = [];
  if (folderId) {
    current = await ownedFolder(db, admin, folderId);
    if (current.event_id !== eventId) throw new ApiError(404, 'FOLDER_NOT_FOUND', 'Folder not found');
    breadcrumbs = (await db.rpc('folder_breadcrumb', { p_folder: folderId })).map((c) => ({ id: c.id, name: c.name }));
  }
  const cards = await db.rpc('folder_cards', { p_event: eventId, p_parent: folderId, p_hide_empty: false });
  const p = parseListParams(url.searchParams);
  const { rows, total } = await queryFiles(db, { eventId, folderId, p });
  const items = await Promise.all(rows.map((r) => shapeFile(env, r, true)));
  return {
    current: current ? { id: current.id, name: current.name, parent_id: current.parent_id } : null,
    breadcrumbs,
    folders: await shapeFolderCards(env, db, cards, true),
    files: { items, total, limit: p.limit, offset: p.offset, has_more: p.offset + items.length < total },
  };
}
