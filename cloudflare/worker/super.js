// cloudflare/worker/super.js
// Super admin routes. They return ONLY counts, sizes, host emails/status and report text.
// Never event titles, files, folders or share links.
import { ApiError, v, readJson } from './utils.js';
import { clearAuthCache } from './auth.js';

const num = (x) => Number(x) || 0;
const settingsRow = async (db) => (await db.select('app_settings', { select: '*', limit: 1 }))[0];

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
  return { hosts: rows.map((r) => ({ id: r.user_id, email: r.email, status: r.status, events: num(r.events), used_bytes: num(r.used_bytes), quota_bytes: num(r.quota_bytes), created_at: r.created_at })) };
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
export const hostAction = (action) => async ({ db, params }) => {
  const p = await host(db, params.id);
  const t = TRANSITIONS[action];
  if (!t.from.includes(p.status)) throw new ApiError(409, 'BAD_STATE', `This host is ${p.status}`);
  await db.update('profiles', { user_id: `eq.${p.user_id}` }, { status: t.to, updated_at: new Date().toISOString() });
  clearAuthCache();
  return { id: p.user_id, status: t.to };
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
  return { reports: rows.map((r) => ({ id: r.id, host_email: r.host_email, reason: r.reason, status: r.status, report_count: num(r.report_count), event_suspended: !!r.event_suspended, created_at: r.created_at })) };
}

async function report(db, id) {
  const [r] = await db.select('reports', { select: 'id,event_id,status', id: `eq.${v.uuid(id, 'id')}`, limit: 1 });
  if (!r) throw new ApiError(404, 'REPORT_NOT_FOUND', 'Report not found');
  const [e] = await db.select('events', { select: 'id,created_by', id: `eq.${r.event_id}`, limit: 1 });
  return { ...r, host_id: e && e.created_by };
}
const resolveAll = (db, eventId, status) => db.update('reports', { event_id: `eq.${eventId}`, status: 'eq.open' }, { status, resolved_at: new Date().toISOString() });

// POST /super/reports/:id/dismiss | suspend-event | unsuspend-event | suspend-host
export async function dismissReport({ db, params }) {
  const r = await report(db, params.id);
  await db.update('reports', { id: `eq.${r.id}` }, { status: 'dismissed', resolved_at: new Date().toISOString() });
  return { id: r.id, status: 'dismissed' };
}
export async function suspendEvent({ db, params }) {
  const r = await report(db, params.id);
  await db.update('events', { id: `eq.${r.event_id}` }, { suspended_at: new Date().toISOString(), suspend_reason: 'report', is_published: false, publish_at: null, unpublish_at: null });
  await resolveAll(db, r.event_id, 'actioned');
  return { id: r.id, event_suspended: true };
}
export async function unsuspendEvent({ db, params }) {
  const r = await report(db, params.id);
  await db.update('events', { id: `eq.${r.event_id}` }, { suspended_at: null, suspend_reason: null });
  await db.update('reports', { id: `eq.${r.id}` }, { status: 'dismissed', resolved_at: new Date().toISOString() });
  return { id: r.id, event_suspended: false };
}
export async function suspendHostFromReport({ db, params }) {
  const r = await report(db, params.id);
  if (!r.host_id) throw new ApiError(404, 'HOST_NOT_FOUND', 'Host not found');
  await db.update('profiles', { user_id: `eq.${r.host_id}`, role: 'eq.host' }, { status: 'suspended', updated_at: new Date().toISOString() });
  await resolveAll(db, r.event_id, 'actioned');
  clearAuthCache();
  return { id: r.id, host_suspended: true };
}
