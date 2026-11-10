// js/admin/bin.js  -  recycle bin: deleted events, folders and files, each with its own 2-day timer.
import { requireAdmin, ROUTES } from './auth.js';
import { get, post } from '../api.js';
import { h, mount, formatBytes, timeLeft, formatDateTime } from '../util.js';
import { icon } from '../icons.js';
import { toast, showError, confirmDialog, withBusy, loading, emptyState } from '../ui.js';

const ICON = { event: 'calendar', folder: 'folder', file: 'image' };
const WORD = { event: 'Event', folder: 'Folder', file: 'File' };
const BLOCK_MSG = { event: 'Restore the event first', folder: 'Restore the folder first' };
let host;

async function load() {
  const data = await get('/admin/bin');
  render(data);
}

async function restore(i, btn) {
  await withBusy(btn, async () => {
    try {
      await post('/admin/bin/restore', { kind: i.kind, id: i.id });
      toast(i.kind === 'event' ? 'Event restored. It is unpublished until you publish it.' : `${WORD[i.kind]} restored`, 'success');
      await load();
    } catch (e) { showError(e); }
  });
}

async function removeForever(i, btn) {
  const ok = await confirmDialog({
    title: `Delete this ${i.kind} forever?`, danger: true, confirmLabel: 'Delete forever',
    message: i.kind === 'event' ? 'The event and everything in it, including items binned separately, is permanently deleted and the space is freed.'
      : i.kind === 'folder' ? 'The folder and everything in it is permanently deleted and the space is freed.' : 'The file is permanently deleted and the space is freed.',
  });
  if (!ok) return;
  await withBusy(btn, async () => { try { await post('/admin/bin/delete', { kind: i.kind, id: i.id }); toast('Deleted permanently', 'success'); await load(); } catch (e) { showError(e); } });
}

async function emptyAll(btn) {
  const ok = await confirmDialog({ title: 'Empty the recycle bin?', danger: true, confirmLabel: 'Empty bin', message: 'Everything in the bin is permanently deleted and the space is freed. This cannot be undone.' });
  if (!ok) return;
  await withBusy(btn, async () => {
    try {
      for (let i = 0; i < 200; i++) { const r = await post('/admin/bin/empty'); if (!r.remaining || !r.deleted) break; }
      toast('Recycle bin emptied', 'success');
      await load();
    } catch (e) { showError(e); }
  });
}

function row(i) {
  const blocked = i.blocked_by ? BLOCK_MSG[i.blocked_by] : null;
  const detail = i.kind === 'event' ? `${i.file_count} file${i.file_count === 1 ? '' : 's'}`
    : i.kind === 'folder' ? `${i.file_count} file${i.file_count === 1 ? '' : 's'} inside - from ${i.event_title}` : `from ${i.event_title}`;
  return h('article', { class: 'bin-row card pad' },
    h('div', { class: 'bin-ic' }, icon(ICON[i.kind], 22)),
    h('div', { class: 'grow' },
      h('div', { class: 'row gap-s wrap' }, h('b', null, i.name), h('span', { class: 'badge' }, WORD[i.kind])),
      h('p', { class: 'muted small' }, `${detail} - ${formatBytes(i.size_bytes)}`),
      h('p', { class: 'meta danger-text' }, icon('clock', 15), `Deleted permanently in ${timeLeft(i.purge_after)} (${formatDateTime(i.purge_after)})`),
      blocked ? h('p', { class: 'banner warn flat' }, icon('info', 18), h('span', null, blocked)) : null),
    h('div', { class: 'row gap-s wrap' },
      h('button', { class: 'btn primary sm', type: 'button', disabled: !!blocked, onclick: (e) => restore(i, e.currentTarget) }, icon('restore', 16), 'Restore'),
      h('button', { class: 'btn ghost sm danger-text', type: 'button', onclick: (e) => removeForever(i, e.currentTarget) }, icon('trash', 16), 'Delete forever')));
}

function render(data) {
  const total = data.items.reduce((s, i) => s + i.size_bytes, 0);
  mount(host,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Recycle bin'),
      h('p', { class: 'muted' }, `Deleted events, folders and files stay here for ${data.retention_days} days, then they are permanently deleted. They still use your storage (${formatBytes(total)} now).`)),
      data.items.length ? h('button', { class: 'btn danger', type: 'button', onclick: (e) => emptyAll(e.currentTarget) }, icon('trash', 18), 'Empty bin') : null),
    data.items.length ? h('div', { class: 'stack' }, data.items.map(row))
      : emptyState('trash', 'The recycle bin is empty', 'Things you delete show up here for 2 days so you can bring them back.', h('a', { class: 'btn primary', href: ROUTES.events }, 'Back to events')));
}

async function main() {
  await requireAdmin({ active: 'bin' });
  const app = document.getElementById('app');
  host = h('div', null, loading());
  mount(app, host);
  try { await load(); } catch (e) { mount(host, emptyState('alert', 'Could not load the bin', e.message)); }
}
main();
