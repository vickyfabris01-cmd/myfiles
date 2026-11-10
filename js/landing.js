// js/landing.js - home page behaviour: theme toggle, smart sign-in button, "I have a link" box.
import { getSession } from './supabase.js';

// 1. Already signed in? Say so and go straight to the dashboard.
try {
  if (getSession()) {
    for (const id of ['signin', 'signin2', 'signin3']) {
      const a = document.getElementById(id);
      if (!a) continue;
      a.href = '/admin/events.html';
      a.firstChild.textContent = 'Open dashboard ';
    }
    for (const id of ['signup', 'signup2', 'signup3']) { const a = document.getElementById(id); if (a) a.hidden = true; }
  }
} catch { /* not signed in */ }

// 2. Dark mode (same storage key as the rest of the site)
document.getElementById('theme').addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('myfiles.theme', next); } catch { /* ignore */ }
});

// 3. Paste a link (or just the code) and open the event. Accepts https://site/e/TOKEN, /e/TOKEN or TOKEN.
const TOKEN = /^[A-Za-z0-9_-]{20,128}$/;
export function tokenFromInput(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (TOKEN.test(s)) return s;
  const m = /\/e\/([A-Za-z0-9_-]{20,128})/.exec(s);
  return m ? m[1] : null;
}

const form = document.getElementById('open');
const input = document.getElementById('link');
const err = document.getElementById('link-err');
form.addEventListener('submit', (e) => {
  e.preventDefault();
  const token = tokenFromInput(input.value);
  if (!token) {
    err.textContent = 'That does not look like an event link. Paste the whole link you were sent.';
    err.classList.add('show');
    input.classList.add('invalid');
    input.focus();
    return;
  }
  location.assign(`/e/${encodeURIComponent(token)}`);
});
input.addEventListener('input', () => { err.classList.remove('show'); input.classList.remove('invalid'); });
