// js/admin/super.js  -  super admin dashboard. Shows ONLY host emails, status, counts, sizes and report text.
// It never shows event titles, files or share links (the server does not even send them).
import { requireAdmin } from './auth.js';
import { get, post, patch } from '../api.js';
import { h, mount, formatBytes, formatDateTime } from '../util.js';
import { icon } from '../icons.js';
import { toast, showError, confirmDialog, formDialog, withBusy, loading, emptyState } from '../ui.js';

const GB = 1024 ** 3;
const S = { overview: null, hosts: [], reports: [], showAll: false };
let host;

async function load() {
  const [o, hs, rp] = await Promise.all([get('/super/overview'), get('/super/hosts'), get(`/super/reports${S.showAll ? '?status=all' : ''}`)]);
  S.overview = o; S.hosts = hs.hosts; S.reports = rp.reports;
  render();
}
const act = (fn, msg) => async (e) => { await withBusy(e.currentTarget, async () => { try { await fn(); toast(msg, 'success'); await load(); } catch (err) { if (err && err.message !== 'Cancelled') showError(err); } }); };

function stat(n, l) { return h('div', { class: 'stat' }, h('b', null, n), h('span', null, l)); }

function overviewCard() {
  const { settings: s, totals: t } = S.overview;
  const pct = s.r2_budget_bytes ? Math.min(100, (t.bytes_used / s.r2_budget_bytes) * 100) : 0;
  return h('div', null,
    h('div', { class: 'stats' }, stat(t.hosts, t.hosts === 1 ? 'Host' : 'Hosts'), stat(t.pending, 'Waiting approval'), stat(t.events, 'Events'), stat(formatBytes(t.bytes_used), 'Stored')),
    h('section', { class: 'card pad' },
      h('h2', { class: 'h2' }, 'R2 storage'),
      h('div', { class: 'bar lg' }, h('span', { class: 'bar-fill', style: `width:${pct}%` })),
      h('p', { class: 'hint' }, `${formatBytes(t.bytes_used)} used of your ${formatBytes(s.r2_budget_bytes)} budget. ${formatBytes(t.r2_left_bytes)} left. `,
        'R2 has no fixed size, so this budget is just a number you choose (for example the 10 GB free tier, or 100 GB). It limits how much storage you can give to hosts.'),
      h('button', { class: 'btn secondary sm', type: 'button', onclick: editBudget }, icon('edit', 16), 'Change R2 budget')));
}

async function editBudget() {
  const cur = S.overview.settings.r2_budget_bytes / GB;
  const v = await formDialog({ title: 'R2 budget', submitLabel: 'Save', intro: 'The total storage (in GB) you are happy to keep on Cloudflare R2.', fields: [{ name: 'gb', label: 'Budget in GB', type: 'number', min: 0, value: String(Math.round(cur * 100) / 100), required: true }] });
  if (!v) return;
  const gb = Number(v.gb);
  if (!Number.isFinite(gb) || gb < 0) { showError(new Error('Enter a number of GB, like 10 or 100.')); return; }
  try { await patch('/super/settings', { r2_budget_bytes: Math.round(gb * GB) }); toast('Budget saved', 'success'); await load(); } catch (e) { showError(e); }
}

function settingsCard() {
  const on = S.overview.settings.approval_required;
  const cb = h('input', { type: 'checkbox', checked: on, 'aria-label': 'New accounts need my approval' });
  cb.addEventListener('change', async () => {
    try { await patch('/super/settings', { approval_required: cb.checked }); toast(cb.checked ? 'New accounts now need your approval' : 'New accounts are approved automatically', 'success'); await load(); }
    catch (e) { cb.checked = !cb.checked; showError(e); }
  });
  return h('section', { class: 'card pad' }, h('h2', { class: 'h2' }, 'Sign-ups'),
    h('label', { class: 'row gap-s' }, cb, h('span', null, h('b', null, 'New accounts need my approval'))),
    h('p', { class: 'hint' }, on ? 'New people can sign up, but they wait on a "Waiting for approval" screen until you approve them below.' : 'New people can create events straight after confirming their email.'));
}

