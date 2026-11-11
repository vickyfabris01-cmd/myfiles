// js/admin/host.js  -  one host: act on the host, and on any of that host's events that were reported or are suspended.
// Privacy: the host's other events are never listed here. Only events with a report (any status) or a suspension appear.
import { requireAdmin } from './auth.js';
import { get } from '../api.js';
import { h, mount, formatBytes, formatDateTime } from '../util.js';
import { icon } from '../icons.js';
import { loading, emptyState } from '../ui.js';
import { fill, stat, statusClass, hostAction, addStorage, startConversation, suspendEventAction, restoreEventAction, openConversation, convRow, ROUTES } from './super-shared.js';

let box, D, left = 0;
const id = new URLSearchParams(location.search).get('id');

async function load() {
  const [d, o] = await Promise.all([get(`/super/hosts/${encodeURIComponent(id)}`), get('/super/overview')]);
  D = d; left = o.totals.r2_left_bytes;
  render();
}

function headCard() {
  const u = D.host;
  const pct = u.quota_bytes ? Math.min(100, (u.used_bytes / u.quota_bytes) * 100) : 0;
  return h('div', null,
    h('div', { class: 'page-head' },
      h('div', null, h('h1', null, u.name || u.email), h('p', { class: 'muted' }, u.name ? u.email : 'No name set yet'), h('div', { class: 'row gap-s wrap' }, h('span', { class: `badge ${statusClass(u.status)}` }, u.status), u.created_at ? h('span', { class: 'muted small' }, `Joined ${formatDateTime(u.created_at)}`) : null)),
      h('div', { class: 'row gap-s wrap' },
        u.status === 'pending' ? h('button', { class: 'btn primary sm', type: 'button', onclick: hostAction(u, 'approve', 'Host approved', load) }, icon('check', 16), 'Approve') : null,
        u.status === 'suspended' ? h('button', { class: 'btn primary sm', type: 'button', onclick: hostAction(u, 'restore', 'Host restored', load) }, icon('restore', 16), 'Restore host') : null,
        u.status !== 'suspended' ? h('button', { class: 'btn danger sm', type: 'button', onclick: hostAction(u, 'suspend', 'Host suspended', load) }, 'Suspend host') : null,
        h('button', { class: 'btn secondary sm', type: 'button', onclick: () => startConversation({ ...u, id: u.id }, load) }, icon('message', 16), 'Message'),
        h('button', { class: 'btn secondary sm', type: 'button', onclick: () => addStorage(u, left, load) }, icon('plus', 16), 'Add storage'))),
    h('div', { class: 'stats' }, stat(u.events, u.events === 1 ? 'Active event' : 'Active events'), stat(formatBytes(u.used_bytes), 'Stored'), stat(formatBytes(u.quota_bytes), 'Storage limit'), stat(D.reports.length, D.reports.length === 1 ? 'Report' : 'Reports')),
    h('div', { class: 'bar lg' }, fill(pct)));
}

