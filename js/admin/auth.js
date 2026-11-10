// js/admin/auth.js  -  sign-in page, route guard, header with logout. Backend authorization stays authoritative.
import { signIn, signOut, getSession, onSessionChange } from '../supabase.js';
import { registerServiceWorker, createInstallButton } from '../pwa.js';

registerServiceWorker();
import { api } from '../api.js';
import { h, mount } from '../util.js';
import { icon } from '../icons.js';
import { loading } from '../ui.js';

const LOGIN = new URL('../../admin/index.html', import.meta.url).href;
const EVENTS = new URL('../../admin/events.html', import.meta.url).href;
const UPLOAD = new URL('../../admin/upload.html', import.meta.url).href;
const EDITOR = new URL('../../admin/event-editor.html', import.meta.url).href;
const SIGNUP = new URL('../../admin/signup.html', import.meta.url).href;
const PENDING = new URL('../../admin/pending.html', import.meta.url).href;
const BIN = new URL('../../admin/bin.html', import.meta.url).href;
const STORAGE = new URL('../../admin/storage.html', import.meta.url).href;
const SUPER = new URL('../../admin/super.html', import.meta.url).href;
const FORGOT = new URL('../../admin/forgot.html', import.meta.url).href;

// Central place for page links, so pages never hard-code paths.
export const ROUTES = {
  login: LOGIN,
  signup: SIGNUP,
  pending: PENDING,
  bin: BIN,
  storage: STORAGE,
  super: SUPER,
  events: EVENTS,
  editor: (id, folderId) => `${EDITOR}?id=${encodeURIComponent(id)}${folderId ? `&folder=${encodeURIComponent(folderId)}` : ''}`,
  upload: (eventId, folderId) => {
    const q = [];
    if (eventId) q.push(`event=${encodeURIComponent(eventId)}`);
    if (folderId) q.push(`folder=${encodeURIComponent(folderId)}`);
    return q.length ? `${UPLOAD}?${q.join('&')}` : UPLOAD;
  },
};

function redirectToLogin(reason) {
  location.replace(reason ? `${LOGIN}?reason=${reason}` : LOGIN);
  return new Promise(() => {}); // page is navigating away
}

function showFatal(message, retry) {
  const app = document.getElementById('app');
  mount(app, h('div', { class: 'empty' }, h('div', { class: 'empty-ic' }, icon('alert', 28)), h('h3', null, 'Could not load'), h('p', { class: 'muted' }, message),
    h('button', { class: 'btn primary', type: 'button', onclick: retry }, icon('refresh', 18), 'Try again')));
}

function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('myfiles.theme', next); } catch { /* ignore */ }
}

// Where each kind of account lands after signing in.
export function homeFor(me) {
  if (me.status !== 'active') return PENDING;
  return me.role === 'super_admin' ? SUPER : EVENTS;
}

export function mountHeader(admin, active) {
  const host = document.getElementById('app-header');
  if (!host) return;
  const link = (key, href, label, ic) => h('a', { class: `navlink${active === key ? ' active' : ''}`, href }, icon(ic, 18), h('span', null, label));
  const isSuper = admin.role === 'super_admin';
  const nav = isSuper
    ? [link('super', SUPER, 'Dashboard', 'select')]
    : [link('events', EVENTS, 'Events', 'calendar'), link('upload', UPLOAD, 'Upload', 'upload'), link('storage', STORAGE, 'Storage', 'cloud-lock'), link('bin', BIN, 'Bin', 'trash')];
  const doSignOut = async () => { await signOut(); redirectToLogin('signed_out'); };

  // DESKTOP: everything in the header (unchanged). Items with `desk-only` are hidden on phones.
  // PHONE (up to 720px): the header keeps only the logo, the name and the theme icon; the links move to a bottom bar
  // and Install app / Sign out live in the menu (the hamburger at the end of the bottom bar).
  const header = h('header', { class: 'topbar' }, h('div', { class: 'topbar-in' },
    h('a', { class: 'brand', href: isSuper ? SUPER : EVENTS }, h('span', { class: 'brand-mark' }, icon('cloud-lock', 18)), h('span', null, 'MyFiles')),
    h('nav', { class: 'nav desk-only' }, nav),
    h('span', { class: 'spacer' }),
    h('span', { class: 'who desk-only' }, admin.email || 'Account'),
    h('span', { class: 'desk-only' }, createInstallButton()),
    h('button', { class: 'btn icon ghost', type: 'button', 'aria-label': 'Toggle dark mode', onclick: toggleTheme }, icon('moon')),
    h('button', { class: 'btn icon ghost desk-only', type: 'button', 'aria-label': 'Sign out', onclick: doSignOut }, icon('logout')),
  ));

  const tab = (key, href, label, ic) => h('a', { class: `bn-item${active === key ? ' active' : ''}`, href, 'aria-current': active === key ? 'page' : null }, icon(ic, 22), h('span', null, label));
  const tabs = isSuper
    ? [tab('super', SUPER, 'Dashboard', 'select')]
    : [tab('events', EVENTS, 'Events', 'calendar'), tab('upload', UPLOAD, 'Upload', 'upload'), tab('storage', STORAGE, 'Storage', 'cloud-lock'), tab('bin', BIN, 'Bin', 'trash')];

  const more = h('button', { class: 'bn-item', type: 'button', 'aria-label': 'Menu', 'aria-haspopup': 'true', 'aria-expanded': 'false', 'aria-controls': 'more-sheet' }, icon('menu', 22), h('span', null, 'Menu'));
  const sheet = h('div', { class: 'more-sheet', id: 'more-sheet', role: 'menu', hidden: true, 'aria-label': 'Account menu' },
    h('p', { class: 'more-who' }, admin.email || 'Account'),
    createInstallButton(),
    h('button', { class: 'btn ghost', type: 'button', role: 'menuitem', onclick: doSignOut }, icon('logout', 18), 'Sign out'));
  const closeMenu = (refocus) => { if (sheet.hidden) return; sheet.hidden = true; more.setAttribute('aria-expanded', 'false'); if (refocus) more.focus(); };
  more.addEventListener('click', (e) => {
    e.stopPropagation();
    sheet.hidden = !sheet.hidden;
    more.setAttribute('aria-expanded', String(!sheet.hidden));
    if (!sheet.hidden) { const first = sheet.querySelector('button:not([hidden])'); if (first) first.focus(); }
  });
  sheet.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => closeMenu(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(true); });

  mount(host, header, h('nav', { class: 'bottom-nav', 'aria-label': 'Main' }, tabs, more), sheet);
  document.body.classList.add('has-bottom-nav'); // makes room for the bottom bar on phones (see css/admin.css)
}