function reportCard(r) {
  const open = r.status === 'open';
  return h('article', { class: 'bin-row card pad' },
    h('div', { class: 'bin-ic' }, icon('alert', 22)),
    h('div', { class: 'grow' },
      h('div', { class: 'row gap-s wrap' }, h('b', null, `Host: ${r.host_email}`), h('span', { class: `badge ${open ? 'pending_deletion' : ''}` }, open ? 'Open' : r.status), r.event_suspended ? h('span', { class: 'badge suspended' }, 'Event suspended') : null),
      h('p', null, r.reason),
      h('p', { class: 'muted small' }, `${formatDateTime(r.created_at)} - ${r.report_count} report${r.report_count === 1 ? '' : 's'} on this event. You do not need to open the event: you can act from here.`)),
    h('div', { class: 'row gap-s wrap' },
      open ? h('button', { class: 'btn danger sm', type: 'button', onclick: act(async () => { if (!(await confirmDialog({ title: 'Suspend this event?', danger: true, confirmLabel: 'Suspend event', message: 'Its link stops working at once and the host cannot publish it again. Nothing is deleted.' }))) throw new Error('Cancelled'); await post(`/super/reports/${r.id}/suspend-event`); }, 'Event suspended') }, 'Suspend event') : null,
      open ? h('button', { class: 'btn secondary sm', type: 'button', onclick: act(async () => { if (!(await confirmDialog({ title: 'Suspend this host?', danger: true, confirmLabel: 'Suspend host', message: 'All their links and uploads stop at once. Their data is kept until you decide.' }))) throw new Error('Cancelled'); await post(`/super/reports/${r.id}/suspend-host`); }, 'Host suspended') }, 'Suspend host') : null,
      open ? h('button', { class: 'btn ghost sm', type: 'button', onclick: act(() => post(`/super/reports/${r.id}/dismiss`), 'Report dismissed') }, 'Dismiss') : null,
      !open && r.event_suspended ? h('button', { class: 'btn secondary sm', type: 'button', onclick: act(() => post(`/super/reports/${r.id}/unsuspend-event`), 'Event restored') }, 'Undo suspension') : null));
}

function reportsCard() {
  const toggle = h('button', { class: 'btn ghost sm', type: 'button', onclick: async () => { S.showAll = !S.showAll; await load(); } }, S.showAll ? 'Show open only' : 'Show history');
  return h('section', { class: 'stack' },
    h('div', { class: 'row between' }, h('h2', { class: 'h2' }, `Reports${S.reports.filter((r) => r.status === 'open').length ? ` (${S.reports.filter((r) => r.status === 'open').length} open)` : ''}`), toggle),
    S.reports.length ? S.reports.map(reportCard) : h('p', { class: 'muted card pad' }, 'No reports. When a visitor uses the Report link on an event page, it appears here.'));
}

const hostAction = (u, a, msg) => act(() => post(`/super/hosts/${u.id}/${a}`), msg);

async function addStorage(u) {
  const left = S.overview.totals.r2_left_bytes;
  const v = await formDialog({ title: `Add storage for ${u.email}`, submitLabel: 'Add', intro: `Now ${formatBytes(u.quota_bytes)}. You have ${formatBytes(left)} of R2 space left.`, fields: [{ name: 'gb', label: 'Extra GB to add', type: 'number', min: 0, value: '1', required: true }] });
  if (!v) return;
  const gb = Number(v.gb);
  if (!(gb > 0)) { showError(new Error('Enter a number of GB above 0.')); return; }
  try { await post(`/super/hosts/${u.id}/storage`, { add_bytes: Math.round(gb * GB) }); toast('Storage added', 'success'); await load(); } catch (e) { showError(e); }
}

function hostRow(u) {
  const pct = u.quota_bytes ? Math.min(100, (u.used_bytes / u.quota_bytes) * 100) : 0;
  return h('article', { class: 'bin-row card pad' },
    h('div', { class: 'grow' },
      h('div', { class: 'row gap-s wrap' }, h('b', null, u.email), h('span', { class: `badge ${u.status === 'active' ? 'published' : u.status === 'pending' ? 'scheduled' : 'suspended'}` }, u.status)),
      h('p', { class: 'muted small' }, `${u.events} active event${u.events === 1 ? '' : 's'} - ${formatBytes(u.used_bytes)} of ${formatBytes(u.quota_bytes)} used`),
      h('div', { class: 'bar' }, h('span', { class: 'bar-fill', style: `width:${pct}%` }))),
    h('div', { class: 'row gap-s wrap' },
      u.status === 'pending' ? h('button', { class: 'btn primary sm', type: 'button', onclick: hostAction(u, 'approve', 'Host approved') }, icon('check', 16), 'Approve') : null,
      u.status === 'suspended' ? h('button', { class: 'btn primary sm', type: 'button', onclick: hostAction(u, 'restore', 'Host restored') }, icon('restore', 16), 'Restore') : null,
      u.status !== 'suspended' ? h('button', { class: 'btn secondary sm', type: 'button', onclick: hostAction(u, 'suspend', 'Host suspended') }, 'Suspend') : null,
      h('button', { class: 'btn secondary sm', type: 'button', onclick: () => addStorage(u) }, icon('plus', 16), 'Add storage')));
}

function render() {
  mount(host,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Super admin'), h('p', { class: 'muted' }, 'You manage the system. You never see anyone\'s events, files or links.'))),
    overviewCard(), settingsCard(), reportsCard(),
    h('section', { class: 'stack' }, h('h2', { class: 'h2' }, 'Hosts'), S.hosts.length ? S.hosts.map(hostRow) : emptyState('calendar', 'No hosts yet', 'People who sign up will appear here.')));
}

async function main() {
  await requireAdmin({ active: 'super', role: 'super' });
  const app = document.getElementById('app');
  host = h('div', { class: 'stack' }, loading());
  mount(app, host);
  try { await load(); } catch (e) { mount(host, emptyState('alert', 'Could not load the dashboard', e.message)); }
}
main();
