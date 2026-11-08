// cloudflare/worker/media.js
// Shared response shaping and file queries (used by public and admin routes).
import { presign } from './r2.js';
import { LIMITS } from './config.js';
import { chunk, clampInt } from './utils.js';

export const FILE_COLS =
  'id,event_id,folder_id,original_filename,media_type,mime_type,size_bytes,width,height,duration_seconds,thumbnail_key,status,created_at';

const ORDERS = {
  newest: 'created_at.desc,id.desc',
  oldest: 'created_at.asc,id.asc',
  filename: 'sort_name.asc,id.asc',
};

export const thumbUrl = (env, key) => (key ? presign(env, 'GET', key, { stable: true }) : Promise.resolve(null));

export async function shapeFile(env, row, admin = false) {
  const out = {
    id: row.id,
    folder_id: row.folder_id,
    filename: row.original_filename,
    media_type: row.media_type,
    mime_type: row.mime_type,
    size_bytes: row.size_bytes,
    width: row.width,
    height: row.height,
    duration_seconds: row.duration_seconds,
    created_at: row.created_at,
    thumbnail_url: await thumbUrl(env, row.thumbnail_key),
  };
  if (admin) { out.status = row.status; out.event_id = row.event_id; }
  return out;
}

export function parseListParams(sp) {
  const type = sp.get('type');
  const sort = sp.get('sort');
  return {
    limit: clampInt(sp.get('limit'), 1, LIMITS.PAGE_SIZE_MAX, LIMITS.PAGE_SIZE_DEFAULT),
    offset: clampInt(sp.get('offset'), 0, 1000000, 0),
    type: type === 'photo' || type === 'video' ? type : null,
    sort: ORDERS[sort] ? sort : 'newest',
    search: (sp.get('q') || '').replace(/[*%,()\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100),
    scopeEvent: sp.get('scope') === 'event',
    status: sp.get('status') || 'ready',
  };
}

export async function queryFiles(db, { eventId, folderId, p }) {
  const query = {
    select: FILE_COLS,
    event_id: `eq.${eventId}`,
    order: ORDERS[p.sort],
    limit: p.limit,
    offset: p.offset,
  };
  if (p.status !== 'all') query.status = `eq.${p.status}`;
  if (!(p.scopeEvent && p.search)) query.folder_id = folderId ? `eq.${folderId}` : 'is.null';
  if (p.type) query.media_type = `eq.${p.type}`;
  if (p.search) query.original_filename = `ilike.*${p.search}*`;
  return db.selectCount('media_files', query);
}

export async function fileInfoMap(db, ids) {
  const map = new Map();
  for (const part of chunk(ids, 100)) {
    const rows = await db.select('media_files', { select: 'id,thumbnail_key,media_type', id: `in.(${part.join(',')})` });
    rows.forEach((r) => map.set(r.id, r));
  }
  return map;
}

async function toThumb(env, fileId, info) {
  const r = info.get(fileId);
  return { file_id: fileId, media_type: r ? r.media_type : null, thumbnail_url: await thumbUrl(env, r && r.thumbnail_key) };
}

export async function coverFor(env, db, fileId) {
  if (!fileId) return null;
  const info = await fileInfoMap(db, [fileId]);
  return toThumb(env, fileId, info);
}

// Folder card = prominent cover + two other recent previews.
export async function shapeFolderCards(env, db, cards, admin = false) {
  const ids = [...new Set(cards.flatMap((c) => [c.resolved_cover_id, ...(c.recent_file_ids || [])]).filter(Boolean))];
  const info = await fileInfoMap(db, ids);
  return Promise.all(cards.map(async (c) => {
    const cover = c.resolved_cover_id ? await toThumb(env, c.resolved_cover_id, info) : null;
    const previews = [];
    for (const fid of c.recent_file_ids || []) {
      if (fid === c.resolved_cover_id || previews.length >= 2) continue;
      previews.push(await toThumb(env, fid, info));
    }
    const out = { id: c.id, name: c.name, parent_id: c.parent_id, file_count: c.file_count, cover, previews, created_at: c.created_at };
    if (admin) { out.cover_mode = c.cover_mode; out.cover_file_id = c.cover_file_id; }
    return out;
  }));
}
