// cloudflare/worker/super.js
// Super admin routes.
//  * Overview, host list and storage: counts, sizes, host names/emails and status only. Never titles, files or links.
//  * Reports: the report text plus the names needed to review it (host, event title, folder, file name).
//    The reported file itself can be opened ONLY while its report is open, and every opening is counted on the report.
import { ApiError, v, readJson } from './utils.js';
import { clearAuthCache } from './auth.js';
import { LIMITS } from './config.js';
import { presign } from './r2.js';
import { notifyHost, TEXT } from './messages.js';

const num = (x) => Number(x) || 0;
const settingsRow = async (db) => (await db.select('app_settings', { select: '*', limit: 1 }))[0];
const MEDIA_LINK_SECONDS = 600;

// The message the super admin typed for the host. Optional: when it is empty a standard notice is sent instead,
// so a host is never suspended or restored without being told.
const optMessage = (b) => v.str(b.message, 'message', { optional: true, max: LIMITS.MESSAGE_MAX_CHARS });

async function overviewData(db) {
  const t = (await db.rpc('system_totals')) || {};
  const s = (await settingsRow(db)) || {};
  const budget = num(s.r2_budget_bytes), used = num(t.bytes_used);
  return {
    settings: { approval_required: !!s.approval_required, r2_budget_bytes: budget, default_quota_bytes: num(s.default_quota_bytes) },
    totals: { hosts: num(t.hosts), pending: num(t.pending), events: num(t.events), bytes_used: used, r2_left_bytes: Math.max(0, budget - used) },
  };
}

export async function overview({ db }) { return overviewData(db); }

export async function hosts({ db }) {
  const rows = (await db.rpc('super_host_list')) || [];
  return { hosts: rows.map((r) => ({ id: r.user_id, email: r.email, name: r.display_name || null, status: r.status, events: num(r.events), used_bytes: num(r.used_bytes), quota_bytes: num(r.quota_bytes), created_at: r.created_at })) };
}

// PATCH /super/settings  { approval_required?: bool, r2_budget_bytes?: int }
export async function updateSettings({ request, db }) {
  const b = await readJson(request);
  const patch = {};
  if ('approval_required' in b) patch.approval_required = v.bool(b.approval_required, 'approval_required');
  if ('r2_budget_bytes' in b) patch.r2_budget_bytes = v.int(b.r2_budget_bytes, 'r2_budget_bytes', { min: 0, max: 1e15 });
  if (!Object.keys(patch).length) throw new ApiError(400, 'VALIDATION_ERROR', 'Nothing to update');
  patch.updated_at = new Date().toISOString();
  await db.update('app_settings', { id: 'eq.true' }, patch);
  return overviewData(db);
}

async function host(db, id) {
  const [p] = await db.select('profiles', { select: 'user_id,email,role,status,extra_storage_bytes', user_id: `eq.${v.uuid(id, 'id')}`, limit: 1 });
  if (!p || p.role !== 'host') throw new ApiError(404, 'HOST_NOT_FOUND', 'Host not found');
  return p;
}

// POST /super/hosts/:id/approve | suspend | restore
const TRANSITIONS = {
  approve: { from: ['pending'], to: 'active' },
  suspend: { from: ['pending', 'active'], to: 'suspended' },   // links and uploads stop at once; data is kept
  restore: { from: ['suspended'], to: 'active' },
};
export const hostAction = (action) => async ({ request, db, params }) => {
  const p = await host(db, params.id);
  const t = TRANSITIONS[action];
  if (!t.from.includes(p.status)) throw new ApiError(409, 'BAD_STATE', `This host is ${p.status}`);
  const message = action === 'approve' ? null : optMessage(await readJson(request)); // read before changing anything
  await db.update('profiles', { user_id: `eq.${p.user_id}` }, { status: t.to, updated_at: new Date().toISOString() });
  clearAuthCache();
  let conversation_id = null;
  if (action === 'suspend') {
    conversation_id = await notifyHost(db, { hostId: p.user_id, kind: 'account_suspended', subject: 'Your account was suspended', body: message || TEXT.accountSuspended() });
  } else if (action === 'restore') {
    conversation_id = await notifyHost(db, { hostId: p.user_id, kind: 'account_suspended', subject: 'Your account was restored', body: message || TEXT.accountRestored() });
  }
  return { id: p.user_id, status: t.to, conversation_id };   // conversation_id null on suspend / restore means the notice could not be saved
};

