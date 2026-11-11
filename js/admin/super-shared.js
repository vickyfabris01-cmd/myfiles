// js/admin/super-shared.js  -  pieces shared by the super admin pages (Dashboard, Hosts, Host, Reports, Conversations).
// Every suspension and every lifting is sent to the host as a message they can reply to; only the owner starts and closes a conversation.
import { get, post } from '../api.js';
import { h, formatBytes, formatDateTime } from '../util.js';
import { icon } from '../icons.js';
import { toast, showError, confirmDialog, formDialog, withBusy, loading, openModal } from '../ui.js';
import { createThread } from './thread.js';
import { ROUTES } from './auth.js';

export const GB = 1024 ** 3;
// width through element.style: an inline style="" attribute is blocked by the page's CSP
export const fill = (pct) => { const el = h('span', { class: 'bar-fill' }); el.style.width = `${pct}%`; return el; };
export const stat = (n, l) => h('div', { class: 'stat' }, h('b', null, n), h('span', null, l));
export const hostLabel = (u) => (u.name || u.host_name ? `${u.name || u.host_name} (${u.email || u.host_email})` : (u.email || u.host_email));
export const statusClass = (s) => (s === 'active' ? 'published' : s === 'pending' ? 'scheduled' : 'suspended');

// The wording a host gets if nothing is typed. It is shown in the box so the owner can change it first.
export const DEFAULT = {
  eventOff: (t) => `Your event "${t}" has been suspended. Its link no longer works and it cannot be published for now. Nothing has been deleted. You can reply here to explain or ask a question.`,
  eventOn: (t) => `Your event "${t}" has been restored. You can publish it again when you are ready.`,
  hostOff: () => 'Your account has been suspended. Your links and uploads are switched off for now. Nothing has been deleted. You can reply here to explain or ask a question.',
  hostOn: () => 'Your account has been restored. Your links and uploads work again.',
};

export const CANCEL = new Error('Cancelled');
// Runs an action, then calls `reload`. If the host could not be notified (conversation_id null) the owner is told, because the action itself still stands.
export const act = (fn, msg, reload) => async (e) => {
  await withBusy(e.currentTarget, async () => {
    try {
      const r = await fn();
      toast(msg, 'success');
      if (r && 'conversation_id' in r && !r.conversation_id) showError(new Error('That worked, but the host could not be notified. Send them a message from their page.'));
      if (reload) await reload();
    } catch (err) { if (err && err.message !== 'Cancelled') showError(err); }
  });
};

// Asks for the message the host will receive. Returns the text, or null if the owner cancelled.
export async function askMessage({ title, intro, text, submitLabel }) {
  const v = await formDialog({ title, submitLabel, intro, fields: [{ name: 'message', label: 'Message to the host', type: 'textarea', rows: 6, value: text, maxLength: 2000, hint: 'The host sees this in their Messages and can reply. You can edit it.' }] });
  return v ? v.message : null;
}
export const sendMsg = (path, message) => post(path, message ? { message } : {});

/* ---------- actions on a host ---------- */
export const hostAction = (u, a, msg, reload) => act(async () => {
  if (a === 'approve') return post(`/super/hosts/${u.id}/approve`);
  const off = a === 'suspend';
  const who = u.name || u.email;
  const m = await askMessage({ title: off ? `Suspend ${who}?` : `Restore ${who}?`,
    intro: off ? 'Their links and uploads stop at once. Their data is kept. They are told in Messages and can reply.' : 'Their links and uploads work again. They are told in Messages.',
    text: off ? DEFAULT.hostOff() : DEFAULT.hostOn(), submitLabel: off ? 'Suspend host' : 'Restore host' });
  if (m === null) throw CANCEL;
  return sendMsg(`/super/hosts/${u.id}/${a}`, m);
}, msg, reload);

export async function addStorage(u, leftBytes, reload) {
  const v = await formDialog({ title: `Add storage for ${u.name || u.email}`, submitLabel: 'Add', intro: `Now ${formatBytes(u.quota_bytes)}. You have ${formatBytes(leftBytes)} of R2 space left.`, fields: [{ name: 'gb', label: 'Extra GB to add', type: 'number', min: 0, value: '1', required: true }] });
  if (!v) return;
  const gb = Number(v.gb);
  if (!(gb > 0)) { showError(new Error('Enter a number of GB above 0.')); return; }
  try { await post(`/super/hosts/${u.id}/storage`, { add_bytes: Math.round(gb * GB) }); toast('Storage added', 'success'); if (reload) await reload(); } catch (e) { showError(e); }
}

