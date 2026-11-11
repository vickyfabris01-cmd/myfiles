// js/admin/conversations.js  -  the owner's conversations with hosts: open ones first, closed ones as history.
// Suspending an event or an account starts one automatically. To start one yourself, open a host and press Message.
import { requireAdmin } from './auth.js';
import { get } from '../api.js';
import { h, mount } from '../util.js';
import { icon } from '../icons.js';
import { loading, emptyState } from '../ui.js';
import { pageHead, convRow, openConversation, ROUTES } from './super-shared.js';

const S = { convs: [], showClosed: false };
let box;

async function load() {
  S.convs = (await get('/super/conversations?status=all')).conversations;
  render();
}

function render() {
  const open = S.convs.filter((c) => c.status === 'open');
  const closed = S.convs.filter((c) => c.status === 'closed');
  const unread = open.filter((c) => c.unread).length;
  const row = (c) => convRow(c, (id) => openConversation(id, load));
  mount(box,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, `Conversations${unread ? ` (${unread} new repl${unread === 1 ? 'y' : 'ies'})` : ''}`), h('p', { class: 'muted' }, 'Only you start and close a conversation. Hosts can reply while it is open.')),
      h('button', { class: 'btn secondary', type: 'button', onclick: () => load().catch(() => {}) }, icon('refresh', 18), 'Refresh')),
    open.length ? h('div', { class: 'conv-list' }, open.map(row))
      : emptyState('message', 'No open conversations', 'Suspending an event or an account starts one automatically. You can also start one from a host\'s page.', h('a', { class: 'btn primary', href: ROUTES.hosts }, 'Go to Hosts')),
    closed.length ? h('div', null, h('div', { class: 'row between' }, h('h2', { class: 'sec' }, `History (${closed.length})`),
      h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { S.showClosed = !S.showClosed; render(); } }, S.showClosed ? 'Hide' : 'Show')),
      S.showClosed ? h('div', { class: 'conv-list' }, closed.map(row)) : null) : null);
}

async function main() {
  await requireAdmin({ active: 'conversations', role: 'super' });
  const app = document.getElementById('app');
  box = h('div', { class: 'stack' }, loading());
  mount(app, box);
  try { await load(); } catch (e) { mount(box, emptyState('alert', 'Could not load conversations', e.message)); return; }
  const c = new URLSearchParams(location.search).get('c');
  if (c) { history.replaceState(null, '', location.pathname); openConversation(c, load); }
}
main();
