// js/admin/dashboard.js  -  events overview, create, quick publish, copy link, recently deleted + restore
import { requireAdmin, ROUTES } from './auth.js';
import { get, post } from '../api.js';
import { h, mount, formatBytes, formatEventDate, formatDateTime, timeLeft, copyText, debounce, todayNairobi, STATE_LABEL } from '../util.js';
import { icon } from '../icons.js';
import { toast, showError, formDialog, confirmDialog, withBusy, loading, emptyState } from '../ui.js';
import { usageBar } from './usage-bar.js';

const state = { tab: 'active', active: [], deleted: null, q: '' };
let listHost, statsHost, tabsHost, usageHost;

const badge = (e) => h('span', { class: `badge ${e.state}` }, STATE_LABEL[e.state] || e.state);

function cover(e) {
  return h('div', { class: 'cover' }, e.cover_url
    ? h('img', { src: e.cover_url, alt: '', loading: 'lazy', decoding: 'async' })
    : h('div', { class: 'cover-ph' }, icon('image', 28)));
}

function statusLine(e) {
  if (e.state === 'scheduled') return h('p', { class: 'meta' }, icon('clock', 15), `Publishes ${formatDateTime(e.publish_at)}`);
  if (e.state === 'published' && e.unpublish_at) return h('p', { class: 'meta' }, icon('clock', 15), `Unpublishes ${formatDateTime(e.unpublish_at)}`);
  if (e.state === 'pending_deletion') return h('p', { class: 'meta danger-text' }, icon('alert', 15), `Deleted permanently in ${timeLeft(e.recovery_deadline)} (${formatDateTime(e.recovery_deadline)})`);
  return null;
}

async function reload() {
  const [a, d] = await Promise.all([get('/admin/events'), state.deleted !== null || state.tab === 'deleted' ? get('/admin/events?status=deleted') : Promise.resolve(null)]);
  state.active = a.events;
  if (d) state.deleted = d.events;
  render();
}

function card(e) {
  const deleted = e.state === 'pending_deletion';
  const open = ROUTES.editor(e.id);
  const actions = deleted
    ? [h('button', { class: 'btn primary sm', type: 'button', onclick: (ev) => restore(e, ev.currentTarget) }, icon('restore', 16), 'Restore')]
    : [
        h('a', { class: 'btn secondary sm', href: open }, icon('edit', 16), 'Open'),
        h('button', { class: 'btn secondary sm', type: 'button', onclick: (ev) => copyLink(e, ev.currentTarget) }, icon('link', 16), 'Copy link'),
        h('button', { class: 'btn ghost sm', type: 'button', onclick: (ev) => togglePublish(e, ev.currentTarget) },
          icon(e.is_published ? 'eye-off' : 'eye', 16), e.is_published ? 'Unpublish' : e.state === 'scheduled' ? 'Publish now' : 'Publish'),
      ];
  return h('article', { class: `event-card${deleted ? ' is-deleted' : ''}` },
    deleted ? cover(e) : h('a', { class: 'cover-link', href: open, 'aria-label': `Open ${e.title}` }, cover(e)),
    h('div', { class: 'event-body' },
      h('div', { class: 'row between' }, badge(e), h('span', { class: 'muted small' }, `${e.file_count} file${e.file_count === 1 ? '' : 's'} - ${formatBytes(e.total_bytes)}`)),
      h('h3', { class: 'event-title' }, deleted ? e.title : h('a', { href: open }, e.title)),
      h('p', { class: 'meta' }, icon('calendar', 15), formatEventDate(e.event_date), e.location ? h('span', { class: 'dot' }, '') : null, e.location || null),
      statusLine(e),
      h('div', { class: 'row wrap gap-s event-actions' }, actions)));
}

function renderStats() {
  const a = state.active;
  const stat = (n, l) => h('div', { class: 'stat' }, h('b', null, n), h('span', null, l));
  mount(statsHost,
    stat(a.length, a.length === 1 ? 'Event' : 'Events'),
    stat(a.filter((e) => e.state === 'published').length, 'Published'),
    stat(a.reduce((s, e) => s + e.file_count, 0), 'Files'),
    stat(formatBytes(a.reduce((s, e) => s + e.total_bytes, 0)), 'Stored'));
}