// POST /super/hosts/:id/storage  { add_bytes }   limited by the R2 space that is left
export async function addStorage({ request, db, params }) {
  const p = await host(db, params.id);
  const b = await readJson(request);
  const add = v.int(b.add_bytes, 'add_bytes', { min: 1, max: 1e13 });
  const { totals } = await overviewData(db);
  if (add > totals.r2_left_bytes) {
    throw new ApiError(409, 'NOT_ENOUGH_R2', 'That is more than the R2 space you have left. Raise the R2 budget first, or add less.', { r2_left_bytes: totals.r2_left_bytes });
  }
  const extra = num(p.extra_storage_bytes) + add;
  await db.update('profiles', { user_id: `eq.${p.user_id}` }, { extra_storage_bytes: extra, updated_at: new Date().toISOString() });
  return { id: p.user_id, extra_storage_bytes: extra };
}

// ---- reports (in-app notifications) ----
export async function reports({ db, url }) {
  const openOnly = url.searchParams.get('status') !== 'all';
  const rows = (await db.rpc('super_reports_list', { p_open_only: openOnly })) || [];
  return {
    reports: rows.map((r) => ({
      id: r.id,
      host_email: r.host_email,
      host_name: r.host_name || null,
      reason: r.reason,
      status: r.status,
      event_title: r.event_title || null,
      folder_name: r.folder_name || null,
      file_name: r.file_name || null,
      has_file: !!r.has_file,                   // the named file still exists and can be opened (only while the report is open)
      media_views: num(r.media_views),
      report_count: num(r.report_count),
      event_suspended: !!r.event_suspended,
      created_at: r.created_at,
    })),
  };
}

async function report(db, id) {
  const [r] = await db.select('reports', { select: 'id,event_id,status', id: `eq.${v.uuid(id, 'id')}`, limit: 1 });
  if (!r) throw new ApiError(404, 'REPORT_NOT_FOUND', 'Report not found');
  const [e] = await db.select('events', { select: 'id,created_by,title', id: `eq.${r.event_id}`, limit: 1 });
  return { ...r, host_id: e && e.created_by, event_title: e && e.title };
}
const resolveAll = (db, eventId, status) => db.update('reports', { event_id: `eq.${eventId}`, status: 'eq.open' }, { status, resolved_at: new Date().toISOString() });

// GET /super/reports/:id/media  ->  { url, media_type, filename, expires_in }
// A short-lived link to the ONE file named in the report. Only while the report is open ("held for review"),
// and every opening is counted on the report (media_views) so there is a record that it was looked at.
export async function reportMedia({ env, db, params }) {
  const [r] = await db.select('reports', { select: 'id,event_id,file_id,status,media_views', id: `eq.${v.uuid(params.id, 'id')}`, limit: 1 });
  if (!r) throw new ApiError(404, 'REPORT_NOT_FOUND', 'Report not found');
  if (r.status !== 'open') throw new ApiError(409, 'REPORT_CLOSED', 'This report is closed, so its file can no longer be opened.');
  if (!r.file_id) throw new ApiError(404, 'NO_FILE', 'This report does not name a file.');
  const [f] = await db.select('media_files', { select: 'id,object_key,original_filename,media_type,status', id: `eq.${r.file_id}`, event_id: `eq.${r.event_id}`, limit: 1 });
  if (!f || f.status !== 'ready') throw new ApiError(404, 'FILE_GONE', 'This file no longer exists.');
  await db.update('reports', { id: `eq.${r.id}` }, { media_views: num(r.media_views) + 1, media_last_viewed_at: new Date().toISOString() });
  return { url: await presign(env, 'GET', f.object_key, { expires: MEDIA_LINK_SECONDS }), media_type: f.media_type, filename: f.original_filename, expires_in: MEDIA_LINK_SECONDS };
}

