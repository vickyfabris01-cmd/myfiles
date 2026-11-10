// js/admin/super.js  -  super admin dashboard.
// Overview, hosts and storage show only names, emails, status, counts and sizes. Reports add what is needed to review them:
// the host, the event name, the folder and file name, and a "View file" button for the ONE reported file (only while the report is open).
// Every suspension and every lifting is sent to the host as a message they can reply to; only the owner starts and closes a conversation.
import { requireAdmin } from './auth.js';
import { get, post, patch } from '../api.js';
import { h, mount, formatBytes, formatDateTime } from '../util.js';
import { icon } from '../icons.js';
import { toast, showError, confirmDialog, formDialog, withBusy, loading, emptyState, openModal } from '../ui.js';
import { createThread } from './thread.js';

const GB = 1024 ** 3;
// width through element.style: an inline style="" attribute is blocked by the page's CSP
const fill = (pct) => { const el = h('span', { class: 'bar-fill' }); el.style.width = `${pct}%`; return el; };
const S = { overview: null, hosts: [], reports: [], suspended: [], convs: [], showAll: false, showClosed: false };

// The wording a host gets if nothing is typed. It is shown in the box so the owner can change it first.
const DEFAULT = {
  eventOff: (t) => `Your event "${t}" has been suspended. Its link no longer works and it cannot be published for now. Nothing has been deleted. You can reply here to explain or ask a question.`,
  eventOn: (t) => `Your event "${t}" has been restored. You can publish it again when you are ready.`,
  hostOff: () => 'Your account has been suspended. Your links and uploads are switched off for now. Nothing has been deleted. You can reply here to explain or ask a question.',
  hostOn: () => 'Your account has been restored. Your links and uploads work again.',
};
let host;

async function load() {
  const [o, hs, rp, se, cv] = await Promise.all([get('/super/overview'), get('/super/hosts'), get(`/super/reports${S.showAll ? '?status=all' : ''}`), get('/super/suspended-events'), get('/super/conversations?status=all')]);
  S.overview = o; S.hosts = hs.hosts; S.reports = rp.reports; S.suspended = se.events; S.convs = cv.conversations;
  render();
}
const CANCEL = new Error('Cancelled');
// Runs an action, then reloads. If the host could not be notified (conversation_id null) the owner is told, because the action itself still stands.
const act = (fn, msg) => async (e) => {
  await withBusy(e.currentTarget, async () => {
    try {
      const r = await fn();
      toast(msg, 'success');
      if (r && 'conversation_id' in r && !r.conversation_id) showError(new Error('That worked, but the host could not be notified. Send them a message from the Hosts list.'));
      await load();
    } catch (err) { if (err && err.message !== 'Cancelled') showError(err); }
  });
};

// Asks for the message the host will receive. Returns the text, or null if the owner cancelled.
async function askMessage({ title, intro, text, submitLabel }) {
  const v = await formDialog({ title, submitLabel, intro, fields: [{ name: 'message', label: 'Message to the host', type: 'textarea', rows: 6, value: text, maxLength: 2000, hint: 'The host sees this in their Messages and can reply. You can edit it.' }] });
  return v ? v.message : null;
}
const sendMsg = (path, message) => post(path, message ? { message } : {});

function stat(n, l) { return h('div', { class: 'stat' }, h('b', null, n), h('span', null, l)); }

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
    h('p', { class: 'hint' }, on ? 'New people can sign up, but they wait on a "Waiting for approval" screen until you approve them below.' : 'New people can create events straight after confirming their email.'));
}

async function viewFile(r) {
  const body = h('div', { class: 'media-view' }, loading('Opening file'));
  const m = openModal({ title: r.file_name || 'Reported file', body, className: '' });
  try {
    const f = await get(`/super/reports/${r.id}/media`);
    const el = f.media_type === 'video' ? h('video', { controls: true, preload: 'metadata', src: f.url }) : h('img', { src: f.url, alt: f.filename || 'Reported file' });
    mount(body, el, h('p', { class: 'hint' }, 'Opening this file is recorded on the report. The link stops working after a few minutes and the file can only be opened while the report is open.'));
    r.media_views += 1;
  } catch (e) { m.close(); showError(e); }
}