function renderTabs() {
  const tab = (key, label, n) => h('button', { class: `tab${state.tab === key ? ' active' : ''}`, type: 'button', role: 'tab', 'aria-selected': String(state.tab === key), onclick: async () => {
    state.tab = key;
    if (key === 'deleted' && state.deleted === null) { mount(listHost, loading()); try { state.deleted = (await get('/admin/events?status=deleted')).events; } catch (e) { showError(e); state.deleted = []; } }
    render();
  } }, label, n ? h('span', { class: 'count' }, n) : null);
  mount(tabsHost, tab('active', 'Events', state.active.length), tab('deleted', 'Recently deleted', state.deleted ? state.deleted.length : 0));
}

function render() {
  renderStats(); renderTabs();
  const src = state.tab === 'active' ? state.active : state.deleted || [];
  const q = state.q.toLowerCase();
  const list = q ? src.filter((e) => `${e.title} ${e.location || ''}`.toLowerCase().includes(q)) : src;
  if (!list.length) {
    mount(listHost, state.tab === 'deleted'
      ? emptyState('trash', 'Nothing pending deletion', 'Deleted events stay here for 2 days so you can restore them. Deleted folders and files are in the Bin.')
      : q ? emptyState('search', 'No matching events', 'Try a different search.')
        : emptyState('calendar', 'No events yet', 'Create your first event, then upload photos and videos.', h('button', { class: 'btn primary', type: 'button', onclick: createEvent }, icon('plus', 18), 'New event')));
    return;
  }
  mount(listHost, h('div', { class: 'cards' }, list.map(card)));
}

async function copyLink(e, btn) {
  await withBusy(btn, async () => {
    try {
      const { url } = await get(`/admin/events/${e.id}/share-link`);
      const ok = await copyText(url);
      toast(ok ? (e.is_published ? 'Link copied' : 'Link copied. The event is not published yet.') : 'Could not copy automatically', ok ? 'success' : 'error');
    } catch (err) { showError(err); }
  });
}

async function togglePublish(e, btn) {
  await withBusy(btn, async () => {
    try {
      await post(`/admin/events/${e.id}/publish`, { published: !e.is_published });
      toast(e.is_published ? 'Event unpublished. Nothing was deleted.' : 'Event published', 'success');
      await reload();
    } catch (err) { showError(err); }
  });
}

async function restore(e, btn) {
  await withBusy(btn, async () => {
    try {
      await post(`/admin/events/${e.id}/restore`);
      toast('Event restored. It is unpublished until you publish it.', 'success');
      state.deleted = null; state.tab = 'active';
      await reload();
    } catch (err) { showError(err); }
  });
}

async function createEvent() {
  const v = await formDialog({
    title: 'New event', submitLabel: 'Create event',
    fields: [
      { name: 'title', label: 'Title', required: true, maxLength: 200, placeholder: 'e.g. Wanjiku and Otieno wedding' },
      { name: 'event_date', label: 'Event date', type: 'date', required: true, value: todayNairobi() },
      { name: 'location', label: 'Location (optional)', maxLength: 200 },
      { name: 'description', label: 'Description (optional)', type: 'textarea', maxLength: 5000 },
    ],
  });
  if (!v) return;
  try {
    const body = { title: v.title, event_date: v.event_date };
    if (v.location) body.location = v.location;
    if (v.description) body.description = v.description;
    const { event } = await post('/admin/events', body);
    location.href = ROUTES.editor(event.id);
  } catch (err) { showError(err); }
}

async function main() {
  await requireAdmin({ active: 'events' });
  const app = document.getElementById('app');
  statsHost = h('div', { class: 'stats' });
  usageHost = h('a', { class: 'card pad usage-compact', href: ROUTES.storage });
  tabsHost = h('div', { class: 'tabs', role: 'tablist' });
  listHost = h('div', null, loading());
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Search events', 'aria-label': 'Search events' });
  search.addEventListener('input', debounce(() => { state.q = search.value.trim(); render(); }, 150));
  mount(app,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Events'), h('p', { class: 'muted' }, 'Create events, upload originals and share a private link.')),
      h('button', { class: 'btn primary', type: 'button', onclick: createEvent }, icon('plus', 18), 'New event')),
    statsHost, usageHost,
    h('div', { class: 'toolbar' }, tabsHost, h('div', { class: 'search' }, icon('search', 18), search)),
    listHost);
  get('/admin/storage').then((s) => mount(usageHost, h('b', null, 'Your storage'), usageBar(s), h('p', { class: 'hint' }, 'Tap for details, the recycle bin and account options.'))).catch(() => usageHost.remove());
  try { await reload(); } catch (e) { mount(listHost, emptyState('alert', 'Could not load events', e.message, h('button', { class: 'btn primary', type: 'button', onclick: () => location.reload() }, 'Try again'))); }
}
main();
