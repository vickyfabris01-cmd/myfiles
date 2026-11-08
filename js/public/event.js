// js/public/event.js  -  visitor page entry: validate the link, show the event, mount the gallery.
import { pub, tokenFromLocation } from './api.js';
import { mountGallery } from './gallery.js';
import { h, mount, formatEventDate } from '../util.js';
import { icon } from '../icons.js';
import { loading } from '../ui.js';

const app = document.getElementById('app');

const MESSAGES = {
  not_found: { icon: 'link', title: 'This link is not valid', text: 'It does not match any event. Check that the whole link was copied, or ask the person who shared it to send it again.' },
  unpublished: { icon: 'lock', title: 'This event is not available right now', text: 'The host has not published it yet, or has paused sharing. Please check back later.' },
  deleted: { icon: 'alert', title: 'This event has been removed', text: 'The host has deleted this event, so it can no longer be opened.' },
};

function unavailable(reason) {
  const m = MESSAGES[reason] || MESSAGES.not_found;
  document.title = 'Not available';
  mount(app, h('div', { class: 'g-gone' }, h('div', { class: 'empty-ic' }, icon(m.icon, 30)), h('h1', null, m.title), h('p', { class: 'muted' }, m.text)));
}

function failure(message) {
  mount(app, h('div', { class: 'g-gone' }, h('div', { class: 'empty-ic' }, icon('alert', 30)), h('h1', null, 'Could not open this event'), h('p', { class: 'muted' }, message),
    h('button', { class: 'btn primary', type: 'button', onclick: () => location.reload() }, icon('refresh', 18), 'Try again')));
}

function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('myfiles.theme', next); } catch { /* ignore */ }
}

// Cover: the small preview shows instantly, then the full-quality photo fades in on top of it.
// object-position uses the area the host chose, so the right part of the photo stays visible.
function coverImages(c) {
  const pos = `${c.pos_x ?? 50}% ${c.pos_y ?? 50}%`;
  const low = h('img', { class: 'hero-img', src: c.thumbnail_url, alt: '', decoding: 'async', style: `object-position:${pos}` });
  if (!c.image_url) return [low];
  const full = h('img', { class: 'hero-img full', alt: '', decoding: 'async', style: `object-position:${pos}` });
  full.onload = () => { full.classList.add('ready'); };
  full.onerror = () => full.remove(); // keep the preview if the full photo cannot load
  full.src = c.image_url;
  return [low, full];
}

function hero(ev) {
  const c = ev.cover && (ev.cover.thumbnail_url || ev.cover.image_url) ? ev.cover : null;
  const desc = ev.description ? h('p', { class: 'hero-desc clamp' }, ev.description) : null;
  const more = ev.description && ev.description.length > 160
    ? h('button', { class: 'hero-more', type: 'button', onclick: (e) => { const open = desc.classList.toggle('clamp'); e.currentTarget.textContent = open ? 'Read more' : 'Show less'; } }, 'Read more') : null;
  return h('header', { class: `hero${c ? ' has-cover' : ''}` },
    c ? coverImages(c.thumbnail_url ? c : { ...c, thumbnail_url: c.image_url }) : null,
    h('button', { class: 'btn icon ghost hero-theme', type: 'button', 'aria-label': 'Toggle dark mode', onclick: toggleTheme }, icon('moon')),
    h('div', { class: 'hero-in' },
      h('h1', null, ev.title),
      h('p', { class: 'hero-meta' }, icon('calendar', 16), formatEventDate(ev.event_date), ev.location ? [h('span', { class: 'sep' }), icon('folder', 16), ev.location] : null),
      desc, more));
}

async function main() {
  const token = tokenFromLocation();
  if (!token) return unavailable('not_found');
  mount(app, loading('Opening'));
  let data;
  try { data = await pub('POST', '/event/validate', { token }); }
  catch (e) { return e.code === 'EVENT_UNAVAILABLE' ? unavailable(e.details && e.details.reason) : failure(e.message); }
  const ev = data.event;
  document.title = ev.title;
  const galleryHost = h('div', { class: 'g-wrap' });
  mount(app, hero(ev), galleryHost, h('footer', { class: 'g-foot' }, 'Photos and videos are shared in their original quality.'));
  mountGallery(galleryHost, { token, eventTitle: ev.title, onUnavailable: unavailable });
}
main();