function reportCard(r) {
  const open = r.status === 'open';
  const who = r.host_name ? `${r.host_name} (${r.host_email})` : r.host_email;
  const where = [r.folder_name ? `Folder: ${r.folder_name}` : null, r.file_name ? `File: ${r.file_name}` : null].filter(Boolean);
  return h('article', { class: 'bin-row card pad' },
    h('div', { class: 'bin-ic' }, icon('flag', 22)),
    h('div', { class: 'grow' },
      h('div', { class: 'row gap-s wrap' }, h('b', null, r.event_title || 'Event (name not saved)'), h('span', { class: `badge ${open ? 'pending_deletion' : ''}` }, open ? 'Held for review' : r.status), r.event_suspended ? h('span', { class: 'badge suspended' }, 'Event suspended') : null),
      h('p', { class: 'muted small' }, `Host: ${who}`),
      where.length ? h('p', { class: 'muted small' }, where.join(' - ')) : null,
      h('p', { class: 'rp-reason' }, r.reason),
      h('p', { class: 'muted small' }, `${formatDateTime(r.created_at)} - ${r.report_count} report${r.report_count === 1 ? '' : 's'} on this event.${r.media_views ? ` The file was opened ${r.media_views} time${r.media_views === 1 ? '' : 's'}.` : ''}`)),
    h('div', { class: 'row gap-s wrap' },
      open && r.file_name && r.has_file ? h('button', { class: 'btn secondary sm', type: 'button', onclick: () => viewFile(r) }, icon('eye', 16), 'View file') : null,
      open ? h('button', { class: 'btn danger sm', type: 'button', onclick: act(async () => {
        const t = r.event_title || 'this event';
        const m = await askMessage({ title: 'Suspend this event?', intro: 'Its link stops working at once and the host cannot publish it again. Nothing is deleted. The host is told in Messages and can reply.', text: DEFAULT.eventOff(t), submitLabel: 'Suspend event' });
        if (m === null) throw CANCEL;
        return sendMsg(`/super/reports/${r.id}/suspend-event`, m);
      }, 'Event suspended') }, 'Suspend event') : null,
      open ? h('button', { class: 'btn secondary sm', type: 'button', onclick: act(async () => {
        const m = await askMessage({ title: 'Suspend this host?', intro: 'All their links and uploads stop at once. Their data is kept. The host is told in Messages and can reply.', text: DEFAULT.hostOff(), submitLabel: 'Suspend host' });
        if (m === null) throw CANCEL;
        return sendMsg(`/super/reports/${r.id}/suspend-host`, m);
      }, 'Host suspended') }, 'Suspend host') : null,
      open ? h('button', { class: 'btn ghost sm', type: 'button', onclick: act(() => post(`/super/reports/${r.id}/dismiss`), 'Report dismissed') }, 'Dismiss') : null,
      !open && r.event_suspended ? h('button', { class: 'btn secondary sm', type: 'button', onclick: act(async () => {
        const m = await askMessage({ title: 'Restore this event?', intro: 'Its link works again once the host publishes it. The host is told in Messages.', text: DEFAULT.eventOn(r.event_title || 'this event'), submitLabel: 'Restore event' });
        if (m === null) throw CANCEL;
        return sendMsg(`/super/reports/${r.id}/unsuspend-event`, m);
      }, 'Event restored') }, 'Undo suspension') : null));
}

function reportsCard() {
  const toggle = h('button', { class: 'btn ghost sm', type: 'button', onclick: async () => { S.showAll = !S.showAll; await load(); } }, S.showAll ? 'Show open only' : 'Show history');
  return h('section', { class: 'stack' },
    h('div', { class: 'row between' }, h('h2', { class: 'h2' }, `Reports${S.reports.filter((r) => r.status === 'open').length ? ` (${S.reports.filter((r) => r.status === 'open').length} open)` : ''}`), toggle),
    S.reports.length ? S.reports.map(reportCard) : h('p', { class: 'muted card pad' }, 'No reports. When a visitor uses the Report link on an event page, it appears here.'));
}

