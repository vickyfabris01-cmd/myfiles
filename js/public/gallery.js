// js/public/gallery.js  -  folders, justified photo/video grid, search, filter, sort, lazy loading, pagination, selection, downloads
import { pub, qs } from './api.js';
import { renderCrumbs, renderFolderCards } from './folders.js';
import { Viewer } from './viewer.js';
import { openDownloadFlow, fetchManifest } from './downloads.js';
import { h, mount, clear, formatBytes, formatDuration, debounce } from '../util.js';
import { icon } from '../icons.js';
import { actionSheet, loading, emptyState, toast } from '../ui.js';
import { CONFIG } from '../config.js';

const TARGET = () => (window.innerWidth < 720 ? 120 : 200);

export function mountGallery(root, { token, eventTitle, onUnavailable }) {
  const S = {
    folderId: new URLSearchParams(location.search).get('f') || null,
    current: null, crumbs: [], folders: [], files: [], total: 0, hasMore: false, loaded: false, loadingMore: false,
    q: '', type: '', sort: 'newest', selecting: false, selected: new Map(), seq: 0,
  };
  const crumbsHost = h('nav', { class: 'g-crumbs', 'aria-label': 'Folder path', hidden: true });
  const toolbar = h('div', { class: 'g-toolbar' });
  const foldersHost = h('section', { hidden: true });
  const gridHost = h('section');
  const moreHost = h('div', { class: 'g-more' });
  const selbar = h('div', { class: 'g-selbar', hidden: true });
  mount(root, crumbsHost, toolbar, foldersHost, gridHost, moreHost, selbar);

  const viewer = new Viewer({
    token, getFiles: () => S.files, hasMore: () => S.hasMore, loadMore: () => loadMore(),
    onDownload: (f) => import('./downloads.js').then((m) => m.downloadOne(token, f)),
  });

  const urlFor = (folderId) => {
    const p = new URLSearchParams(location.search);
    if (folderId) p.set('f', folderId); else p.delete('f');
    const s = p.toString();
    return `${location.pathname}${s ? `?${s}` : ''}`;
  };

  /* ---------- loading ---------- */
  const filesQuery = (offset) => qs({ folder_id: S.folderId, q: S.q, type: S.type, sort: S.sort, limit: CONFIG.LIMITS.PAGE_SIZE, offset, scope: S.q ? 'event' : undefined });

  async function load() {
    const seq = ++S.seq;
    if (!S.loaded) mount(gridHost, loading('Loading'));
    try {
      const [fo, fi] = await Promise.all([
        S.q ? Promise.resolve(null) : pub('GET', `/event/${token}/folders${qs({ parent_id: S.folderId })}`),
        pub('GET', `/event/${token}/files${filesQuery(0)}`),
      ]);
      if (seq !== S.seq) return;
      S.loaded = true;
      if (fo) { S.current = fo.current; S.crumbs = fo.breadcrumbs; S.folders = fo.folders; } else S.folders = [];
      S.files = fi.items; S.total = fi.total; S.hasMore = fi.has_more;
      renderAll();
    } catch (e) {
      if (seq !== S.seq) return;
      if (e.code === 'EVENT_UNAVAILABLE') return onUnavailable(e.details && e.details.reason);
      if (e.code === 'FOLDER_NOT_FOUND' && S.folderId) { S.folderId = null; history.replaceState(null, '', urlFor(null)); return load(); }
      mount(gridHost, emptyState('alert', 'Could not load', e.message, h('button', { class: 'btn primary', type: 'button', onclick: () => load() }, icon('refresh', 18), 'Try again')));
    }
  }

  async function loadMore() {
    if (S.loadingMore || !S.hasMore) return;
    S.loadingMore = true; const seq = S.seq;
    try {
      const fi = await pub('GET', `/event/${token}/files${filesQuery(S.files.length)}`);
      if (seq !== S.seq) return;
      const known = new Set(S.files.map((f) => f.id));
      const fresh = fi.items.filter((f) => !known.has(f.id));
      S.files = S.files.concat(fresh); S.total = fi.total; S.hasMore = fi.has_more;
      appendTiles(fresh); renderMore(); renderHeading();
    } catch (e) { toast(e.message, 'error'); }
    finally { S.loadingMore = false; }
  }

  function openFolder(id, push = true) {
    S.folderId = id; S.q = ''; S.selected.clear(); S.selecting = false;
    if (push) history.pushState(null, '', urlFor(id));
    renderToolbar(); window.scrollTo && window.scrollTo(0, 0);
    load();
  }
  window.addEventListener('popstate', () => {
    if (viewer.isOpen) return;
    const f = new URLSearchParams(location.search).get('f') || null;
    if (f !== S.folderId) openFolder(f, false);
  });

  /* ---------- toolbar ---------- */
  function renderToolbar() {
    const chip = (k, label) => h('button', { class: `g-chip${S.type === k ? ' active' : ''}`, type: 'button', 'aria-pressed': String(S.type === k), onclick: () => { S.type = k; renderToolbar(); load(); } }, label);
    const search = h('input', { class: 'input', type: 'search', placeholder: 'Search by filename', value: S.q, 'aria-label': 'Search by filename', enterkeyhint: 'search' });
    search.addEventListener('input', debounce(() => { S.q = search.value.trim(); load(); }, 350));
    const sort = h('select', { class: 'input g-sort', 'aria-label': 'Sort by date', value: S.sort, onchange: (e) => { S.sort = e.target.value; load(); } },
      h('option', { value: 'newest' }, 'Date: newest first'), h('option', { value: 'oldest' }, 'Date: oldest first'));
    mount(toolbar,
      h('div', { class: 'g-search' }, icon('search', 18), search),
      h('div', { class: 'g-controls' },
        h('div', { class: 'g-chips' }, chip('', 'All'), chip('photo', 'Photos'), chip('video', 'Videos')), sort,
        h('button', { class: `btn secondary sm${S.selecting ? ' on' : ''}`, type: 'button', 'aria-pressed': String(S.selecting), onclick: () => { S.selecting = !S.selecting; if (!S.selecting) S.selected.clear(); renderToolbar(); renderTiles(); renderSelbar(); } }, icon('select', 16), S.selecting ? 'Done' : 'Select'),
        h('button', { class: 'btn primary sm', type: 'button', onclick: downloadMenu }, icon('download', 16), 'Download')));
  }

  /* ---------- grid ---------- */
  let rows = null;
  const tileEls = new Map();

  function tile(f, i) {
    const ar = f.width && f.height ? Math.min(2.2, Math.max(0.6, f.width / f.height)) : 1;
    const sel = S.selected.has(f.id);
    const sp = h('i'); sp.style.paddingBottom = `${100 / ar}%`;
    const t = h('button', { class: `g-tile${sel ? ' selected' : ''}`, type: 'button', 'aria-label': `${f.media_type === 'video' ? 'Video' : 'Photo'} ${f.filename}`, dataset: { ar: String(ar) },
      onclick: () => (S.selecting ? toggle(f) : viewer.open(S.files.findIndex((x) => x.id === f.id))) },
    sp,
    f.thumbnail_url ? h('img', { src: f.thumbnail_url, alt: '', loading: 'lazy', decoding: 'async' }) : h('div', { class: 'g-ph' }, icon(f.media_type === 'video' ? 'video' : 'image', 28)),
    f.media_type === 'video' ? h('span', { class: 'g-badge' }, icon('play', 11), f.duration_seconds != null ? formatDuration(f.duration_seconds) : null) : null,
    S.selecting ? h('span', { class: 'g-check' }, sel ? icon('check', 16) : null) : null,
    h('span', { class: 'g-name' }, f.filename, h('small', null, formatBytes(f.size_bytes))));
    tileEls.set(f.id, t);
    return t;
  }

  function layout() {
    if (!rows) return;
    const H = TARGET();
    for (const t of rows.querySelectorAll('.g-tile')) { const ar = Number(t.dataset.ar) || 1; t.style.flexGrow = String(ar * 100); t.style.flexBasis = `${ar * H}px`; }
  }
  window.addEventListener('resize', debounce(layout, 150));

  function renderHeading() {
    const el = gridHost.querySelector('.g-h');
    if (el) el.textContent = S.q ? `Results for "${S.q}" (${S.total})` : S.type ? `${S.type === 'photo' ? 'Photos' : 'Videos'} (${S.total})` : S.folders.length || S.folderId ? `Files here (${S.total})` : `${S.total} file${S.total === 1 ? '' : 's'}`;
  }

  function renderTiles() {
    tileEls.clear();
    if (!S.files.length) {
      const nothing = !S.folders.length && !S.q && !S.type;
      mount(gridHost, S.folders.length && !S.q && !S.type ? null
        : emptyState(S.q ? 'search' : 'image', S.q ? 'No files found' : nothing ? 'Nothing here yet' : 'No matches', S.q ? 'Try a different name.' : nothing ? 'Files will show up here once they are added.' : 'Try another filter.',
          S.q || S.type ? h('button', { class: 'btn secondary', type: 'button', onclick: () => { S.q = ''; S.type = ''; renderToolbar(); load(); } }, 'Clear search and filters') : null));
      rows = null; renderMore(); return;
    }
    rows = h('div', { class: 'g-rows' }, S.files.map(tile), h('span', { class: 'g-fill' }));
    // keep the filler last
    mount(gridHost, h('h2', { class: 'g-h' }, ''), rows);
    layout(); renderHeading(); renderMore();
  }

  function appendTiles(list) {
    if (!rows) { renderTiles(); return; }
    const filler = rows.lastChild;
    for (const f of list) rows.insertBefore(tile(f), filler);
    layout();
  }

  let io = null;
  function renderMore() {
    if (io) { io.disconnect(); io = null; }
    if (!S.hasMore) { mount(moreHost); return; }
    const btn = h('button', { class: 'btn secondary', type: 'button', onclick: () => loadMore() }, `Load more (${S.files.length} of ${S.total})`);
    mount(moreHost, btn);
    if ('IntersectionObserver' in window) { io = new IntersectionObserver((en) => { if (en.some((e) => e.isIntersecting)) loadMore(); }, { rootMargin: '700px' }); io.observe(btn); }
  }

  function renderAll() {
    renderCrumbs(crumbsHost, { eventTitle, crumbs: S.crumbs, searching: !!S.q, onOpen: (id) => openFolder(id) });
    renderFolderCards(foldersHost, S.q ? [] : S.folders, (id) => openFolder(id));
    renderTiles(); renderSelbar();
  }

  /* ---------- selection + downloads ---------- */
  function toggle(f) {
    if (S.selected.has(f.id)) S.selected.delete(f.id); else S.selected.set(f.id, f);
    const t = tileEls.get(f.id);
    if (t) { const on = S.selected.has(f.id); t.classList.toggle('selected', on); const c = t.querySelector('.g-check'); if (c) mount(c, on ? icon('check', 16) : null); }
    renderSelbar();
  }

  function renderSelbar() {
    const n = S.selected.size;
    selbar.hidden = !(S.selecting && n > 0);
    if (selbar.hidden) return;
    const total = [...S.selected.values()].reduce((a, f) => a + f.size_bytes, 0);
    mount(selbar,
      h('button', { class: 'btn icon ghost', type: 'button', 'aria-label': 'Clear selection', onclick: () => { S.selected.clear(); renderTiles(); renderSelbar(); } }, icon('x')),
      h('span', { class: 'grow' }, h('b', null, `${n} selected`), h('small', null, formatBytes(total))),
      h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { S.files.forEach((f) => S.selected.set(f.id, f)); renderTiles(); renderSelbar(); } }, 'Select all'),
      h('button', { class: 'btn primary sm', type: 'button', onclick: () => startDownload('selected') }, icon('download', 16), 'Download'));
  }

  function downloadMenu() {
    const n = S.selected.size;
    actionSheet('Download', [
      n ? { label: `Selected files (${n})`, icon: 'select', hint: 'Only the files you ticked', onClick: () => startDownload('selected') } : null,
      S.folderId ? { label: 'This folder', icon: 'folder', hint: 'Including its subfolders', onClick: () => startDownload('folder') } : null,
      { label: 'Everything in this event', icon: 'download', hint: 'All folders and files, one at a time', onClick: () => startDownload('event') },
      !n ? { label: 'Choose files to download', icon: 'select', hint: 'Tick the photos and videos you want', onClick: () => { S.selecting = true; renderToolbar(); renderTiles(); toast('Tap the files you want, then press Download', 'info'); } } : null,
    ]);
  }

  function startDownload(kind) {
    const titleMap = { selected: 'Download selected files', folder: `Download "${(S.current && S.current.name) || 'folder'}"`, event: 'Download everything' };
    openDownloadFlow({
      token, title: titleMap[kind],
      collect: async () => {
        if (kind === 'selected') return [...S.selected.values()].map((f) => ({ id: f.id, filename: f.filename, size_bytes: f.size_bytes, mime_type: f.mime_type }));
        if (kind === 'folder') return fetchManifest(token, { scope: 'folder', folderId: S.folderId });
        return fetchManifest(token, { scope: 'event' });
      },
    });
  }

  renderToolbar();
  load();
  return { reload: load };
}
