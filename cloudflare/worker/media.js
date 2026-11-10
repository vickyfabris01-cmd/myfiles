// cloudflare/worker/media.js
// Shared response shaping and file queries (used by public and admin routes).
import { presign } from './r2.js';
import { LIMITS } from './config.js';
import { chunk, clampInt } from './utils.js';

// photos up to this size are used at full quality for the big cover banner (bigger ones fall back to the thumbnail)
const HERO_MAX_BYTES = 12 * 1024 * 1024;
const pct = (n) => (Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 50);

export const FILE_COLS =
  'id,event_id,folder_id,original_filename,media_type,mime_type,size_bytes,width,height,duration_seconds,thumbnail_key,status,created_at,taken_at';

// The only sort is by DATE. sort_date = the date the photo/video was taken, or the upload time when that is unknown.
const ORDERS = {
  newest: 'sort_date.desc,id.desc',
  oldest: 'sort_date.asc,id.asc',
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
    taken_at: row.taken_at || null,
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
    deleted_at: 'is.null',            // files in the recycle bin never show up in a listing
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
    const rows = await db.select('media_files', { select: 'id,thumbnail_key,media_type,object_key,size_bytes', id: `in.(${part.join(',')})` });
    rows.forEach((r) => map.set(r.id, r));
  }
  return map;
}

async function toThumb(env, fileId, info) {
  const r = info.get(fileId);
  return { file_id: fileId, media_type: r ? r.media_type : null, thumbnail_url: await thumbUrl(env, r && r.thumbnail_key) };
}

// Event cover for the public page. image_url = the original photo (sharp on wide screens); thumbnail_url shows first.
// pos_x / pos_y = the part of the photo the admin chose to keep visible (only for a manually chosen cover).
export async function coverFor(env, db, fileId, pos = null) {
  if (!fileId) return null;
  const info = await fileInfoMap(db, [fileId]);
  const out = await toThumb(env, fileId, info);
  const r = info.get(fileId);
  out.image_url = r && r.media_type === 'photo' && r.object_key && r.size_bytes <= HERO_MAX_BYTES
    ? await presign(env, 'GET', r.object_key, { stable: true }) : null;
  out.pos_x = pos ? pct(pos.x) : 50;
  out.pos_y = pos ? pct(pos.y) : 50;
  return out;
}

// Folder card = prominent cover + two other recent previews.
export async function shapeFolderCards(env, db, cards, admin = false) {
  const ids = [...new Set(cards.flatMap((c) => [c.resolved_cover_id, ...(c.recent_file_ids || [])]).filter(Boolean))];
  const info = await fileInfoMap(db, ids);
  const pos = new Map();
  for (const part of chunk(cards.map((c) => c.id), 100)) {
    if (!part.length) continue;
    const rows = await db.select('media_folders', { select: 'id,cover_pos_x,cover_pos_y', id: `in.(${part.join(',')})` });
    rows.forEach((r) => pos.set(r.id, r));
  }
  return Promise.all(cards.map(async (c) => {
    const cover = c.resolved_cover_id ? await toThumb(env, c.resolved_cover_id, info) : null;
    if (cover) {
      const p = c.cover_mode === 'manual' ? pos.get(c.id) : null;
      cover.pos_x = p ? pct(p.cover_pos_x) : 50;
      cover.pos_y = p ? pct(p.cover_pos_y) : 50;
    }
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
