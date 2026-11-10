// js/admin/reset.js  -  the page the reset email opens. Reads the recovery token from the address, asks for a new password.
import { parseAuthRedirect, updatePassword } from '../supabase.js';
import { h, mount } from '../util.js';
import { icon } from '../icons.js';
import { ROUTES } from './auth.js';

const app = document.getElementById('app');
const found = parseAuthRedirect(location.hash, location.search);
if (location.hash || location.search) history.replaceState(null, '', location.pathname); // keep the token out of the address bar and history

function card(iconName, title, text, ...extra) {
  mount(app, h('div', { class: 'auth-card card' },
    h('div', { class: 'auth-brand' }, h('span', { class: 'brand-mark lg' }, icon(iconName, 26)), h('h1', null, title), text ? h('p', { class: 'muted' }, text) : null), ...extra));
}

if (!found.token) {
  card('alert', 'This link cannot be used', found.error ? 'The reset link has expired or was already used. Request a new one.' : 'Open the link from your reset email, or request a new one.',
    h('a', { class: 'btn primary lg block', href: new URL('../../admin/forgot.html', import.meta.url).href }, 'Request a new link'),
    h('a', { class: 'btn secondary lg block', href: ROUTES.login }, 'Back to sign in'));
} else {
  const msg = h('p', { class: 'form-msg', role: 'alert' });
  const say = (t) => { msg.textContent = t; msg.classList.add('show'); };
  const p1 = h('input', { class: 'input', type: 'password', required: true, autocomplete: 'new-password', placeholder: 'At least 8 characters', minlength: 8 });
  const p2 = h('input', { class: 'input', type: 'password', required: true, autocomplete: 'new-password', placeholder: 'Repeat the password' });
  const submit = h('button', { class: 'btn primary lg block', type: 'submit' }, 'Save new password');
  const form = h('form', { class: 'form', novalidate: true },
    h('label', { class: 'field' }, h('span', { class: 'label' }, 'New password'), p1),
    h('label', { class: 'field' }, h('span', { class: 'label' }, 'Repeat password'), p2), msg, submit);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    msg.classList.remove('show');
    if (p1.value.length < 8) return say('The password must be at least 8 characters.');
    if (p1.value !== p2.value) return say('The two passwords do not match.');
    submit.disabled = true; submit.textContent = 'Saving...';
    try {
      await updatePassword(found.token, p1.value);
      card('check', 'Password changed', 'You can now sign in with your new password.', h('a', { class: 'btn primary lg block', href: ROUTES.login }, 'Sign in'));
    } catch (err) {
      const expired = err.status === 401 || err.status === 403;
      say(expired ? 'This link has expired. Request a new reset link.' : err.code === 'same_password' ? 'Choose a password you have not used before.' : err.code === 'weak_password' ? 'That password is too weak. Use a longer one.' : (err.message || 'Could not save the password.'));
      submit.disabled = false; submit.textContent = 'Save new password';
    }
  });
  card('lock', 'Choose a new password', 'Pick a password you do not use anywhere else.', form);
}
