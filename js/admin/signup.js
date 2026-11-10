// js/admin/signup.js  -  public sign-up: email + password.
// Supabase sends the confirmation email (Authentication > Providers > Email > "Confirm email" should stay ON).
// After confirming, the first sign-in creates the account as "pending" or "active", depending on the owner's approval switch.
import { signUp, signOut } from '../supabase.js';
import { api } from '../api.js';
import { h, mount } from '../util.js';
import { icon } from '../icons.js';
import { homeFor, ROUTES } from './auth.js';

const app = document.getElementById('app');

// ---------------------------------------------------------------------------------------------------------
// FUTURE (not built yet, on purpose). Steps for you when you want them:
//  * Bot check (Cloudflare Turnstile): Cloudflare dashboard > Turnstile > add a widget for your site and copy the
//    site key. Supabase dashboard > Authentication > Attack Protection > enable CAPTCHA, choose Turnstile, paste the
//    secret key. Then add the Turnstile widget script and pass its token as `options.captchaToken` in signUp() in
//    js/supabase.js (a placeholder note is there too). Also allow https://challenges.cloudflare.com in the CSP
//    (script-src, frame-src, connect-src) for /admin/* in _headers.
//  * Sign in with Google: Supabase > Authentication > Providers > Google, plus a Google Cloud OAuth client.
//  * Own email service: Supabase > Project Settings > Authentication > SMTP Settings (Resend, Brevo, ...).
// ---------------------------------------------------------------------------------------------------------

function done(email) {
  mount(app, h('div', { class: 'auth-card card' },
    h('div', { class: 'auth-brand' }, h('span', { class: 'brand-mark lg' }, icon('check', 26)), h('h1', null, 'Check your email'),
      h('p', { class: 'muted' }, `We sent a confirmation link to ${email}. Open it, then sign in.`)),
    h('a', { class: 'btn primary lg block', href: ROUTES.login }, 'Go to sign in'),
    h('p', { class: 'hint center' }, 'No email? Check your spam folder. If you already have an account, just sign in.')));
}

function main() {
  const msg = h('p', { class: 'form-msg', role: 'alert' });
  const say = (t) => { msg.textContent = t; msg.classList.add('show'); };
  const email = h('input', { class: 'input', type: 'email', required: true, autocomplete: 'username', placeholder: 'you@example.com', inputmode: 'email' });
  const pass = h('input', { class: 'input', type: 'password', required: true, autocomplete: 'new-password', placeholder: 'At least 8 characters', minlength: 8 });
  const pass2 = h('input', { class: 'input', type: 'password', required: true, autocomplete: 'new-password', placeholder: 'Repeat the password' });
  const agree = h('input', { type: 'checkbox', required: true });
  const submit = h('button', { class: 'btn primary lg block', type: 'submit' }, 'Create account');
  const form = h('form', { class: 'form', novalidate: true },
    h('label', { class: 'field' }, h('span', { class: 'label' }, 'Email'), email),
    h('label', { class: 'field' }, h('span', { class: 'label' }, 'Password'), pass),
    h('label', { class: 'field' }, h('span', { class: 'label' }, 'Repeat password'), pass2),
    h('label', { class: 'row gap-s' }, agree, h('span', { class: 'small' }, 'I agree to the ', h('a', { href: '/terms.html', target: '_blank', rel: 'noopener' }, 'Terms'), ' and ', h('a', { href: '/privacy.html', target: '_blank', rel: 'noopener' }, 'Privacy Policy'))),
    msg, submit);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    msg.classList.remove('show');
    const em = email.value.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) return say('Enter a valid email address.');
    if (pass.value.length < 8) return say('The password must be at least 8 characters.');
    if (pass.value !== pass2.value) return say('The two passwords do not match.');
    if (!agree.checked) return say('Please accept the Terms and Privacy Policy to continue.');
    submit.disabled = true; submit.textContent = 'Creating...';
    try {
      const r = await signUp(em, pass.value);
      if (!r.signedIn) return done(em);
      // email confirmation is switched off in Supabase: the person is already signed in
      const me = (await api('GET', '/admin/me')).admin;
      location.replace(homeFor(me));
    } catch (err) {
      await signOut().catch(() => {});
      say(err.code === 'weak_password' ? 'That password is too weak. Use a longer one.' : (err.message || 'Could not create the account.'));
      submit.disabled = false; submit.textContent = 'Create account';
    }
  });

  mount(app, h('div', { class: 'auth-card card' },
    h('div', { class: 'auth-brand' }, h('span', { class: 'brand-mark lg' }, icon('cloud-lock', 26)), h('h1', null, 'Create your account'),
      h('p', { class: 'muted' }, 'Share your event photos and videos with one private link.')),
    form,
    h('p', { class: 'hint center' }, 'Already have an account? ', h('a', { href: ROUTES.login }, 'Sign in'))));
}
main();
