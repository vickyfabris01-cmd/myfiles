// js/admin/thread.js  -  one conversation: the messages, and a box to reply while it is open.
// Shared by the host's Messages page and the super admin's dashboard. `me` is 'host' or 'super_admin'.
import { h, formatDateTime } from '../util.js';
import { icon } from '../icons.js';
import { toast, showError, withBusy } from '../ui.js';

const MAX = 2000;

export function createThread({ me, onSend }) {
  const list = h('div', { class: 'th-list', role: 'log', 'aria-live': 'polite', 'aria-label': 'Messages' });
  const note = h('p', { class: 'th-closed', hidden: true }, icon('lock', 16), h('span', null, 'This conversation is closed. It is kept here as a record and no one can add to it.'));
  const box = h('textarea', { class: 'input', rows: 3, maxlength: MAX, placeholder: me === 'host' ? 'Write your reply' : 'Write a message', 'aria-label': 'Message' });
  const send = h('button', { class: 'btn primary', type: 'submit' }, icon('message', 18), 'Send');
  const form = h('form', { class: 'th-form', novalidate: true }, box, h('div', { class: 'th-actions' }, h('span', { class: 'hint' }, 'Ctrl+Enter to send'), send));

  async function submit() {
    const body = box.value.trim();
    if (!body) { box.focus(); return; }
    try {
      await withBusy(send, () => onSend(body));
      box.value = '';
    } catch (e) {
      if (e && e.code === 'CONVERSATION_CLOSED') toast('This conversation was closed.', 'error'); else showError(e);
    }
  }
  form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  box.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); } });

  const el = h('div', { class: 'thread' }, list, note, form);

  // Redraw from a conversation and its messages.
  function update(conv, messages) {
    const stick = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    list.replaceChildren(...messages.map((m) => {
      const mine = m.sender === me;
      return h('div', { class: `th-msg ${mine ? 'mine' : 'theirs'}` },
        h('span', { class: 'th-who' }, mine ? 'You' : (m.sender === 'super_admin' ? 'MyFiles owner' : 'Host')),
        h('p', { class: 'th-body' }, m.body),
        h('time', { class: 'th-time', datetime: m.created_at }, formatDateTime(m.created_at)));
    }));
    const closed = conv.status === 'closed';
    note.hidden = !closed;
    form.hidden = closed;
    if (stick) list.scrollTop = list.scrollHeight;
  }
  return { el, update, focus: () => box.focus() };
}
