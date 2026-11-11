// js/admin/events.js  -  event editor: details, cover mode, publishing, scheduling, share link, delete / restore
import { requireAdmin, ROUTES } from './auth.js';
import { get, post, patch, del } from '../api.js';
import { h, mount, formatBytes, formatEventDate, formatDateTime, timeLeft, copyText, toInputValue, fromInputValue, nowInputValue, STATE_LABEL } from '../util.js';
import { icon } from '../icons.js';
import { toast, showError, confirmDialog, withBusy, loading, emptyState, openModal } from '../ui.js';
import { positionCover } from './cover-position.js';
import { mountBrowser } from './folders.js';

const params = new URLSearchParams(location.search);
const id = params.get('id');
let event = null;
let browser = null;
let tab = (location.hash || '#media').slice(1);
const el = {};

const readOnly = () => event.state === 'pending_deletion';
const suspended = () => !!event.suspended;
const badge = () => h('span', { class: `badge ${event.state}` }, STATE_LABEL[event.state] || event.state);

function setEvent(e) {
  event = e;
  renderHead(); renderBanner(); renderPanels();
  if (browser) browser.setReadOnly(readOnly());
}

async function refresh() { setEvent((await get(`/admin/events/${id}`)).event); }

/* ---------- header + banner ---------- */
function renderHead() {
  document.title = `${event.title} - MyFiles`;
  const actions = readOnly() || suspended() ? [] : [
    h('button', { class: 'btn secondary', type: 'button', onclick: openShare }, icon('link', 18), 'Share'),
    h('button', { class: 'btn secondary', type: 'button', onclick: openSchedule }, icon('clock', 18), event.publish_at || event.unpublish_at ? 'Scheduled' : 'Schedule'),
    h('button', { class: `btn ${event.is_published ? 'secondary' : 'primary'}`, type: 'button', onclick: (e) => togglePublish(e.currentTarget) },
      icon(event.is_published ? 'eye-off' : 'eye', 18), event.is_published ? 'Unpublish' : event.state === 'scheduled' ? 'Publish now' : 'Publish'),
  ];
  mount(el.head,
    h('a', { class: 'back', href: ROUTES.events }, icon('arrow-left', 18), 'All events'),
    h('div', { class: 'page-head tight' },
      h('div', null, h('div', { class: 'row gap-s wrap' }, h('h1', null, event.title), badge()),
        h('p', { class: 'meta' }, icon('calendar', 15), formatEventDate(event.event_date), event.location ? h('span', { class: 'dot' }, '') : null, event.location || null,
          h('span', { class: 'dot' }, ''), `${event.file_count} file${event.file_count === 1 ? '' : 's'}, ${formatBytes(event.total_bytes)}`)),
      h('div', { class: 'row gap-s wrap' }, actions)));
}

function renderBanner() {
  if (suspended() && !readOnly()) {
    mount(el.banner, h('div', { class: 'banner danger' }, icon('alert', 20), h('div', { class: 'grow' }, h('b', null, 'This event has been suspended'), h('p', null, 'Its link is switched off and it cannot be published. Your files are not deleted. ', h('a', { href: ROUTES.messages }, 'Open your messages'), ' to read why and to reply.'))));
    return;
  }
  if (!readOnly()) { mount(el.banner); return; }
  mount(el.banner, h('div', { class: 'banner danger' },
    icon('alert', 20),
    h('div', { class: 'grow' }, h('b', null, 'This event is pending deletion'),
      h('p', null, `Visitors can no longer open it. It will be permanently deleted in ${timeLeft(event.recovery_deadline)} (${formatDateTime(event.recovery_deadline)}). Restore it before then to keep everything.`)),
    h('button', { class: 'btn primary', type: 'button', onclick: (e) => restore(e.currentTarget) }, icon('restore', 18), 'Restore event')));
}

/* ---------- actions ---------- */
async function togglePublish(btn) {
  await withBusy(btn, async () => {
    try {
      const r = await post(`/admin/events/${id}/publish`, { published: !event.is_published });
      setEvent(r.event);
      toast(r.event.is_published ? 'Event published' : 'Event unpublished. Nothing was deleted.', 'success');
    } catch (e) { showError(e); }
  });
}

