// js/admin/account.js  -  "My account": every account (host or owner) changes its own name and password here.
// The password is changed with Supabase Auth directly. The current password is asked first.
import { requireAdmin } from './auth.js';
import { patch } from '../api.js';
import { changePassword } from '../supabase.js';
import { h, mount } from '../util.js';
import { icon } from '../icons.js';
import { toast, showError, withBusy } from '../ui.js';

const app = document.getElementById('app');

function nameCard(me) {
  const input = h('input', { class: 'input', type: 'text', name: 'name', value: me.name || '', maxlength: 80, required: true, autocomplete: 'name', placeholder: 'Your name' });
  const msg = h('p', { class: 'form-msg', role: 'alert' });
  const save = h('button', { class: 'btn primary', type: 'submit' }, 'Save name');
  const form = h('form', { class: 'form pw-form', novalidate: true }, h('label', { class: 'field' }, h('span', { class: 'label' }, 'Name'), input,
    h('span', { class: 'hint' }, me.role === 'super_admin' ? 'Shown to you in the header.' : 'The owner sees this next to your email when reviewing reports or contacting you.')), msg, h('div', null, save));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    msg.classList.remove('show');
    const name = input.value.trim();
    if (!name) { msg.textContent = 'Enter a name.'; msg.classList.add('show'); input.focus(); return; }
    await withBusy(save, async () => {
      try { const r = await patch('/admin/account', { name }); me.name = r.name; input.value = r.name; toast('Name saved', 'success'); } catch (err) { showError(err); }
    });
  });
  return h('section', { class: 'card pad stack' }, h('h2', { class: 'h2' }, 'Your name'), h('p', { class: 'muted small' }, `Signed in as ${me.email}`), form);
}

function passwordCard(me) {
  const field = (label, autocomplete, placeholder) => h('input', { class: 'input', type: 'password', required: true, autocomplete, placeholder, 'aria-label': label });
  const cur = field('Current password', 'current-password', 'Current password');
  const p1 = field('New password', 'new-password', 'At least 8 characters');
  const p2 = field('Repeat new password', 'new-password', 'Repeat the new password');
  const msg = h('p', { class: 'form-msg', role: 'alert' });
  const say = (t) => { msg.textContent = t; msg.classList.add('show'); };
  const save = h('button', { class: 'btn primary', type: 'submit' }, icon('lock', 18), 'Change password');
  const form = h('form', { class: 'form pw-form', novalidate: true },
    h('label', { class: 'field' }, h('span', { class: 'label' }, 'Current password'), cur),
    h('label', { class: 'field' }, h('span', { class: 'label' }, 'New password'), p1),
    h('label', { class: 'field' }, h('span', { class: 'label' }, 'Repeat new password'), p2), msg, h('div', null, save));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    msg.classList.remove('show');
    if (!cur.value) return say('Enter your current password.');
    if (p1.value.length < 8) return say('The new password must be at least 8 characters.');
    if (p1.value !== p2.value) return say('The two new passwords do not match.');
    if (p1.value === cur.value) return say('Choose a password different from the current one.');
    await withBusy(save, async () => {
      try {
        await changePassword(me.email, cur.value, p1.value);
        cur.value = p1.value = p2.value = '';
        toast('Password changed', 'success');
      } catch (err) {
        if (err.status === 400 && (err.code === 'invalid_credentials' || err.code === 'invalid_grant' || !err.code)) say('Your current password is wrong.');
        else if (err.code === 'same_password') say('Choose a password you have not used before.');
        else if (err.code === 'weak_password') say('That password is too weak. Use a longer one.');
        else say(err.message || 'Could not change the password.');
      }
    });
  });
  return h('section', { class: 'card pad stack' }, h('h2', { class: 'h2' }, 'Change password'), form,
    h('p', { class: 'hint' }, 'Forgot the current one? Sign out and use "Forgot your password?" on the sign-in page.'));
}

async function main() {
  const me = await requireAdmin({ active: 'account', role: 'any', allowInactive: true });
  mount(app, h('div', { class: 'stack' }, h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'My account'), h('p', { class: 'muted' }, 'Your name and password.'))), nameCard(me), passwordCard(me)));
}
main();
