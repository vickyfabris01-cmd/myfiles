// cloudflare/worker/messages.js
// Suspension notices and the admin-started chat.
//  * Only the super admin starts a conversation and only the super admin closes it.
//  * While it is open the host can reply. A closed conversation is kept for history: nothing can be added to it.
//  * A suspended host can still open their messages and reply (route mode 'inbox'), so they can defend themselves.
import { ApiError, v, readJson } from './utils.js';
import { LIMITS } from './config.js';

const COLS = 'id,host_id,event_id,event_title,report_id,kind,subject,status,opened_at,closed_at,last_message_at,last_sender,last_preview,host_seen_at,super_seen_at';
const when = (x) => (x ? Date.parse(x) || 0 : 0);
const oneLine = (s) => s.replace(/\s+/g, ' ').trim().slice(0, 120);

// What the host is told when nobody typed a message of their own.
export const TEXT = {
  eventSuspended: (title) => `Your event "${title}" has been suspended. Its link no longer works and it cannot be published for now. Nothing has been deleted. You can reply here to explain or ask a question.`,
  eventRestored: (title) => `Your event "${title}" has been restored. You can publish it again when you are ready.`,
  accountSuspended: () => 'Your account has been suspended. Your links and uploads are switched off for now. Nothing has been deleted. You can reply here to explain or ask a question.',
  accountRestored: () => 'Your account has been restored. Your links and uploads work again.',
};

/* ------------------------------------------------------------ core */
async function addMessage(db, conv, sender, body) {
  if (conv.status !== 'open') throw new ApiError(409, 'CONVERSATION_CLOSED', 'This conversation is closed.');
  const { total } = await db.selectCount('conversation_messages', { select: 'id', conversation_id: `eq.${conv.id}`, limit: 1 });
  if (total >= LIMITS.MESSAGES_PER_CONVERSATION) throw new ApiError(409, 'CONVERSATION_FULL', 'This conversation has reached its message limit.');
  const [m] = await db.insert('conversation_messages', { conversation_id: conv.id, sender, body });
  const now = new Date().toISOString();
  await db.update('conversations', { id: `eq.${conv.id}` }, {
    last_message_at: now, last_sender: sender, last_preview: oneLine(body),
    ...(sender === 'super_admin' ? { super_seen_at: now } : { host_seen_at: now }),
  });
  return m;
}

async function createConversation(db, { hostId, eventId = null, eventTitle = null, reportId = null, kind, subject, body }) {
  const [conv] = await db.insert('conversations', {
    host_id: hostId, event_id: eventId, event_title: eventTitle ? eventTitle.slice(0, 200) : null, report_id: reportId,
    kind, subject, super_seen_at: new Date().toISOString(),
  });
  await addMessage(db, conv, 'super_admin', body);
  return conv.id;
}

// Tell a host something. It goes into the open conversation of the same kind and event if there is one, otherwise a new one starts.
// Never throws to the caller's caller: the suspension itself must stand even if the notice fails. Returns the conversation id or null.
export async function notifyHost(db, { hostId, eventId = null, eventTitle = null, reportId = null, kind, subject, body }) {
  try {
    const [open] = await db.select('conversations', {
      select: 'id,status', host_id: `eq.${hostId}`, kind: `eq.${kind}`, status: 'eq.open',
      event_id: eventId ? `eq.${eventId}` : 'is.null', order: 'opened_at.desc', limit: 1,
    });
    if (open) { await addMessage(db, open, 'super_admin', body); return open.id; }
    return await createConversation(db, { hostId, eventId, eventTitle, reportId, kind, subject, body });
  } catch (e) {
    console.error('notifyHost failed', e && e.message);
    return null;
  }
}

/* ------------------------------------------------------------ shapes */
const hostShape = (c) => ({
  id: c.id, kind: c.kind, subject: c.subject, status: c.status, event_title: c.event_title || null,
  opened_at: c.opened_at, closed_at: c.closed_at || null, last_message_at: c.last_message_at, last_sender: c.last_sender || null, last_preview: c.last_preview || null,
  unread: c.last_sender === 'super_admin' && when(c.host_seen_at) < when(c.last_message_at),
});
const superShape = (c, hosts) => {
  const p = hosts.get(c.host_id) || {};
  return {
    ...hostShape(c), unread: c.last_sender === 'host' && when(c.super_seen_at) < when(c.last_message_at),
    host_id: c.host_id, host_email: p.email || null, host_name: p.display_name || null, event_id: c.event_id || null, report_id: c.report_id || null,
  };
};
const msgShape = (m) => ({ id: m.id, sender: m.sender, body: m.body, created_at: m.created_at });

async function hostMap(db, ids) {
  const map = new Map();
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return map;
  const rows = await db.select('profiles', { select: 'user_id,email,display_name', user_id: `in.(${uniq.join(',')})` });
  rows.forEach((p) => map.set(p.user_id, p));
  return map;
}
const messagesOf = (db, id) => db.select('conversation_messages', { select: 'id,sender,body,created_at', conversation_id: `eq.${id}`, order: 'created_at.asc', limit: 500 });

async function anyConversation(db, id) {
  const [c] = await db.select('conversations', { select: COLS, id: `eq.${v.uuid(id, 'id')}`, limit: 1 });
  if (!c) throw new ApiError(404, 'CONVERSATION_NOT_FOUND', 'Conversation not found');
  return c;
}
const bodyText = (b) => v.str(b.body, 'body', { min: 1, max: LIMITS.MESSAGE_MAX_CHARS });