async function restore(btn) {
  await withBusy(btn, async () => {
    try { const r = await post(`/admin/events/${id}/restore`); setEvent(r.event); toast('Event restored. Publish it when you are ready.', 'success'); } catch (e) { showError(e); }
  });
}

async function deleteEvent() {
  const until = formatDateTime(new Date(Date.now() + 2 * 86400000).toISOString());
  const ok = await confirmDialog({
    title: 'Delete this event?', danger: true, confirmLabel: 'Delete event',
    message: h('div', null,
      h('p', null, 'The event link stops working immediately.'),
      h('p', null, `It moves to the recycle bin. You can restore it until ${until}. After that the event, its folders and all original photos and videos are permanently deleted.`),
      h('p', { class: 'muted' }, 'To hide an event without deleting anything, use Unpublish instead.')),
  });
  if (!ok) return;
  try { const r = await del(`/admin/events/${id}`); setEvent(r.event); toast('Event moved to the recycle bin', 'success'); } catch (e) { showError(e); }
}

async function openShare() {
  try {
    const { url } = await get(`/admin/events/${id}/share-link`);
    const { openModal } = await import('../ui.js');
    const input = h('input', { class: 'input', readonly: true, value: url, 'aria-label': 'Share link' });
    input.addEventListener('focus', () => input.select());
    const m = openModal({
      title: 'Share link', className: 'small',
      body: h('div', { class: 'stack' },
        event.is_published ? h('p', { class: 'muted' }, 'Anyone with this link can view and download this event.')
          : h('p', { class: 'banner warn flat' }, icon('info', 18), h('span', null, 'This event is not published. Visitors will see "not available" until you publish it.')),
        input),
      footer: [
        h('a', { class: 'btn secondary', href: url, target: '_blank', rel: 'noopener noreferrer' }, icon('external', 18), 'Open'),
        h('button', { class: 'btn primary', type: 'button', onclick: async () => { toast((await copyText(url)) ? 'Link copied' : 'Press and hold to copy', 'success'); } }, icon('copy', 18), 'Copy link')],
    });
    return m;
  } catch (e) { showError(e); }
}

async function regenerate() {
  const ok = await confirmDialog({ title: 'Create a new link?', danger: true, confirmLabel: 'Create new link', message: 'The current link will stop working for everyone who has it. Use this only if the link was shared by mistake.' });
  if (!ok) return;
  try { const { url } = await post(`/admin/events/${id}/share-link/regenerate`); await copyText(url); toast('New link created and copied. The old link no longer works.', 'success'); renderPanels(); } catch (e) { showError(e); }
}

async function adjustCover() {
  const p = await positionCover({ src: event.cover_url, kind: 'event', x: event.cover_pos_x, y: event.cover_pos_y, title: 'Position event cover' });
  if (!p) return;
  try { const r = await patch(`/admin/events/${id}`, { cover_pos_x: p.x, cover_pos_y: p.y }); setEvent(r.event); toast('Cover position saved', 'success'); } catch (e) { showError(e); }
}

/* ---------- details panel ---------- */
// Files are named Event_Folder_YYYY-MM-DD-HH-MM-SS.ext automatically. This button also names files uploaded before that existed.
function namingCard(ro) {
  const btn = h('button', { class: 'btn secondary sm', type: 'button', disabled: ro, onclick: async (e) => {
    if (!(await confirmDialog({ title: 'Apply the naming to all files?', confirmLabel: 'Rename files', message: 'Every file in this event is renamed to Event_Folder_Date-Time, for example "Amina-Wedding_Reception_2026-11-11-11-18-54.jpg". Files you renamed by hand keep their names. Nothing else changes.' }))) return;
    await withBusy(e.currentTarget, async () => {
      try { const r = await post(`/admin/events/${id}/rename-files`); toast(r.renamed ? `${r.renamed} file${r.renamed === 1 ? '' : 's'} renamed` : 'All files already follow the naming', 'success'); } catch (err) { showError(err); }
    });
  } }, icon('edit', 16), 'Apply to all files');
  return h('div', { class: 'stack' }, h('h3', { class: 'h3' }, 'File names'),
    h('p', { class: 'hint' }, 'New uploads are named Event_Folder_Date-Time automatically, and the names follow when you rename the event or a folder, or move files. A name you type yourself on a file is never changed.'), h('div', null, btn));
}

