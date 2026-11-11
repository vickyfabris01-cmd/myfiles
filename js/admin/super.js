// js/admin/super.js  -  super admin dashboard: the numbers, the R2 budget, the sign-up switch, and what needs attention.
// The work itself happens on the Hosts, Reports and Conversations pages (see the navigation).
// This page shows only counts and sizes. It never lists events, files or links.
import { requireAdmin, ROUTES } from './auth.js';
import { get, patch } from '../api.js';
import { h, mount, formatBytes } from '../util.js';
import { icon } from '../icons.js';
import { toast, showError, formDialog, loading, emptyState } from '../ui.js';
import { GB, fill, stat, pageHead } from './super-shared.js';

const S = { overview: null, openReports: 0, unreplied: 0 };
let host;

async function load() {
  const [o, rp, cv] = await Promise.all([get('/super/overview'), get('/super/reports'), get('/super/conversations')]);
  S.overview = o;
  S.openReports = rp.reports.length;
  S.unreplied = cv.conversations.filter((c) => c.unread).length;
  render();
}

function overviewCard() {
  const { settings: s, totals: t } = S.overview;
  const pct = s.r2_budget_bytes ? Math.min(100, (t.bytes_used / s.r2_budget_bytes) * 100) : 0;
  return h('div', null,
    h('div', { class: 'stats' }, stat(t.hosts, t.hosts === 1 ? 'Host' : 'Hosts'), stat(t.pending, 'Waiting approval'), stat(t.events, 'Events'), stat(formatBytes(t.bytes_used), 'Stored')),
    h('section', { class: 'card pad' },
      h('h2', { class: 'h2' }, 'R2 storage'),
      h('div', { class: 'bar lg' }, fill(pct)),
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
    h('p', { class: 'hint' }, on ? 'New people can sign up, but they wait on a "Waiting for approval" screen until you approve them on the Hosts page.' : 'New people can create events straight after confirming their email.'));
}

// Three links to the pages where the work is done; the ones that need you are outlined.
function attention() {
  const { totals: t } = S.overview;
  const tile = (href, n, label) => h('a', { class: `card pad tile-link${n ? ' attn' : ''}`, href }, h('b', null, n), h('span', null, label));
  return h('div', { class: 'tiles' },
    tile(ROUTES.reports, S.openReports, S.openReports === 1 ? 'Open report' : 'Open reports'),
    tile(ROUTES.conversations(), S.unreplied, S.unreplied === 1 ? 'Conversation with a new reply' : 'Conversations with new replies'),
    tile(ROUTES.hosts, t.pending, 'Hosts waiting for approval'));
}

function render() {
  mount(host,
    pageHead('Super admin', 'You manage the system. You see host names, counts and sizes. You open an event\'s content only to review a report, and only the one reported file.'),
    attention(), overviewCard(), settingsCard());
}

async function main() {
  await requireAdmin({ active: 'super', role: 'super' });
  const app = document.getElementById('app');
  host = h('div', { class: 'stack' }, loading());
  mount(app, host);
  try { await load(); } catch (e) { mount(host, emptyState('alert', 'Could not load the dashboard', e.message)); }
}
main();
