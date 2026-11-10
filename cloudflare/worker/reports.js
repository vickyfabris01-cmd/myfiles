// cloudflare/worker/reports.js
// Public "Report" link on every event page. The super admin sees these as in-app notifications (see super.js).
// A report can also name the folder the visitor was in and, optionally, one file. The names are copied onto the
// report when it is sent, so renaming, moving or deleting things afterwards cannot hide what was reported.
import { ApiError, v, readJson } from './utils.js';
import { LIMITS } from './config.js';
import { hashToken } from './tokens.js';
import { loadEvent } from './public.js';

const clip = (s, n) => (typeof s === 'string' ? s.slice(0, n) : null);

// The folder must belong to this event and not be in the bin. Returns its path, like "Ceremony / Rings".
async function folderPath(db, folderId, eventId) {
  const [f] = await db.select('media_folders', { select: 'id', id: `eq.${folderId}`, event_id: `eq.${eventId}`, deleted_at: 'is.null', limit: 1 });
  if (!f) throw new ApiError(404, 'FOLDER_NOT_FOUND', 'Folder not found');
  const crumbs = (await db.rpc('folder_breadcrumb', { p_folder: folderId })) || [];
  return clip(crumbs.map((c) => c.name).join(' / '), 300);
}

// The file must belong to this event, be finished and not be in the bin (visitors never see anything else).
async function reportedFile(db, fileId, eventId) {
  const [f] = await db.select('media_files', { select: 'id,folder_id,original_filename', id: `eq.${fileId}`, event_id: `eq.${eventId}`, status: 'eq.ready', deleted_at: 'is.null', limit: 1 });
  if (!f) throw new ApiError(404, 'FILE_NOT_FOUND', 'File not found');
  return f;
}

// POST /event/:token/report  { reason, folder_id?, file_id? }
export async function submit({ request, db, params }) {
  const e = await loadEvent(db, params.token);
  const b = await readJson(request);
  const reason = v.str(b.reason, 'reason', { min: 3, max: LIMITS.REPORT_MAX_CHARS });
  let folderId = v.uuid(b.folder_id, 'folder_id', { optional: true });
  const fileId = v.uuid(b.file_id, 'file_id', { optional: true });

  let fileName = null;
  if (fileId) {
    const f = await reportedFile(db, fileId, e.id);
    fileName = clip(f.original_filename, 255);
    folderId = f.folder_id || null; // where the file really is wins over what the browser said
  }
  const folderName = folderId ? await folderPath(db, folderId, e.id) : null;

  const since = new Date(Date.now() - 3600 * 1000).toISOString();
  const recent = await db.selectCount('reports', { select: 'id', event_id: `eq.${e.id}`, created_at: `gte.${since}`, limit: 1 });
  if (recent.total >= LIMITS.REPORTS_PER_EVENT_HOUR) throw new ApiError(429, 'RATE_LIMITED', 'Too many reports for this event right now. Thank you, the owner has been notified.', { retry_after: 3600 });
  const reporter = await hashToken(request.headers.get('CF-Connecting-IP') || 'unknown');
  const tenMin = new Date(Date.now() - 600 * 1000).toISOString();
  // the same person reporting the same thing again within 10 minutes is ignored; a different file is a new report
  const dup = await db.select('reports', { select: 'id', event_id: `eq.${e.id}`, reporter_hash: `eq.${reporter}`, file_id: fileId ? `eq.${fileId}` : 'is.null', created_at: `gte.${tenMin}`, limit: 1 });
  if (!dup.length) {
    await db.insert('reports', {
      event_id: e.id, reason, reporter_hash: reporter,
      folder_id: folderId, file_id: fileId,
      event_title: clip(e.title, 200), folder_name: folderName, file_name: fileName,
    });
  }
  return { reported: true };
}