function detailsPanel() {
  const ro = readOnly();
  const f = {
    title: h('input', { class: 'input', name: 'title', required: true, maxlength: 200, value: event.title, disabled: ro }),
    date: h('input', { class: 'input', type: 'date', required: true, value: event.event_date, disabled: ro }),
    location: h('input', { class: 'input', maxlength: 200, value: event.location || '', disabled: ro }),
    description: h('textarea', { class: 'input', rows: 4, maxlength: 5000, disabled: ro, value: event.description || '' }),
  };
  const save = h('button', { class: 'btn primary', type: 'submit', disabled: ro }, 'Save changes');
  const form = h('form', { class: 'form', novalidate: true },
    h('label', { class: 'field' }, h('span', { class: 'label' }, 'Title'), f.title),
    h('div', { class: 'grid2' },
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'Event date'), f.date),
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'Location'), f.location)),
    h('label', { class: 'field' }, h('span', { class: 'label' }, 'Description'), f.description),
    h('div', null, save));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!f.title.value.trim() || !f.date.value) { toast('Title and date are required', 'error'); return; }
    await withBusy(save, async () => {
      try {
        const r = await patch(`/admin/events/${id}`, { title: f.title.value.trim(), event_date: f.date.value, location: f.location.value.trim() || null, description: f.description.value.trim() || null });
        setEvent(r.event); toast('Details saved', 'success');
      } catch (err) { showError(err); }
    });
  });

  const seg = (mode, label) => h('button', { class: `seg-btn${event.cover_mode === mode ? ' active' : ''}`, type: 'button', disabled: ro, onclick: async () => {
    if (event.cover_mode === mode) return;
    if (mode === 'manual' && !event.cover_file_id) { toast('Open Media, select a file and choose "Set as cover" first.', 'info', 6000); switchTab('media'); return; }
    try { const r = await patch(`/admin/events/${id}`, { cover_mode: mode }); setEvent(r.event); toast(mode === 'auto' ? 'Cover is now automatic' : 'Cover is now the file you picked', 'success'); } catch (err) { showError(err); }
  } }, label);

  return h('div', { class: 'two-col' },
    h('section', { class: 'card pad stack' }, h('h2', { class: 'h2' }, 'Event details'), form, namingCard(ro)),
    h('section', { class: 'card pad' }, h('h2', { class: 'h2' }, 'Cover'),
      h('div', { class: 'cover wide' }, event.cover_url ? h('img', { src: event.cover_url, alt: 'Current cover', decoding: 'async', style: `object-position:${event.cover_pos_x ?? 50}% ${event.cover_pos_y ?? 50}%` }) : h('div', { class: 'cover-ph' }, icon('image', 32))),
      event.cover_url && event.cover_mode === 'manual' && !ro ? h('div', { class: 'row gap-s' }, h('button', { class: 'btn secondary sm', type: 'button', onclick: adjustCover }, icon('move', 16), 'Adjust position')) : null,
      h('div', { class: 'seg', role: 'group', 'aria-label': 'Cover mode' }, seg('auto', 'Automatic'), seg('manual', 'Chosen file')),
      h('p', { class: 'hint' }, event.cover_mode === 'auto'
        ? 'Automatic uses the newest photo or video thumbnail.'
        : 'Using the file you chose. If it is deleted, the newest thumbnail is used instead.'),
      h('p', { class: 'hint' }, 'To choose a cover: open Media, tap any photo and choose Set as cover. You can then drag it to pick the visible area.')));
}