function eventsCard() {
  const chatFor = (e) => D.conversations.find((c) => c.event_id === e.id && c.status === 'open');
  return h('section', { class: 'stack' },
    h('h2', { class: 'h2' }, 'Reported or suspended events'),
    h('p', { class: 'hint' }, 'Only events that someone reported, or that are suspended now, are listed. This host\'s other events stay private.'),
    D.flagged_events.length ? D.flagged_events.map((e) => {
      const chat = chatFor(e);
      return h('article', { class: 'bin-row card pad' },
        h('div', { class: 'bin-ic' }, icon(e.suspended_at ? 'lock' : 'flag', 22)),
        h('div', { class: 'grow' },
          h('div', { class: 'row gap-s wrap' }, h('b', null, e.title || 'Event'), e.suspended_at ? h('span', { class: 'badge suspended' }, 'Suspended') : null, e.in_bin ? h('span', { class: 'badge pending_deletion' }, 'In bin') : null, e.open_reports ? h('span', { class: 'badge pending_deletion' }, `${e.open_reports} open`) : null),
          h('p', { class: 'muted small' }, `${e.report_count} report${e.report_count === 1 ? '' : 's'}${e.last_report_at ? `, last ${formatDateTime(e.last_report_at)}` : ''}${e.suspended_at ? ` - suspended ${formatDateTime(e.suspended_at)}` : ''}`)),
        h('div', { class: 'row gap-s wrap' },
          e.suspended_at
            ? h('button', { class: 'btn primary sm', type: 'button', onclick: restoreEventAction(e.id, e.title, load) }, icon('restore', 16), 'Restore event')
            : h('button', { class: 'btn danger sm', type: 'button', onclick: suspendEventAction(e.id, e.title, load) }, 'Suspend event'),
          chat ? h('button', { class: 'btn secondary sm', type: 'button', onclick: () => openConversation(chat.id, load) }, icon('message', 16), 'Open chat') : null));
    }) : h('p', { class: 'muted card pad' }, 'No reported or suspended events for this host.'));
}

function reportsCard() {
  return h('section', { class: 'stack' }, h('h2', { class: 'h2' }, 'Report history'),
    D.reports.length ? D.reports.map((r) => h('article', { class: 'card pad' },
      h('div', { class: 'row gap-s wrap' }, h('b', null, r.event_title || 'Event (name not saved)'), h('span', { class: `badge ${r.status === 'open' ? 'pending_deletion' : ''}` }, r.status === 'open' ? 'Held for review' : r.status)),
      [r.folder_name ? `Folder: ${r.folder_name}` : null, r.file_name ? `File: ${r.file_name}` : null].filter(Boolean).length ? h('p', { class: 'muted small' }, [r.folder_name ? `Folder: ${r.folder_name}` : null, r.file_name ? `File: ${r.file_name}` : null].filter(Boolean).join(' - ')) : null,
      h('p', { class: 'rp-reason' }, r.reason),
      h('p', { class: 'muted small' }, formatDateTime(r.created_at)))) : h('p', { class: 'muted card pad' }, 'No reports on this host\'s events.'),
    D.reports.some((r) => r.status === 'open') ? h('a', { class: 'btn secondary sm', href: ROUTES.reports }, icon('eye', 16), 'Review open reports (view the file)') : null);
}

function chatsCard() {
  const open = D.conversations.filter((c) => c.status === 'open');
  const closed = D.conversations.filter((c) => c.status === 'closed');
  const row = (c) => convRow(c, (cid) => openConversation(cid, load), { showHost: false });
  return h('section', { class: 'stack' }, h('h2', { class: 'h2' }, 'Conversations'),
    open.length ? h('div', { class: 'conv-list' }, open.map(row)) : h('p', { class: 'muted card pad' }, 'No open conversation with this host.'),
    closed.length ? h('div', null, h('h3', { class: 'sec' }, 'Closed (history)'), h('div', { class: 'conv-list' }, closed.map(row))) : null);
}

function render() { mount(box, h('a', { class: 'btn ghost back-link', href: ROUTES.hosts }, icon('arrow-left', 18), 'All hosts'), headCard(), eventsCard(), reportsCard(), chatsCard()); }

async function main() {
  await requireAdmin({ active: 'hosts', role: 'super' });
  const app = document.getElementById('app');
  box = h('div', { class: 'stack' }, loading());
  mount(app, box);
  if (!id) { mount(box, emptyState('alert', 'No host chosen', 'Open a host from the list.', h('a', { class: 'btn primary', href: ROUTES.hosts }, 'Go to Hosts'))); return; }
  try { await load(); } catch (e) { mount(box, emptyState('alert', e.status === 404 ? 'Host not found' : 'Could not load this host', e.message, h('a', { class: 'btn primary', href: ROUTES.hosts }, 'Go to Hosts'))); }
}
main();
