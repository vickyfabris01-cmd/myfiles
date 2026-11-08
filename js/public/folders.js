// js/public/folders.js  -  breadcrumbs and folder cards (cover + two recent previews)
import { h, mount } from '../util.js';
import { icon } from '../icons.js';

const img = (t) => (t && t.thumbnail_url ? h('img', { src: t.thumbnail_url, alt: '', loading: 'lazy', decoding: 'async' }) : null);

export function renderCrumbs(host, { eventTitle, crumbs, searching, onOpen }) {
  const items = [{ id: null, name: eventTitle || 'All files' }, ...crumbs];
  mount(host, items.map((c, i) => [
    i > 0 ? icon('chevron', 14) : null,
    i === items.length - 1 && !searching
      ? h('span', { class: 'g-crumb current', 'aria-current': 'page' }, c.name)
      : h('button', { class: 'g-crumb', type: 'button', onclick: () => onOpen(c.id) }, c.name)]));
  host.hidden = items.length === 1 && !searching;
}

export function renderFolderCards(host, folders, onOpen) {
  if (!folders.length) { mount(host); host.hidden = true; return; }
  host.hidden = false;
  mount(host, h('h2', { class: 'g-h' }, 'Folders'),
    h('div', { class: 'g-folders' }, folders.map((f) =>
      h('button', { class: 'g-folder', type: 'button', onclick: () => onOpen(f.id), 'aria-label': `Open folder ${f.name}, ${f.file_count} files` },
        h('div', { class: 'gf-cover' }, img(f.cover) || h('div', { class: 'gf-ph' }, icon('folder', 30))),
        h('div', { class: 'gf-strip' }, [0, 1].map((i) => h('div', { class: 'gf-th' }, img(f.previews[i])))),
        h('div', { class: 'gf-foot' }, icon('folder', 18), h('span', { class: 'grow' }, h('b', null, f.name), h('small', null, `${f.file_count} file${f.file_count === 1 ? '' : 's'}`)), icon('chevron', 16))))));
}