/* ---------- publishing panel ---------- */
function scheduleRow(kind, after = () => {}) {
  const label = kind === 'publish_at' ? 'Publish at' : 'Unpublish at';
  const cur = event[kind];
  const input = h('input', { class: 'input', type: 'datetime-local', min: nowInputValue(), value: cur ? toInputValue(cur) : '', 'aria-label': label });
  const call = async (value, msg) => {
    try { const r = await post(`/admin/events/${id}/schedule`, { [kind]: value }); setEvent(r.event); toast(msg, 'success'); after(); } catch (e) { showError(e); }
  };
  const save = h('button', { class: 'btn primary sm', type: 'button', onclick: () => {
    if (!input.value) { toast('Pick a date and time first', 'error'); return; }
    if (Date.parse(fromInputValue(input.value)) <= Date.now()) { toast('Choose a time in the future', 'error'); return; }
    call(fromInputValue(input.value), cur ? 'Schedule changed' : 'Scheduled');
  } }, cur ? 'Change' : 'Schedule');
  const cancel = cur ? h('button', { class: 'btn ghost sm', type: 'button', onclick: () => call(null, 'Schedule cancelled') }, 'Cancel schedule') : null;
  return h('div', { class: 'sched' },
    h('div', { class: 'row gap-s wrap' }, icon('clock', 18), h('b', null, label), cur ? h('span', { class: 'badge scheduled' }, formatDateTime(cur)) : h('span', { class: 'muted small' }, 'Not scheduled')),
    h('div', { class: 'row gap-s wrap' }, input, save, cancel));
}

// Schedule window: opened from the Schedule button in the page header.
function openSchedule() {
  const m = openModal({
    title: 'Schedule publishing', className: 'small',
    body: h('div', { class: 'stack' },
      h('p', { class: 'hint' }, 'Pick the date and time the event goes live and/or goes offline. Times are Nairobi time (EAT) and are checked every minute. Nothing is deleted when an event goes offline.'),
      event.is_published
        ? h('p', { class: 'banner warn flat' }, icon('info', 18), h('span', null, 'The event is live now, so only a time to go offline can be set. Unpublish it first if you want to schedule when it goes live.'))
        : scheduleRow('publish_at', () => m.close()),
      scheduleRow('unpublish_at', () => m.close())),
    footer: h('button', { class: 'btn secondary', type: 'button', onclick: () => m.close() }, 'Close'),
  });
}

