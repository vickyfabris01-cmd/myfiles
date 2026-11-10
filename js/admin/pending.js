// js/admin/pending.js  -  "Waiting for approval" / "Account suspended" screen. Checks the status again each time it opens.
import { signOut, getSession } from '../supabase.js';
import { api } from '../api.js';
import { h, mount } from '../util.js';
import { icon } from '../icons.js';
import { homeFor, ROUTES } from './auth.js';

const app = document.getElementById('app');

async function main() {
  if (!getSession()) { location.replace(ROUTES.login); return; }
  let me;
  try { me = (await api('GET', '/admin/me')).admin; }
  catch (e) { await signOut(); location.replace(`${ROUTES.login}?reason=${e.code === 'EMAIL_NOT_CONFIRMED' ? 'confirm' : 'expired'}`); return; }
  if (me.status === 'active') { location.replace(homeFor(me)); return; }

  const suspended = me.status === 'suspended';
  mount(app, h('div', { class: 'auth-card card' },
    h('div', { class: 'auth-brand' }, h('span', { class: 'brand-mark lg' }, icon(suspended ? 'alert' : 'clock', 26)),
      h('h1', null, suspended ? 'Account suspended' : 'Waiting for approval'),
      h('p', { class: 'muted' }, suspended
        ? 'This account has been suspended, so it cannot create events or upload. Your existing data has not been deleted.'
        : `Thanks for signing up, ${me.email}. The owner approves new accounts by hand. You will be able to create events as soon as you are approved. Come back and check again later.`)),
    suspended ? null : h('button', { class: 'btn primary lg block', type: 'button', onclick: () => location.reload() }, icon('refresh', 18), 'Check again'),
    h('button', { class: 'btn secondary lg block', type: 'button', onclick: async () => { await signOut(); location.replace(ROUTES.login); } }, icon('logout', 18), 'Sign out')));
}
main();
