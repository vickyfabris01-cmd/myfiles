// cloudflare/worker/downloads.js
// Short-lived signed download URLs. The browser fetches straight from R2 (Range works for video seeking).
import { ApiError, v, readJson, clampInt } from './utils.js';
import { LIMITS } from './config.js';
import { presign } from './r2.js';
import { loadEvent } from './public.js';

function dispositionHeader(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const utf8 = encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

// POST /event/:token/download  { file_ids: [...up to 25], disposition?: "attachment" | "inline" }
export async function urls({ request, env, db, params }) {
  const e = await loadEvent(db, params.token);
  const b = await readJson(request);
  if (!Array.isArray(b.file_ids) || b.file_ids.length < 1 || b.file_ids.length > 25) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'file_ids must contain 1 to 25 ids');
  }
  const ids = [...new Set(b.file_ids.map((id) => v.uuid(id, 'file_ids[]')))];
  const inline = b.disposition === 'inline';
  const rows = await db.select('media_files', {
    select: 'id,original_filename,size_bytes,object_key,mime_type,media_type',
    event_id: `eq.${e.id}`,
    status: 'eq.ready',
    deleted_at: 'is.null',
    id: `in.(${ids.join(',')})`,
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const items = [];
  const missing = [];
  for (const id of ids) {
    const r = byId.get(id);
    if (!r) { missing.push(id); continue; }
    const query = inline ? {} : { 'response-content-disposition': dispositionHeader(r.original_filename) };
    items.push({
      file_id: r.id,
      filename: r.original_filename,
      size_bytes: r.size_bytes,
      media_type: r.media_type,
      mime_type: r.mime_type,
      url: await presign(env, 'GET', r.object_key, { expires: LIMITS.DOWNLOAD_URL_SECONDS, query }),
      expires_in: LIMITS.DOWNLOAD_URL_SECONDS,
    });
  }
  return { items, missing };
}

// GET /event/:token/manifest?scope=event|folder&folder_id=&recursive=1&limit=&offset=
// List of files for a sequential download queue. URLs are requested one by one via /download.
export async function manifest({ env, db, params, url }) {
  const e = await loadEvent(db, params.token);
  const sp = url.searchParams;
  const scope = sp.get('scope') === 'folder' ? 'folder' : 'event';
  const folderId = scope === 'folder' ? v.uuid(sp.get('folder_id'), 'folder_id') : null;
  if (folderId) {
    const [f] = await db.select('media_folders', { select: 'id', id: `eq.${folderId}`, event_id: `eq.${e.id}`, deleted_at: 'is.null', limit: 1 });
    if (!f) throw new ApiError(404, 'FOLDER_NOT_FOUND', 'Folder not found');
  }
  const recursive = sp.get('recursive') !== '0';
  const limit = clampInt(sp.get('limit'), 1, LIMITS.MANIFEST_MAX, LIMITS.MANIFEST_MAX);
  const offset = clampInt(sp.get('offset'), 0, 10000000, 0);
  const rows = await db.rpc('files_manifest', { p_event: e.id, p_folder: folderId, p_recursive: recursive, p_limit: limit, p_offset: offset });
  const total = rows.length ? rows[0].total : 0;
  return {
    items: rows.map((r) => ({ id: r.id, filename: r.original_filename, size_bytes: r.size_bytes, media_type: r.media_type, folder_id: r.folder_id })),
    total,
    limit,
    offset,
    has_more: offset + rows.length < total,
  };
}
