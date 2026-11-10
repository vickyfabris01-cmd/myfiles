// js/admin/storage.js  -  the host's own storage dashboard: usage bar across all events, per-event usage, delete account.
import { requireAdmin, ROUTES } from './auth.js';
import { get, post } from '../api.js';
import { h, mount, formatBytes } from '../util.js';
import { icon } from '../icons.js';
import { showError, confirmDialog, withBusy, loading, emptyState, formDialog } from '../ui.js';
import { signOut } from '../supabase.js';
import { usageBar } from './usage-bar.js';

async function deleteAccount(btn) {
  const ok = await confirmDialog({
    title: 'Delete your account?', danger: true, confirmLabel: 'Continue',
    message: h('div', null,
      h('p', null, 'This permanently deletes ALL your events, folders, photos and videos, including everything in the recycle bin, and then your account.'),
      h('p', { class: 'danger-text' }, 'It cannot be undone and nobody can recover it.')),
  });
  if (!ok) return;
  const v = await formDialog({ title: 'Type DELETE to confirm', submitLabel: 'Delete everything', fields: [{ name: 'word', label: 'Type the word DELETE', required: true }] });
  if (!v || v.word !== 'DELETE') { if (v) showError(new Error('You must type DELETE exactly.')); return; }
  await withBusy(btn, async () => {
    try {
      let r = null;
      for (let i = 0; i < 8; i++) { // very large accounts finish in a few rounds
        try { r = await post('/admin/account/delete', { confirm: 'DELETE' }); break; } catch (e) { if (e.code !== 'ACCOUNT_DELETE_PARTIAL') throw e; }
      }
      if (!r) throw new Error('Still removing your files. Press Delete again in a minute to finish.');
      await signOut();
      location.replace(`${ROUTES.login}?reason=deleted`);
    } catch (e) { showError(e); }
  });
}

async function main() {
  await requireAdmin({ active: 'storage' });
  const app = document.getElementById('app');
  mount(app, loading());
  let s;
  try { s = await get('/admin/storage'); } catch (e) { mount(app, emptyState('alert', 'Could not load storage', e.message)); return; }
  const rows = s.events.map((e) => h('div', { class: 'u-row' },
    h('div', { class: 'grow' }, h('b', null, e.title), e.in_bin ? h('span', { class: 'badge pending_deletion' }, 'In bin') : null,
      e.bin_bytes > 0 ? h('p', { class: 'muted small' }, `${formatBytes(e.bin_bytes)} of this is in the recycle bin`) : null),
    h('b', null, formatBytes(e.total_bytes))));
  mount(app,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Storage'), h('p', { class: 'muted' }, `${formatBytes(s.used_bytes)} of ${formatBytes(s.quota_bytes)} used across all your events. Only you can see this.`))),
    h('section', { class: 'card pad' }, usageBar(s),
      s.bin_bytes > 0 ? h('p', { class: 'hint' }, 'Items in the recycle bin still use your space until they are permanently deleted. ', h('a', { href: ROUTES.bin }, 'Open the bin')) : null,
      h('p', { class: 'hint' }, `Limits: ${formatBytes(s.limits.video_bytes)} per video, ${formatBytes(s.limits.image_bytes)} per photo, ${s.max_active_events} active events (you have ${s.active_events}). Tip: recording video at 1080p instead of 4K often halves the size.`)),
    h('section', { class: 'card pad' }, h('h2', { class: 'h2' }, 'Usage by event'),
      rows.length ? h('div', { class: 'u-rows' }, rows) : h('p', { class: 'muted' }, 'No events yet.')),
    h('section', { class: 'card pad danger-zone' }, h('h2', { class: 'h2' }, 'Delete my account'),
      h('p', { class: 'muted' }, 'Permanently removes your account and every event, photo and video you uploaded.'),
      h('button', { class: 'btn danger', type: 'button', onclick: (e) => deleteAccount(e.currentTarget) }, icon('trash', 18), 'Delete my account')));
}
main();