// POST /super/reports/:id/dismiss | suspend-event | unsuspend-event | suspend-host
export async function dismissReport({ db, params }) {
  const r = await report(db, params.id);
  await db.update('reports', { id: `eq.${r.id}` }, { status: 'dismissed', resolved_at: new Date().toISOString() });
  return { id: r.id, status: 'dismissed' };
}

// Switch an event off. The host is told in a conversation they can reply to.
async function switchEventOff(db, { eventId, hostId, title, reportId = null, message }) {
  await db.update('events', { id: `eq.${eventId}` }, { suspended_at: new Date().toISOString(), suspend_reason: 'report', is_published: false, publish_at: null, unpublish_at: null });
  return notifyHost(db, { hostId, eventId, eventTitle: title, reportId, kind: 'event_suspended', subject: 'Your event was suspended', body: message || TEXT.eventSuspended(title) });
}
async function switchEventOn(db, { eventId, hostId, title, message }) {
  await db.update('events', { id: `eq.${eventId}` }, { suspended_at: null, suspend_reason: null });
  return notifyHost(db, { hostId, eventId, eventTitle: title, kind: 'event_suspended', subject: 'Your event was restored', body: message || TEXT.eventRestored(title) });
}

// POST /super/reports/:id/suspend-event  { message? }
export async function suspendEvent({ request, db, params }) {
  const r = await report(db, params.id);
  const message = optMessage(await readJson(request));
  const conversation_id = await switchEventOff(db, { eventId: r.event_id, hostId: r.host_id, title: r.event_title, reportId: r.id, message });
  await resolveAll(db, r.event_id, 'actioned');
  return { id: r.id, event_suspended: true, conversation_id };
}

// POST /super/reports/:id/unsuspend-event  { message? }
export async function unsuspendEvent({ request, db, params }) {
  const r = await report(db, params.id);
  const message = optMessage(await readJson(request));
  const conversation_id = await switchEventOn(db, { eventId: r.event_id, hostId: r.host_id, title: r.event_title, message });
  await db.update('reports', { id: `eq.${r.id}` }, { status: 'dismissed', resolved_at: new Date().toISOString() });
  return { id: r.id, event_suspended: false, conversation_id };
}

// POST /super/events/:id/unsuspend  { message? }   lift a suspension directly from the "Suspended events" list (no report needed)
export async function unsuspendEventById({ request, db, params }) {
  const [e] = await db.select('events', { select: 'id,title,created_by,suspended_at', id: `eq.${v.uuid(params.id, 'id')}`, limit: 1 });
  if (!e) throw new ApiError(404, 'EVENT_NOT_FOUND', 'Event not found');
  if (!e.suspended_at) throw new ApiError(409, 'BAD_STATE', 'This event is not suspended');
  const message = optMessage(await readJson(request));
  const conversation_id = await switchEventOn(db, { eventId: e.id, hostId: e.created_by, title: e.title, message });
  return { id: e.id, event_suspended: false, conversation_id };
}

// POST /super/reports/:id/suspend-host  { message? }
export async function suspendHostFromReport({ request, db, params }) {
  const r = await report(db, params.id);
  if (!r.host_id) throw new ApiError(404, 'HOST_NOT_FOUND', 'Host not found');
  const message = optMessage(await readJson(request));
  await db.update('profiles', { user_id: `eq.${r.host_id}`, role: 'eq.host' }, { status: 'suspended', updated_at: new Date().toISOString() });
  await resolveAll(db, r.event_id, 'actioned');
  clearAuthCache();
  const conversation_id = await notifyHost(db, { hostId: r.host_id, reportId: r.id, kind: 'account_suspended', subject: 'Your account was suspended', body: message || TEXT.accountSuspended() });
  return { id: r.id, host_suspended: true, conversation_id };
}
