// js/admin/forgot.js  -  "Forgot password?": asks Supabase to email a reset link.
import { requestPasswordReset } from '../supabase.js';
import { h, mount } from '../util.js';
import { icon } from '../icons.js';
import { ROUTES } from './auth.js';

const app = document.getElementById('app');
const RESET_PAGE = new URL('../../admin/reset.html', import.meta.url).href; // must also be listed under Supabase > Authentication > URL Configuration > Redirect URLs

const msg = h('p', { class: 'form-msg', role: 'alert' });
const say = (t) => { msg.textContent = t; msg.classList.add('show'); };
const email = h('input', { class: 'input', type: 'email', required: true, autocomplete: 'username', placeholder: 'you@example.com', inputmode: 'email' });
const submit = h('button', { class: 'btn primary lg block', type: 'submit' }, 'Send reset link');
const form = h('form', { class: 'form', novalidate: true }, h('label', { class: 'field' }, h('span', { class: 'label' }, 'Email'), email), msg, submit);

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  msg.classList.remove('show');
  const em = email.value.trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) return say('Enter a valid email address.');
  submit.disabled = true; submit.textContent = 'Sending...';
  try {
    await requestPasswordReset(em, RESET_PAGE);
  } catch (err) {
    // Too many requests is the one error worth showing; everything else looks the same as success on purpose
    if (err.status === 429 || err.code === 'over_email_send_rate_limit') { submit.disabled = false; submit.textContent = 'Send reset link'; return say('Too many requests. Please wait a few minutes and try again.'); }
  }
  mount(app, h('div', { class: 'auth-card card' },
    h('div', { class: 'auth-brand' }, h('span', { class: 'brand-mark lg' }, icon('check', 26)), h('h1', null, 'Check your email'),
      h('p', { class: 'muted' }, `If ${em} has an account, we sent a link to choose a new password. It can take a few minutes. Check your spam folder too.`)),
    h('a', { class: 'btn primary lg block', href: ROUTES.login }, 'Back to sign in')));
});

mount(app, h('div', { class: 'auth-card card' },
  h('div', { class: 'auth-brand' }, h('span', { class: 'brand-mark lg' }, icon('lock', 26)), h('h1', null, 'Forgot your password?'),
    h('p', { class: 'muted' }, 'Enter your email and we will send you a link to choose a new one.')),
  form,
  h('p', { class: 'hint center' }, h('a', { href: ROUTES.login }, 'Back to sign in'))));
