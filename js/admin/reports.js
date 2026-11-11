// js/admin/reports.js  -  reports from the public "Report" link, and every suspended event.
// An open report can be reviewed (the ONE reported file), actioned or dismissed. A dismissed or actioned report is not a dead end:
// the host can be opened, and the event can be suspended again (or restored) from here.
import { requireAdmin } from './auth.js';
import { get, post } from '../api.js';
import { h, mount, formatDateTime } from '../util.js';
import { icon } from '../icons.js';
import { loading, emptyState, showError, openModal } from '../ui.js';
import { act, CANCEL, DEFAULT, askMessage, sendMsg, hostLabel, pageHead, suspendEventAction, restoreEventAction, openConversation, ROUTES } from './super-shared.js';

const S = { reports: [], suspended: [], showAll: false };
let box;

async function load() {
  const [rp, se] = await Promise.all([get(`/super/reports${S.showAll ? '?status=all' : ''}`), get('/super/suspended-events')]);
  S.reports = rp.reports; S.suspended = se.events;
  render();
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
  const where = [r.folder_name ? `Folder: ${r.folder_name}` : null, r.file_name ? `File: ${r.file_name}` : null].filter(Boolean);
  const title = r.event_title || 'this event';
  return h('article', { class: 'bin-row card pad' },
    h('div', { class: 'bin-ic' }, icon('flag', 22)),
    h('div', { class: 'grow' },
      h('div', { class: 'row gap-s wrap' }, h('b', null, r.event_title || 'Event (name not saved)'), h('span', { class: `badge ${open ? 'pending_deletion' : ''}` }, open ? 'Held for review' : r.status), r.event_suspended ? h('span', { class: 'badge suspended' }, 'Event suspended') : null),
      h('p', { class: 'muted small' }, `Host: ${hostLabel(r)}`),
      where.length ? h('p', { class: 'muted small' }, where.join(' - ')) : null,
      h('p', { class: 'rp-reason' }, r.reason),
      h('p', { class: 'muted small' }, `${formatDateTime(r.created_at)} - ${r.report_count} report${r.report_count === 1 ? '' : 's'} on this event.${r.media_views ? ` The file was opened ${r.media_views} time${r.media_views === 1 ? '' : 's'}.` : ''}`)),
    h('div', { class: 'row gap-s wrap' },
      open && r.file_name && r.has_file ? h('button', { class: 'btn secondary sm', type: 'button', onclick: () => viewFile(r) }, icon('eye', 16), 'View file') : null,
      open ? h('button', { class: 'btn danger sm', type: 'button', onclick: act(async () => {
        const m = await askMessage({ title: 'Suspend this event?', intro: 'Its link stops working at once and the host cannot publish it again. Nothing is deleted. The host is told in Messages and can reply.', text: DEFAULT.eventOff(title), submitLabel: 'Suspend event' });
        if (m === null) throw CANCEL;
        return sendMsg(`/super/reports/${r.id}/suspend-event`, m);
      }, 'Event suspended', load) }, 'Suspend event') : null,
      open ? h('button', { class: 'btn secondary sm', type: 'button', onclick: act(async () => {
        const m = await askMessage({ title: 'Suspend this host?', intro: 'All their links and uploads stop at once. Their data is kept. The host is told in Messages and can reply.', text: DEFAULT.hostOff(), submitLabel: 'Suspend host' });
        if (m === null) throw CANCEL;
        return sendMsg(`/super/reports/${r.id}/suspend-host`, m);
      }, 'Host suspended', load) }, 'Suspend host') : null,
      open ? h('button', { class: 'btn ghost sm', type: 'button', onclick: act(() => post(`/super/reports/${r.id}/dismiss`), 'Report dismissed', load) }, 'Dismiss') : null,
      // A closed report is not the end: suspend the event again, or undo a suspension, and open the host for everything else.
      !open && !r.event_suspended ? h('button', { class: 'btn danger sm', type: 'button', onclick: suspendEventAction(r.event_id, title, load) }, 'Suspend event') : null,
      !open && r.event_suspended ? h('button', { class: 'btn secondary sm', type: 'button', onclick: restoreEventAction(r.event_id, title, load) }, icon('restore', 16), 'Undo suspension') : null,
      r.host_id ? h('a', { class: 'btn secondary sm', href: ROUTES.host(r.host_id) }, 'Open host', icon('chevron', 16)) : null));
}

function reportsCard() {
  const openCount = S.reports.filter((r) => r.status === 'open').length;
  const toggle = h('button', { class: 'btn ghost sm', type: 'button', onclick: async () => { S.showAll = !S.showAll; await load(); } }, S.showAll ? 'Show open only' : 'Show history');
  return h('section', { class: 'stack' },
    h('div', { class: 'row between' }, h('h2', { class: 'h2' }, `${S.showAll ? 'All reports' : 'Open reports'}${openCount ? ` (${openCount} open)` : ''}`), toggle),
    S.reports.length ? S.reports.map(reportCard) : h('p', { class: 'muted card pad' }, S.showAll ? 'No reports yet.' : 'No open reports. When a visitor uses the Report link on an event page, it appears here.'));
}

function suspendedCard() {
  if (!S.suspended.length) return null;
  return h('section', { class: 'stack' }, h('h2', { class: 'h2' }, `Suspended events (${S.suspended.length})`),
    S.suspended.map((e) => h('article', { class: 'bin-row card pad' },
      h('div', { class: 'bin-ic' }, icon('lock', 22)),
      h('div', { class: 'grow' }, h('b', null, e.title), h('p', { class: 'muted small' }, `Host: ${hostLabel(e)}${e.suspended_at ? ` - suspended ${formatDateTime(e.suspended_at)}` : ''}`)),
      h('div', { class: 'row gap-s wrap' },
        h('button', { class: 'btn primary sm', type: 'button', onclick: restoreEventAction(e.id, e.title, load) }, icon('restore', 16), 'Restore'),
        e.conversation_id ? h('button', { class: 'btn secondary sm', type: 'button', onclick: () => openConversation(e.conversation_id, load) }, icon('message', 16), 'Open chat') : null,
        e.host_id ? h('a', { class: 'btn secondary sm', href: ROUTES.host(e.host_id) }, 'Open host', icon('chevron', 16)) : null))));
}

function render() { mount(box, pageHead('Reports', 'Reports from visitors, and every event that is suspended now.'), reportsCard(), suspendedCard()); }

async function main() {
  await requireAdmin({ active: 'reports', role: 'super' });
  const app = document.getElementById('app');
  box = h('div', { class: 'stack' }, loading());
  mount(app, box);
  try { await load(); } catch (e) { mount(box, emptyState('alert', 'Could not load reports', e.message)); }
}
main();
