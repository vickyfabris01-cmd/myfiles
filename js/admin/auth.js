// js/admin/auth.js  -  sign-in page, route guard, header with logout. Backend authorization stays authoritative.
import { signIn, signOut, getSession, onSessionChange } from '../supabase.js';
import { api } from '../api.js';
import { h, mount } from '../util.js';
import { icon } from '../icons.js';
import { loading } from '../ui.js';

const LOGIN = new URL('../../admin/index.html', import.meta.url).href;
const EVENTS = new URL('../../admin/events.html', import.meta.url).href;
const UPLOAD = new URL('../../admin/upload.html', import.meta.url).href;
const EDITOR = new URL('../../admin/event-editor.html', import.meta.url).href;

// Central place for page links, so pages never hard-code paths.
export const ROUTES = {
  login: LOGIN,
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

export function mountHeader(admin, active) {
  const host = document.getElementById('app-header');
  if (!host) return;
  const link = (key, href, label, ic) => h('a', { class: `navlink${active === key ? ' active' : ''}`, href }, icon(ic, 18), h('span', null, label));
  mount(host, h('header', { class: 'topbar' }, h('div', { class: 'topbar-in' },
    h('a', { class: 'brand', href: EVENTS }, h('span', { class: 'brand-mark' }, icon('cloud-lock', 18)), h('span', null, 'MyFiles')),
    h('nav', { class: 'nav' }, link('events', EVENTS, 'Events', 'calendar'), link('upload', UPLOAD, 'Upload', 'upload')),
    h('span', { class: 'spacer' }),
    h('span', { class: 'who' }, admin.email || 'Administrator'),
    h('button', { class: 'btn icon ghost', type: 'button', 'aria-label': 'Toggle dark mode', onclick: toggleTheme }, icon('moon')),
    h('button', { class: 'btn icon ghost', type: 'button', 'aria-label': 'Sign out', onclick: async () => { await signOut(); redirectToLogin('signed_out'); } }, icon('logout')),
  )));
}

// Call first on every admin page except sign-in. Resolves with the admin, or navigates away.
export async function requireAdmin({ active } = {}) {
  if (!getSession()) return redirectToLogin();
  const app = document.getElementById('app');
  if (app) mount(app, loading());
  let admin;
  try {
    admin = (await api('GET', '/admin/me')).admin;
  } catch (e) {
    if (e.status === 401 || e.status === 403) {
      await signOut();
      return redirectToLogin(e.status === 403 ? 'not_admin' : 'expired');
    }
    return new Promise(() => showFatal(e.message, () => location.reload()));
  }
  mountHeader(admin, active);
  onSessionChange((s) => { if (!s) redirectToLogin('signed_out'); });
  return admin;
}

const REASONS = {
  expired: 'Your session expired. Please sign in again.',
  not_admin: 'This account is not an administrator.',
  signed_out: 'You have been signed out.',
};

export async function initLoginPage() {
  const app = document.getElementById('app');
  const reason = new URLSearchParams(location.search).get('reason');

  if (getSession() && !reason) {
    try { await api('GET', '/admin/me'); location.replace(EVENTS); return; } catch { /* show the form */ }
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
    msg, submit);

  const say = (text) => { msg.textContent = text; msg.classList.add('show'); };
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!email.value.trim() || !pass.value) { say('Enter your email and password.'); return; }
    submit.disabled = true; submit.textContent = 'Signing in...';
    try {
      await signIn(email.value.trim(), pass.value);
      await api('GET', '/admin/me');
      location.replace(EVENTS);
    } catch (err) {
      if (err.status === 403) { await signOut(); say('This account is not an administrator.'); }
      else if (err.status === 400 || err.code === 'invalid_credentials') say('Wrong email or password.');
      else say(err.message || 'Could not sign in.');
      submit.disabled = false; submit.textContent = 'Sign in';
    }
  });

  mount(app, h('div', { class: 'auth-card card' },
    h('div', { class: 'auth-brand' }, h('span', { class: 'brand-mark lg' }, icon('cloud-lock', 26)), h('h1', null, 'MyFiles'), h('p', { class: 'muted' }, 'Administrator sign in')),
    form,
    h('p', { class: 'hint center' }, icon('lock', 14), ' Private area. Accounts are created by the owner only.')));
}