function publishingPanel() {
  if (readOnly()) {
    return h('section', { class: 'card pad' }, emptyState('trash', 'Event pending deletion', `Restore it to publish or schedule again. Permanent deletion on ${formatDateTime(event.recovery_deadline)}.`,
      h('button', { class: 'btn primary', type: 'button', onclick: (e) => restore(e.currentTarget) }, icon('restore', 18), 'Restore event')));
  }
  const msg = {
    published: 'Visitors with the link can view and download this event.',
    unpublished: 'Hidden. Visitors who open the link see that the event is not available. Nothing is deleted.',
    scheduled: `Hidden for now. It will publish on ${event.publish_at ? formatDateTime(event.publish_at) : ''}.`,
  }[event.state];
  const linkBox = h('div', { class: 'linkbox' }, h('span', { class: 'muted small' }, 'Loading link...'));
  get(`/admin/events/${id}/share-link`).then(({ url }) => {
    mount(linkBox, h('input', { class: 'input', readonly: true, value: url, 'aria-label': 'Share link' }),
      h('div', { class: 'row gap-s wrap' },
        h('button', { class: 'btn primary sm', type: 'button', onclick: async () => toast((await copyText(url)) ? 'Link copied' : 'Press and hold to copy', 'success') }, icon('copy', 16), 'Copy'),
        h('a', { class: 'btn secondary sm', href: url, target: '_blank', rel: 'noopener noreferrer' }, icon('external', 16), 'Open'),
        h('button', { class: 'btn ghost sm danger-text', type: 'button', onclick: regenerate }, icon('refresh', 16), 'New link')));
  }).catch((e) => mount(linkBox, h('p', { class: 'danger-text small' }, e.code === 'TOKEN_UNRECOVERABLE' ? 'This link cannot be shown any more. Create a new link.' : e.message),
    h('button', { class: 'btn secondary sm', type: 'button', onclick: regenerate }, 'Create new link')));

  return h('div', { class: 'two-col' },
    h('div', { class: 'stack' },
      h('section', { class: 'card pad' }, h('h2', { class: 'h2' }, 'Status'),
        h('div', { class: 'row gap-s' }, badge()), h('p', { class: 'muted' }, msg),
        h('button', { class: `btn ${event.is_published ? 'secondary' : 'primary'}`, type: 'button', onclick: (e) => togglePublish(e.currentTarget) },
          icon(event.is_published ? 'eye-off' : 'eye', 18), event.is_published ? 'Unpublish' : event.state === 'scheduled' ? 'Publish now' : 'Publish now')),
      h('section', { class: 'card pad' }, h('h2', { class: 'h2' }, 'Schedule'),
        h('p', { class: 'hint' }, 'Times are in Nairobi time (EAT). Checked every minute.'),
        event.is_published ? h('p', { class: 'hint' }, 'The event is live now, so only a time to go offline can be set.') : null,
        event.is_published ? null : scheduleRow('publish_at'), scheduleRow('unpublish_at'))),
    h('div', { class: 'stack' },
      h('section', { class: 'card pad' }, h('h2', { class: 'h2' }, 'Share link'), h('p', { class: 'hint' }, 'The same link keeps working across unpublish and publish.'), linkBox),
      h('section', { class: 'card pad danger-zone' }, h('h2', { class: 'h2' }, 'Delete event'),
        h('p', { class: 'muted' }, 'Deleting is separate from unpublishing. The link stops working at once, and you have 2 days to restore everything from the recycle bin.'),
        h('button', { class: 'btn danger', type: 'button', onclick: deleteEvent }, icon('trash', 18), 'Delete event'))));
}

/* ---------- tabs ---------- */
function switchTab(t) {
  tab = ['media', 'details', 'publishing'].includes(t) ? t : 'media';
  history.replaceState(null, '', `${location.pathname}${location.search}#${tab}`);
  renderTabs();
  for (const k of ['media', 'details', 'publishing']) el.panels[k].hidden = k !== tab;
}

function renderTabs() {
  const t = (k, label, ic) => h('button', { class: `tab${tab === k ? ' active' : ''}`, type: 'button', role: 'tab', 'aria-selected': String(tab === k), onclick: () => switchTab(k) }, icon(ic, 18), label);
  mount(el.tabs, t('media', 'Media', 'image'), t('details', 'Details', 'edit'), t('publishing', 'Publishing', 'eye'));
}

function renderPanels() {
  mount(el.panels.details, detailsPanel());
  mount(el.panels.publishing, publishingPanel());
}

async function main() {
  await requireAdmin({ active: 'events' });
  const app = document.getElementById('app');
  if (!id) { mount(app, emptyState('alert', 'No event selected', 'Open an event from the events list.', h('a', { class: 'btn primary', href: ROUTES.events }, 'Go to events'))); return; }
  mount(app, loading());
  try { event = (await get(`/admin/events/${id}`)).event; }
  catch (e) { mount(app, emptyState('alert', e.status === 404 ? 'Event not found' : 'Could not load event', e.message, h('a', { class: 'btn primary', href: ROUTES.events }, 'Back to events'))); return; }

  el.head = h('div'); el.banner = h('div'); el.tabs = h('div', { class: 'tabs', role: 'tablist' });
  el.panels = { media: h('div'), details: h('div', { hidden: true }), publishing: h('div', { hidden: true }) };
  mount(app, el.head, el.banner, el.tabs, el.panels.media, el.panels.details, el.panels.publishing);

  browser = mountBrowser(el.panels.media, { event, readOnly: readOnly(), onChanged: () => refresh().catch(() => {}) });
  setEvent(event);
  switchTab(tab);
  window.addEventListener('hashchange', () => switchTab(location.hash.slice(1)));
}
main();
