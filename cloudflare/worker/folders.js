// cloudflare/worker/folders.js
// Administrator folder management and event contents listing.
import { ApiError, v, readJson, created, chunk } from './utils.js';
import { LIMITS } from './config.js';
import { parseListParams, queryFiles, shapeFile, shapeFolderCards } from './media.js';
import { purgeFiles } from './storage.js';

const NAME_RE = /[\u0000-\u001f\u007f/\\]/;
const folderName = (x) => {
  const n = v.str(x, 'name', { max: 150 });
  if (NAME_RE.test(n)) throw new ApiError(400, 'VALIDATION_ERROR', 'name contains invalid characters');
  return n;
};

async function getFolder(db, id) {
  const [f] = await db.select('media_folders', { select: '*', id: `eq.${v.uuid(id, 'id')}`, limit: 1 });
  if (!f) throw new ApiError(404, 'FOLDER_NOT_FOUND', 'Folder not found');
  return f;
}

async function depthOf(db, folderId) {
  if (!folderId) return 0;
  const crumbs = await db.rpc('folder_breadcrumb', { p_folder: folderId });
  return crumbs.length;
}

async function assertEventActive(db, eventId) {
  const [e] = await db.select('events', { select: 'id,deleted_at', id: `eq.${eventId}`, limit: 1 });
  if (!e) throw new ApiError(404, 'EVENT_NOT_FOUND', 'Event not found');
  if (e.deleted_at) throw new ApiError(409, 'EVENT_DELETED', 'Restore this event before changing it');
}

export async function create({ request, db }) {
  const b = await readJson(request);
  const eventId = v.uuid(b.event_id, 'event_id');
  const parentId = v.uuid(b.parent_id, 'parent_id', { optional: true });
  const name = folderName(b.name);
  await assertEventActive(db, eventId);
  if (parentId) {
    const parent = await getFolder(db, parentId);
    if (parent.event_id !== eventId) throw new ApiError(400, 'VALIDATION_ERROR', 'parent_id belongs to another event');
    if ((await depthOf(db, parentId)) >= LIMITS.MAX_FOLDER_DEPTH) {
      throw new ApiError(400, 'MAX_DEPTH', `Folders can be nested at most ${LIMITS.MAX_FOLDER_DEPTH} levels deep`);
    }
  }
  const [row] = await db.insert('media_folders', { event_id: eventId, parent_id: parentId, name });
  return created({ folder: row });
}

export async function update({ request, db, params }) {
  const cur = await getFolder(db, params.id);
  await assertEventActive(db, cur.event_id);
  const b = await readJson(request);
  const patch = {};
  if ('name' in b) patch.name = folderName(b.name);
  if ('parent_id' in b) {
    const np = v.uuid(b.parent_id, 'parent_id', { optional: true });
    if (np) {
      const target = await getFolder(db, np);
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
      const [f] = await db.select('media_files', { select: 'id,folder_id', id: `eq.${fid}`, status: 'eq.ready', limit: 1 });
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
  return { folder: row };
}

// Deletes the folder, every subfolder and every file inside (database rows AND R2 objects).
export async function remove({ env, db, params }) {
  const cur = await getFolder(db, params.id);
  await assertEventActive(db, cur.event_id);
  const folderIds = await db.rpc('folder_subtree', { p_folder: cur.id });
  const files = [];
  for (const ids of chunk(folderIds, 100)) {
    files.push(...await db.select('media_files', { select: 'id,event_id,object_key,thumbnail_key', folder_id: `in.(${ids.join(',')})` }));
  }
  await purgeFiles(env, db, files);
  await db.remove('media_folders', { id: `eq.${cur.id}` });
  return { deleted_folder_id: cur.id, deleted_files: files.length };
}

// GET /admin/events/:id/contents?folder_id=&status=&q=&type=&sort=&limit=&offset=&scope=event
export async function contents({ env, db, params, url }) {
  const eventId = v.uuid(params.id, 'id');
  const [e] = await db.select('events', { select: 'id', id: `eq.${eventId}`, limit: 1 });
  if (!e) throw new ApiError(404, 'EVENT_NOT_FOUND', 'Event not found');
  const folderId = v.uuid(url.searchParams.get('folder_id'), 'folder_id', { optional: true });
  let current = null;
  let breadcrumbs = [];
  if (folderId) {
    current = await getFolder(db, folderId);
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
