// js/admin/messages.js  -  the host's messages from the service owner.
// Works for pending and suspended accounts too, so a suspended host can read why and reply.
// Only the owner starts and closes a conversation. A closed one stays here for history.
import { requireAdmin, ROUTES } from './auth.js';
import { get, post } from '../api.js';
import { h, mount, formatDateTime } from '../util.js';
import { icon } from '../icons.js';
import { loading, emptyState, showError } from '../ui.js';
import { createThread } from './thread.js';

const app = document.getElementById('app');
const KIND = { event_suspended: 'Event', account_suspended: 'Account', general: 'Message' };
let admin = null;
let timer = null;

const tell = (n) => window.dispatchEvent(new CustomEvent('myfiles:unread', { detail: n }));
const stop = () => { if (timer) { clearInterval(timer); timer = null; } };

async function showList() {
  stop();
  history.replaceState(null, '', location.pathname);
  mount(app, loading('Loading messages'));
  let data;
  try { data = await get('/admin/conversations'); } catch (e) { return mount(app, emptyState('alert', 'Could not load', e.message, h('button', { class: 'btn primary', type: 'button', onclick: showList }, icon('refresh', 18), 'Try again'))); }
  tell(data.unread || 0);
  const open = data.conversations.filter((c) => c.status === 'open');
  const closed = data.conversations.filter((c) => c.status === 'closed');
  const row = (c) => h('button', { class: `conv-row${c.unread ? ' unread' : ''}`, type: 'button', onclick: () => showThread(c.id) },
    h('span', { class: 'conv-dot', 'aria-label': c.unread ? 'Unread' : null }),
    h('span', { class: 'conv-main' },
      h('b', null, c.subject),
      h('small', { class: 'muted' }, `${KIND[c.kind] || 'Message'}${c.event_title ? ` - ${c.event_title}` : ''}`),
      c.last_preview ? h('span', { class: 'conv-prev' }, `${c.last_sender === 'host' ? 'You: ' : ''}${c.last_preview}`) : null),
    h('span', { class: 'conv-when muted' }, formatDateTime(c.last_message_at)));
  const notice = admin.status === 'suspended'
    ? h('div', { class: 'banner warn' }, icon('alert', 18), h('span', null, 'Your account is suspended. You can read and answer messages here while the owner reviews it.')) : null;
  mount(app,
    h('div', { class: 'page-head' }, h('h1', null, 'Messages'), h('button', { class: 'btn secondary', type: 'button', onclick: showList }, icon('refresh', 18), 'Refresh')),
    notice,
    data.conversations.length ? null : emptyState('message', 'No messages', 'When the owner needs to tell you something, for example about a suspended event, it appears here.'),
    open.length ? h('section', null, h('h2', { class: 'sec' }, 'Open'), h('div', { class: 'conv-list' }, open.map(row))) : null,
    closed.length ? h('section', null, h('h2', { class: 'sec' }, 'Closed (history)'), h('div', { class: 'conv-list' }, closed.map(row))) : null);
}

async function showThread(id) {
  stop();
  history.replaceState(null, '', `?c=${encodeURIComponent(id)}`);
  mount(app, loading());
  const thread = createThread({ me: 'host', onSend: async (body) => { await post(`/admin/conversations/${id}/reply`, { body }); await load(); } });
  const head = h('div', { class: 'th-head' });
  async function load() {
    const d = await get(`/admin/conversations/${id}`);
    mount(head,
      h('h1', null, d.conversation.subject),
      h('p', { class: 'muted' }, `${KIND[d.conversation.kind] || 'Message'}${d.conversation.event_title ? ` - ${d.conversation.event_title}` : ''} - ${d.conversation.status === 'open' ? 'Open' : 'Closed'}`));
    thread.update(d.conversation, d.messages);
  }
  try { await load(); } catch (e) {
    if (e.status === 404) return showList();
    return showError(e);
  }
  mount(app, h('button', { class: 'btn ghost', type: 'button', onclick: showList }, icon('arrow-left', 18), 'All messages'), head, thread.el);
  get('/admin/conversations/unread').then((r) => tell(r.unread || 0)).catch(() => {});
  timer = setInterval(() => { if (!document.hidden) load().catch(() => {}); }, 30000);
  thread.focus();
}

async function main() {
  admin = await requireAdmin({ active: 'messages', allowInactive: true });
  const c = new URLSearchParams(location.search).get('c');
  if (c) showThread(c); else showList();
}
main();