function suspendedCard() {
  if (!S.suspended.length) return null;
  return h('section', { class: 'stack' }, h('h2', { class: 'h2' }, `Suspended events (${S.suspended.length})`),
    S.suspended.map((e) => h('article', { class: 'bin-row card pad' },
      h('div', { class: 'bin-ic' }, icon('lock', 22)),
      h('div', { class: 'grow' }, h('b', null, e.title), h('p', { class: 'muted small' }, `Host: ${e.host_name ? `${e.host_name} (${e.host_email})` : e.host_email}${e.suspended_at ? ` - suspended ${formatDateTime(e.suspended_at)}` : ''}`)),
      h('div', { class: 'row gap-s wrap' },
        h('button', { class: 'btn primary sm', type: 'button', onclick: act(async () => {
          const m = await askMessage({ title: 'Restore this event?', intro: 'Its link works again once the host publishes it. The host is told in Messages.', text: DEFAULT.eventOn(e.title), submitLabel: 'Restore event' });
          if (m === null) throw CANCEL;
          return sendMsg(`/super/events/${e.id}/unsuspend`, m);
        }, 'Event restored') }, icon('restore', 16), 'Restore'),
        e.conversation_id ? h('button', { class: 'btn secondary sm', type: 'button', onclick: () => openConversation(e.conversation_id) }, icon('message', 16), 'Open chat') : null))));
}

// One conversation in a window: read, reply, close. Closing keeps it for history and nothing can be added afterwards.
async function openConversation(id) {
  let current = null;
  const thread = createThread({ me: 'super_admin', onSend: async (body) => { await post(`/super/conversations/${id}/messages`, { body }); await reload(); } });
  const sub = h('p', { class: 'muted small' });
  const closeBtn = h('button', { class: 'btn danger', type: 'button', onclick: async () => {
    if (!(await confirmDialog({ title: 'Close this conversation?', danger: true, confirmLabel: 'Close conversation', message: 'The host can no longer reply and neither can you. It stays in History as a record.' }))) return;
    try { await post(`/super/conversations/${id}/close`); toast('Conversation closed', 'success'); await reload(); await load(); } catch (e) { showError(e); }
  } }, icon('lock', 16), 'Close conversation');
  const refreshBtn = h('button', { class: 'btn secondary', type: 'button', onclick: () => reload().catch(showError) }, icon('refresh', 16), 'Refresh');
  async function reload() {
    const d = await get(`/super/conversations/${id}`);
    current = d.conversation;
    sub.textContent = `${current.host_name ? `${current.host_name} - ` : ''}${current.host_email || ''}${current.event_title ? ` - ${current.event_title}` : ''} - ${current.status === 'open' ? 'Open' : 'Closed'}`;
    closeBtn.hidden = current.status !== 'open';
    thread.update(current, d.messages);
  }
  try { await reload(); } catch (e) { showError(e); return; }
  const m = openModal({ title: current.subject, body: h('div', { class: 'stack' }, sub, thread.el), footer: [refreshBtn, closeBtn] });
  m.closed.then(() => load().catch(() => {}));
}

async function startConversation(u) {
  const v = await formDialog({ title: `Message ${u.name || u.email}`, submitLabel: 'Start conversation', intro: 'Only you can start a conversation. The host can reply while it is open, and you close it when you are done.', fields: [
    { name: 'subject', label: 'Subject', maxLength: 150, required: true },
    { name: 'body', label: 'Message', type: 'textarea', rows: 5, maxLength: 2000, required: true }] });
  if (!v) return;
  try { const r = await post('/super/conversations', { host_id: u.id, subject: v.subject, body: v.body }); toast('Message sent', 'success'); await load(); openConversation(r.id); } catch (e) { showError(e); }
}

function conversationsCard() {
  const open = S.convs.filter((c) => c.status === 'open');
  const closed = S.convs.filter((c) => c.status === 'closed');
  const row = (c) => h('button', { class: `conv-row${c.unread ? ' unread' : ''}`, type: 'button', onclick: () => openConversation(c.id) },
    h('span', { class: 'conv-dot', 'aria-label': c.unread ? 'Host replied' : null }),
    h('span', { class: 'conv-main' }, h('b', null, c.subject), h('small', { class: 'muted' }, `${c.host_name ? `${c.host_name} - ` : ''}${c.host_email || ''}${c.event_title ? ` - ${c.event_title}` : ''}`), c.last_preview ? h('span', { class: 'conv-prev' }, `${c.last_sender === 'host' ? 'Host: ' : 'You: '}${c.last_preview}`) : null),
    h('span', { class: 'conv-when muted' }, formatDateTime(c.last_message_at)));
  const unread = open.filter((c) => c.unread).length;
  return h('section', { class: 'stack' },
    h('div', { class: 'row between' }, h('h2', { class: 'h2' }, `Conversations${unread ? ` (${unread} new repl${unread === 1 ? 'y' : 'ies'})` : ''}`),
      closed.length ? h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { S.showClosed = !S.showClosed; render(); } }, S.showClosed ? 'Hide history' : `Show history (${closed.length})`) : null),
    open.length ? h('div', { class: 'conv-list' }, open.map(row)) : h('p', { class: 'muted card pad' }, 'No open conversations. Suspending an event or account starts one automatically, and you can start one from the Hosts list.'),
    S.showClosed ? h('div', { class: 'conv-list' }, closed.map(row)) : null);
}