export async function startConversation(u, reload) {
  const v = await formDialog({ title: `Message ${u.name || u.email}`, submitLabel: 'Start conversation', intro: 'Only you can start a conversation. The host can reply while it is open, and you close it when you are done.', fields: [
    { name: 'subject', label: 'Subject', maxLength: 150, required: true },
    { name: 'body', label: 'Message', type: 'textarea', rows: 5, maxLength: 2000, required: true }] });
  if (!v) return;
  try { const r = await post('/super/conversations', { host_id: u.id, subject: v.subject, body: v.body }); toast('Message sent', 'success'); if (reload) await reload(); openConversation(r.id, reload); } catch (e) { showError(e); }
}

/* ---------- actions on an event (any event that was reported, in any state of its reports) ---------- */
export const suspendEventAction = (eventId, title, reload) => act(async () => {
  const m = await askMessage({ title: 'Suspend this event?', intro: 'Its link stops working at once and the host cannot publish it again. Nothing is deleted. The host is told in Messages and can reply.', text: DEFAULT.eventOff(title || 'this event'), submitLabel: 'Suspend event' });
  if (m === null) throw CANCEL;
  return sendMsg(`/super/events/${eventId}/suspend`, m);
}, 'Event suspended', reload);

export const restoreEventAction = (eventId, title, reload) => act(async () => {
  const m = await askMessage({ title: 'Restore this event?', intro: 'Its link works again once the host publishes it. The host is told in Messages.', text: DEFAULT.eventOn(title || 'this event'), submitLabel: 'Restore event' });
  if (m === null) throw CANCEL;
  return sendMsg(`/super/events/${eventId}/unsuspend`, m);
}, 'Event restored', reload);

/* ---------- one conversation in a window: read, reply, close ---------- */
// Closing keeps it for history and nothing can be added afterwards. `onChange` runs when the window closes so the page behind can refresh.
export async function openConversation(id, onChange) {
  let current = null;
  const thread = createThread({ me: 'super_admin', onSend: async (body) => { await post(`/super/conversations/${id}/messages`, { body }); await reload(); } });
  const sub = h('p', { class: 'muted small' });
  const closeBtn = h('button', { class: 'btn danger', type: 'button', onclick: async () => {
    if (!(await confirmDialog({ title: 'Close this conversation?', danger: true, confirmLabel: 'Close conversation', message: 'The host can no longer reply and neither can you. It stays in History as a record.' }))) return;
    try { await post(`/super/conversations/${id}/close`); toast('Conversation closed', 'success'); await reload(); } catch (e) { showError(e); }
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
  m.closed.then(() => { if (onChange) Promise.resolve(onChange()).catch(() => {}); });
}

/* ---------- a conversation row (used on the Conversations page and on a host's page) ---------- */
export function convRow(c, onOpen, { showHost = true } = {}) {
  const line = [showHost && c.host_name ? c.host_name : null, showHost ? c.host_email : null, c.event_title].filter(Boolean).join(' - ');
  return h('button', { class: `conv-row${c.unread ? ' unread' : ''}`, type: 'button', onclick: () => onOpen(c.id) },
    h('span', { class: 'conv-dot', 'aria-label': c.unread ? 'Host replied' : null }),
    h('span', { class: 'conv-main' }, h('b', null, c.subject), line ? h('small', { class: 'muted' }, line) : null,
      c.last_preview ? h('span', { class: 'conv-prev' }, `${c.last_sender === 'host' ? 'Host: ' : 'You: '}${c.last_preview}`) : null),
    h('span', { class: 'conv-when muted' }, formatDateTime(c.last_message_at)));
}

export const pageHead = (title, sub) => h('div', { class: 'page-head' }, h('div', null, h('h1', null, title), sub ? h('p', { class: 'muted' }, sub) : null));
export { loading, icon, ROUTES };
