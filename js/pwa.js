// js/pwa.js  -  registers the service worker and powers the "Install app" button (host pages only).
import { h } from './util.js';
import { icon } from './icons.js';
import { openModal } from './ui.js';

export function registerServiceWorker() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  const ok = typeof location !== 'undefined' && (location.protocol === 'https:' || location.hostname === 'localhost');
  if (!ok) return;
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => { /* the site works fine without it */ }); });
}

const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

let deferred = null;           // the browser's install prompt, when it offers one
const listeners = new Set();
const notify = () => listeners.forEach((f) => f());
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; notify(); });
  window.addEventListener('appinstalled', () => { deferred = null; notify(); });
}

// What to show: 'prompt' (Chrome, Edge, Android), 'ios' (Safari has no prompt, show steps), or null (already installed / not possible)
export function installMode() {
  if (standalone()) return null;
  if (deferred) return 'prompt';
  if (isIos()) return 'ios';
  return null;
}

function iosSteps() {
  openModal({
    title: 'Install MyFiles', className: 'small',
    body: h('ol', { class: 'stack' },
      h('li', null, 'Tap the ', h('b', null, 'Share'), ' button in Safari (the square with an arrow).'),
      h('li', null, 'Scroll and tap ', h('b', null, 'Add to Home Screen'), '.'),
      h('li', null, 'Tap ', h('b', null, 'Add'), '. MyFiles now opens like an app.')),
    footer: [],
  });
}

// A button for the header. It is hidden until installing is possible.
export function createInstallButton() {
  const btn = h('button', { class: 'btn ghost sm', type: 'button', hidden: true, 'aria-label': 'Install the app' }, icon('download', 18), h('span', { class: 'install-label' }, 'Install app'));
  const refresh = () => { btn.hidden = !installMode(); };
  btn.addEventListener('click', async () => {
    const mode = installMode();
    if (mode === 'prompt') { const p = deferred; deferred = null; try { await p.prompt(); await p.userChoice; } catch { /* dismissed */ } notify(); }
    else if (mode === 'ios') iosSteps();
  });
  listeners.add(refresh);
  refresh();
  return btn;
}
