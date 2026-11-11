// js/admin/hosts.js  -  every host: search, filter by status, approve a new one, and open a host to do more.
import { requireAdmin } from './auth.js';
import { get } from '../api.js';
import { h, mount, formatBytes } from '../util.js';
import { icon } from '../icons.js';
import { loading, emptyState } from '../ui.js';
import { fill, pageHead, statusClass, hostAction, ROUTES } from './super-shared.js';

const S = { hosts: [], q: '', status: 'all' };
let box, list;

const FILTERS = [['all', 'All'], ['pending', 'Waiting'], ['active', 'Active'], ['suspended', 'Suspended']];

async function load() {
  S.hosts = (await get('/super/hosts')).hosts;
  draw();
}

function row(u) {
  const pct = u.quota_bytes ? Math.min(100, (u.used_bytes / u.quota_bytes) * 100) : 0;
  return h('article', { class: 'bin-row card pad' },
    h('a', { class: 'grow host-link', href: ROUTES.host(u.id) },
      h('div', { class: 'row gap-s wrap' }, h('b', null, u.name ? `${u.name} (${u.email})` : u.email), h('span', { class: `badge ${statusClass(u.status)}` }, u.status)),
      h('p', { class: 'muted small' }, `${u.events} active event${u.events === 1 ? '' : 's'} - ${formatBytes(u.used_bytes)} of ${formatBytes(u.quota_bytes)} used`),
      h('div', { class: 'bar' }, fill(pct))),
    h('div', { class: 'row gap-s wrap' },
      u.status === 'pending' ? h('button', { class: 'btn primary sm', type: 'button', onclick: hostAction(u, 'approve', 'Host approved', load) }, icon('check', 16), 'Approve') : null,
      h('a', { class: 'btn secondary sm', href: ROUTES.host(u.id) }, 'Open', icon('chevron', 16))));
}

function draw() {
  const q = S.q.trim().toLowerCase();
  const shown = S.hosts.filter((u) => (S.status === 'all' || u.status === S.status) && (!q || `${u.name || ''} ${u.email}`.toLowerCase().includes(q)));
  mount(list, shown.length ? shown.map(row) : emptyState('calendar', S.hosts.length ? 'No host matches' : 'No hosts yet', S.hosts.length ? 'Try another word or filter.' : 'People who sign up will appear here.'));
}

async function main() {
  await requireAdmin({ active: 'hosts', role: 'super' });
  const app = document.getElementById('app');
  box = h('div', { class: 'stack' }, loading());
  mount(app, box);
  list = h('div', { class: 'stack' });
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Search by name or email', 'aria-label': 'Search hosts' });
  search.addEventListener('input', () => { S.q = search.value; draw(); });
  const chips = h('div', { class: 'chips' }, FILTERS.map(([k, label]) => {
    const b = h('button', { class: `chip${S.status === k ? ' active' : ''}`, type: 'button', onclick: () => { S.status = k; chips.querySelectorAll('.chip').forEach((c, i) => c.classList.toggle('active', FILTERS[i][0] === k)); draw(); } }, label);
    return b;
  }));
  try { S.hosts = (await get('/super/hosts')).hosts; } catch (e) { mount(box, emptyState('alert', 'Could not load hosts', e.message)); return; }
  mount(box, pageHead('Hosts', 'Open a host to suspend or restore the host, add storage, send a message, or act on a reported event.'), h('div', { class: 'filters' }, search, chips), list);
  draw();
}
main();