/* ------------------------------------------------------------ super admin */
// GET /super/conversations?status=open|all
export async function superList({ db, url }) {
  const q = { select: COLS, order: 'last_message_at.desc', limit: 200 };
  if (url.searchParams.get('status') !== 'all') q.status = 'eq.open';
  const rows = await db.select('conversations', q);
  const hosts = await hostMap(db, rows.map((c) => c.host_id));
  return { conversations: rows.map((c) => superShape(c, hosts)) };
}

// The conversations of ONE host, newest first (used by the host page).
export async function hostConversations(db, hostId) {
  const rows = await db.select('conversations', { select: COLS, host_id: `eq.${hostId}`, order: 'last_message_at.desc', limit: 100 });
  const hosts = await hostMap(db, [hostId]);
  return rows.map((c) => ({ ...superShape(c, hosts), event_id: c.event_id || null }));
}

// GET /super/conversations/:id
export async function superGet({ db, params }) {
  let c = await anyConversation(db, params.id);
  const hosts = await hostMap(db, [c.host_id]);
  if (when(c.super_seen_at) < when(c.last_message_at)) {
    const now = new Date().toISOString();
    await db.update('conversations', { id: `eq.${c.id}` }, { super_seen_at: now });
    c = { ...c, super_seen_at: now };   // the answer reflects that it has now been read
  }
  return { conversation: superShape(c, hosts), messages: (await messagesOf(db, c.id)).map(msgShape) };
}

// POST /super/conversations  { host_id, subject, body, event_id? }   only the super admin starts a conversation
export async function superStart({ request, db }) {
  const b = await readJson(request);
  const hostId = v.uuid(b.host_id, 'host_id');
  const subject = v.str(b.subject, 'subject', { min: 1, max: LIMITS.SUBJECT_MAX_CHARS });
  const body = bodyText(b);
  const eventId = v.uuid(b.event_id, 'event_id', { optional: true });
  const [h] = await db.select('profiles', { select: 'user_id', user_id: `eq.${hostId}`, role: 'eq.host', limit: 1 });
  if (!h) throw new ApiError(404, 'HOST_NOT_FOUND', 'Host not found');
  let eventTitle = null;
  if (eventId) {
    const [e] = await db.select('events', { select: 'id,title', id: `eq.${eventId}`, created_by: `eq.${hostId}`, limit: 1 });
    if (!e) throw new ApiError(404, 'EVENT_NOT_FOUND', 'That event does not belong to this host');
    eventTitle = e.title;
  }
  const id = await createConversation(db, { hostId, eventId, eventTitle, kind: 'general', subject, body });
  return { id };
}

// POST /super/conversations/:id/messages  { body }
export async function superReply({ request, db, params }) {
  const c = await anyConversation(db, params.id);
  const m = await addMessage(db, c, 'super_admin', bodyText(await readJson(request)));
  return { message: msgShape(m) };
}

// POST /super/conversations/:id/close   (kept for history, nobody can add to it afterwards)
export async function superClose({ db, params }) {
  const c = await anyConversation(db, params.id);
  if (c.status !== 'open') throw new ApiError(409, 'BAD_STATE', 'This conversation is already closed');
  await db.update('conversations', { id: `eq.${c.id}` }, { status: 'closed', closed_at: new Date().toISOString() });
  return { id: c.id, status: 'closed' };
}

// GET /super/suspended-events   every event that is switched off right now, so a suspension can be lifted without an old report
export async function suspendedEvents({ db }) {
  const rows = (await db.rpc('super_suspended_events')) || [];
  return { events: rows.map((r) => ({ id: r.event_id, host_id: r.host_id, host_email: r.host_email, host_name: r.host_name || null, title: r.event_title, suspended_at: r.suspended_at, conversation_id: r.conversation_id || null })) };
}

/* ------------------------------------------------------------ host (also while suspended) */
async function ownConversation(db, admin, id) {
  const c = await anyConversation(db, id);
  if (c.host_id !== admin.id) throw new ApiError(404, 'CONVERSATION_NOT_FOUND', 'Conversation not found'); // someone else's looks like it does not exist
  return c;
}

// GET /admin/conversations
export async function hostList({ db, admin }) {
  const rows = await db.select('conversations', { select: COLS, host_id: `eq.${admin.id}`, order: 'last_message_at.desc', limit: 100 });
  const list = rows.map(hostShape);
  return { conversations: list, unread: list.filter((c) => c.unread).length };
}

// GET /admin/conversations/unread   (small and cheap: used by the menu badge)
export async function hostUnread({ db, admin }) {
  const rows = await db.select('conversations', { select: 'id,last_sender,last_message_at,host_seen_at', host_id: `eq.${admin.id}`, last_sender: 'eq.super_admin' });
  return { unread: rows.filter((c) => when(c.host_seen_at) < when(c.last_message_at)).length };
}

// GET /admin/conversations/:id
export async function hostGet({ db, admin, params }) {
  const c = await ownConversation(db, admin, params.id);
  if (c.last_sender === 'super_admin' && when(c.host_seen_at) < when(c.last_message_at)) await db.update('conversations', { id: `eq.${c.id}` }, { host_seen_at: new Date().toISOString() });
  return { conversation: { ...hostShape(c), unread: false }, messages: (await messagesOf(db, c.id)).map(msgShape) };
}

// POST /admin/conversations/:id/reply  { body }   only while the super admin keeps the conversation open
export async function hostReply({ request, db, admin, params }) {
  const c = await ownConversation(db, admin, params.id);
  const m = await addMessage(db, c, 'host', bodyText(await readJson(request)));
  return { message: msgShape(m) };
}
