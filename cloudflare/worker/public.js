// cloudflare/worker/public.js
// Public (visitor) routes. Access = valid share token + published + not pending deletion.
import { ApiError, v, readJson } from './utils.js';
import { hashToken } from './tokens.js';
import { coverFor, parseListParams, queryFiles, shapeFile, shapeFolderCards } from './media.js';

const unavailable = (reason) =>
  new ApiError(404, 'EVENT_UNAVAILABLE', 'This event is not available', { reason });

export async function loadEvent(db, token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,128}$/.test(token)) throw unavailable('not_found');
  const hash = await hashToken(token);
  const [e] = await db.select('events', {
    select: 'id,title,event_date,description,location,is_published,deleted_at,cover_mode,cover_pos_x,cover_pos_y',
    share_token_hash: `eq.${hash}`,
    limit: 1,
  });
  if (!e) throw unavailable('not_found');
  if (e.deleted_at) throw unavailable('deleted');
  if (!e.is_published) throw unavailable('unpublished');
  return e;
}

async function assertFolderInEvent(db, folderId, eventId) {
  const [f] = await db.select('media_folders', { select: 'id,name,parent_id', id: `eq.${folderId}`, event_id: `eq.${eventId}`, limit: 1 });
  if (!f) throw new ApiError(404, 'FOLDER_NOT_FOUND', 'Folder not found');
  return f;
}

export async function validate({ request, env, db }) {
  const body = await readJson(request);
  const e = await loadEvent(db, body.token);
  const coverId = await db.rpc('event_cover_file', { p_event: e.id });
  return {
    event: {
      title: e.title,
      event_date: e.event_date,
      description: e.description,
      location: e.location,
      cover: await coverFor(env, db, coverId, e.cover_mode === 'manual' ? { x: e.cover_pos_x, y: e.cover_pos_y } : null),
    },
  };
}

export async function folders({ env, db, params, url }) {
  const e = await loadEvent(db, params.token);
  const parentId = v.uuid(url.searchParams.get('parent_id'), 'parent_id', { optional: true });
  let current = null;
  let breadcrumbs = [];
  if (parentId) {
    current = await assertFolderInEvent(db, parentId, e.id);
    const crumbs = await db.rpc('folder_breadcrumb', { p_folder: parentId });
    breadcrumbs = crumbs.map((c) => ({ id: c.id, name: c.name }));
  }
  const cards = await db.rpc('folder_cards', { p_event: e.id, p_parent: parentId, p_hide_empty: true });
  return {
    current: current ? { id: current.id, name: current.name, parent_id: current.parent_id } : null,
    breadcrumbs,
    folders: await shapeFolderCards(env, db, cards, false),
  };
}

export async function files({ env, db, params, url }) {
  const e = await loadEvent(db, params.token);
  const folderId = v.uuid(url.searchParams.get('folder_id'), 'folder_id', { optional: true });
  if (folderId) await assertFolderInEvent(db, folderId, e.id);
  const p = parseListParams(url.searchParams);
  p.status = 'ready'; // visitors only ever see finished uploads
  const { rows, total } = await queryFiles(db, { eventId: e.id, folderId, p });
  const items = await Promise.all(rows.map((r) => shapeFile(env, r, false)));
  return { items, total, limit: p.limit, offset: p.offset, has_more: p.offset + items.length < total };
}