// Call first on every account page except sign-in / sign-up. Resolves with the account, or navigates away.
//   role 'host' (default): hosts only. The super admin is sent to the super dashboard.
//   role 'super': the super admin only.
//   allowInactive: for the "waiting for approval" page.
export async function requireAdmin({ active, role = 'host', allowInactive = false } = {}) {
  if (!getSession()) return redirectToLogin();
  const app = document.getElementById('app');
  if (app) mount(app, loading());
  let admin;
  try {
    admin = (await api('GET', '/admin/me')).admin;
  } catch (e) {
    if (e.status === 401 || e.status === 403) {
      await signOut();
      return redirectToLogin(e.code === 'EMAIL_NOT_CONFIRMED' ? 'confirm' : 'expired');
    }
    return new Promise(() => showFatal(e.message, () => location.reload()));
  }
  if (!allowInactive && admin.status !== 'active') { location.replace(PENDING); return new Promise(() => {}); }
  if (role === 'host' && admin.role === 'super_admin') { location.replace(SUPER); return new Promise(() => {}); }
  if (role === 'super' && admin.role !== 'super_admin') { location.replace(EVENTS); return new Promise(() => {}); }
  mountHeader(admin, active);
  onSessionChange((s) => { if (!s) redirectToLogin('signed_out'); });
  return admin;
}

const REASONS = {
  expired: 'Your session expired. Please sign in again.',
  not_admin: 'This account cannot sign in here.',
  confirm: 'Please confirm your email address first. Open the link we sent you, then sign in.',
  created: 'Account created. Check your email for the confirmation link, then sign in.',
  deleted: 'Your account and all its files were deleted.',
  signed_out: 'You have been signed out.',
};

export async function initLoginPage() {
  const app = document.getElementById('app');
  const reason = new URLSearchParams(location.search).get('reason');

  if (getSession() && !reason) {
    try { location.replace(homeFor((await api('GET', '/admin/me')).admin)); return; } catch { /* show the form */ }
  }

  const msg = h('p', { class: `form-msg${reason ? ' show' : ''}`, role: 'alert' }, REASONS[reason] || '');
  const email = h('input', { class: 'input', type: 'email', name: 'email', required: true, autocomplete: 'username', placeholder: 'you@example.com', inputmode: 'email' });
  const pass = h('input', { class: 'input', type: 'password', name: 'password', required: true, autocomplete: 'current-password', placeholder: 'Password' });
  const eye = h('button', { class: 'btn icon ghost eye', type: 'button', 'aria-label': 'Show password' }, icon('eye'));
  eye.addEventListener('click', () => {
    const show = pass.type === 'password';
    pass.type = show ? 'text' : 'password';
    mount(eye, icon(show ? 'eye-off' : 'eye'));
    eye.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  });
  const submit = h('button', { class: 'btn primary lg block', type: 'submit' }, 'Sign in');
  const form = h('form', { class: 'form', novalidate: true },
    h('label', { class: 'field' }, h('span', { class: 'label' }, 'Email'), email),
    h('label', { class: 'field' }, h('span', { class: 'label' }, 'Password'), h('div', { class: 'input-wrap' }, pass, eye)),
    msg, submit,
    h('p', { class: 'hint center' }, h('a', { href: FORGOT }, 'Forgot your password?')));

  const say = (text) => { msg.textContent = text; msg.classList.add('show'); };
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!email.value.trim() || !pass.value) { say('Enter your email and password.'); return; }
    submit.disabled = true; submit.textContent = 'Signing in...';
    try {
      await signIn(email.value.trim(), pass.value);
      const me = (await api('GET', '/admin/me')).admin;
      location.replace(homeFor(me));
    } catch (err) {
      if (err.code === 'email_not_confirmed') say(REASONS.confirm);
      else if (err.status === 403) { await signOut(); say(err.code === 'EMAIL_NOT_CONFIRMED' ? REASONS.confirm : 'This account cannot sign in here.'); }
      else if (err.status === 400 || err.code === 'invalid_credentials') say('Wrong email or password.');
      else say(err.message || 'Could not sign in.');
      submit.disabled = false; submit.textContent = 'Sign in';
    }
  });

  mount(app, h('div', { class: 'auth-card card' },
    h('div', { class: 'auth-brand' }, h('span', { class: 'brand-mark lg' }, icon('cloud-lock', 26)), h('h1', null, 'MyFiles'), h('p', { class: 'muted' }, 'Sign in')),
    form,
    h('p', { class: 'hint center' }, 'New here? ', h('a', { href: SIGNUP }, 'Create an account'))));
}