const hostAction = (u, a, msg) => act(async () => {
  if (a === 'approve') return post(`/super/hosts/${u.id}/approve`);
  const off = a === 'suspend';
  const m = await askMessage({ title: off ? `Suspend ${u.name || u.email}?` : `Restore ${u.name || u.email}?`,
    intro: off ? 'Their links and uploads stop at once. Their data is kept. They are told in Messages and can reply.' : 'Their links and uploads work again. They are told in Messages.',
    text: off ? DEFAULT.hostOff() : DEFAULT.hostOn(), submitLabel: off ? 'Suspend host' : 'Restore host' });
  if (m === null) throw CANCEL;
  return sendMsg(`/super/hosts/${u.id}/${a}`, m);
}, msg);

async function addStorage(u) {
  const left = S.overview.totals.r2_left_bytes;
  const v = await formDialog({ title: `Add storage for ${u.name || u.email}`, submitLabel: 'Add', intro: `Now ${formatBytes(u.quota_bytes)}. You have ${formatBytes(left)} of R2 space left.`, fields: [{ name: 'gb', label: 'Extra GB to add', type: 'number', min: 0, value: '1', required: true }] });
  if (!v) return;
  const gb = Number(v.gb);
  if (!(gb > 0)) { showError(new Error('Enter a number of GB above 0.')); return; }
  try { await post(`/super/hosts/${u.id}/storage`, { add_bytes: Math.round(gb * GB) }); toast('Storage added', 'success'); await load(); } catch (e) { showError(e); }
}

function hostRow(u) {
  const pct = u.quota_bytes ? Math.min(100, (u.used_bytes / u.quota_bytes) * 100) : 0;
  return h('article', { class: 'bin-row card pad' },
    h('div', { class: 'grow' },
      h('div', { class: 'row gap-s wrap' }, h('b', null, u.name ? `${u.name} (${u.email})` : u.email), h('span', { class: `badge ${u.status === 'active' ? 'published' : u.status === 'pending' ? 'scheduled' : 'suspended'}` }, u.status)),
      h('p', { class: 'muted small' }, `${u.events} active event${u.events === 1 ? '' : 's'} - ${formatBytes(u.used_bytes)} of ${formatBytes(u.quota_bytes)} used`),
      h('div', { class: 'bar' }, fill(pct))),
    h('div', { class: 'row gap-s wrap' },
      u.status === 'pending' ? h('button', { class: 'btn primary sm', type: 'button', onclick: hostAction(u, 'approve', 'Host approved') }, icon('check', 16), 'Approve') : null,
      u.status === 'suspended' ? h('button', { class: 'btn primary sm', type: 'button', onclick: hostAction(u, 'restore', 'Host restored') }, icon('restore', 16), 'Restore') : null,
      u.status !== 'suspended' ? h('button', { class: 'btn secondary sm', type: 'button', onclick: hostAction(u, 'suspend', 'Host suspended') }, 'Suspend') : null,
      h('button', { class: 'btn secondary sm', type: 'button', onclick: () => startConversation(u) }, icon('message', 16), 'Message'),
      h('button', { class: 'btn secondary sm', type: 'button', onclick: () => addStorage(u) }, icon('plus', 16), 'Add storage')));
}

function render() {
  mount(host,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Super admin'), h('p', { class: 'muted' }, 'You manage the system. You see host names, counts and sizes. You open an event\'s content only to review a report, and only the one reported file.'))),
    overviewCard(), settingsCard(), reportsCard(), suspendedCard(), conversationsCard(),
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
