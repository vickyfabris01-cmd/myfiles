// js/admin/folders.js  -  media browser inside the event editor: nested folders, covers, selection, move, delete. Also the folder picker.
import { get, post, patch, del, qs } from '../api.js';
import { ROUTES } from './auth.js';
import { h, mount, clear, formatBytes, formatDuration, formatDateTime, debounce } from '../util.js';
import { icon } from '../icons.js';
import { toast, showError, formDialog, confirmDialog, actionSheet, openModal, loading, emptyState, withBusy } from '../ui.js';
import { CONFIG } from '../config.js';
import { positionCover } from './cover-position.js';
import { pickVideoThumbnail } from './video-thumb.js';

const thumbImg = (t) => (t && t.thumbnail_url ? h('img', { src: t.thumbnail_url, alt: '', loading: 'lazy', decoding: 'async', style: t.pos_x != null ? `object-position:${t.pos_x}% ${t.pos_y}%` : undefined }) : null);

/* ---------- folder picker (used for Move and for choosing the upload destination) ---------- */
export function pickFolder({ eventId, startFolderId = null, title = 'Choose a folder', confirmLabel = 'Select this folder', excludeId = null }) {
  return new Promise((resolve) => {
    let cur = null;
    const body = h('div', { class: 'picker' }, loading());
    const ok = h('button', { class: 'btn primary', type: 'button', onclick: () => m.close({ folderId: cur }) }, confirmLabel);
    const m = openModal({ title, body, footer: [h('button', { class: 'btn secondary', type: 'button', onclick: () => m.close(null) }, 'Cancel'), ok], className: 'small' });
    m.closed.then((v) => resolve(v || null));

    async function show(folderId) {
      mount(body, loading());
      try {
        const r = await get(`/admin/events/${eventId}/contents${qs({ folder_id: folderId, limit: 1 })}`);
        cur = folderId;
        const crumbs = [{ id: null, name: 'Top level' }, ...r.breadcrumbs];
        const rows = r.folders.filter((f) => f.id !== excludeId);
        mount(body,
          h('nav', { class: 'crumbs small' }, crumbs.map((c, i) => [
            i > 0 ? icon('chevron', 14) : null,
            i === crumbs.length - 1 ? h('span', { class: 'crumb current' }, c.name) : h('button', { class: 'crumb', type: 'button', onclick: () => show(c.id) }, c.name)])),
          rows.length
            ? h('div', { class: 'picker-list' }, rows.map((f) => h('button', { class: 'picker-row', type: 'button', onclick: () => show(f.id) }, icon('folder', 20), h('span', { class: 'grow' }, f.name), icon('chevron', 16))))
            : h('p', { class: 'muted center' }, 'No subfolders here.'));
      } catch (e) { showError(e); if (folderId) show(null); }
    }
    show(startFolderId);
  });
}

/* ---------- media browser ---------- */
export function mountBrowser(root, { event, readOnly = false, onChanged = () => {} }) {
  const eventId = event.id;
  const S = {
    folderId: new URLSearchParams(location.search).get('folder') || null,
    current: null, crumbs: [], folders: [], files: [], total: 0, hasMore: false,
    selected: new Map(), selecting: false, q: '', type: '', sort: 'newest', ro: readOnly, seq: 0, loaded: false,
  };
  const tileEls = new Map();

  const crumbsHost = h('nav', { class: 'crumbs', 'aria-label': 'Folder path' });
  const toolbarHost = h('div', { class: 'media-toolbar' });
  const foldersHost = h('div');
  const filesHost = h('div');
  const moreHost = h('div', { class: 'center pad-v' });
  const selbar = h('div', { class: 'selbar', hidden: true });
  mount(root, crumbsHost, toolbarHost, foldersHost, filesHost, moreHost, selbar);

  const url = (folderId) => `${location.pathname}?id=${encodeURIComponent(eventId)}${folderId ? `&folder=${encodeURIComponent(folderId)}` : ''}${location.hash}`;

  async function load(reset = true) {
    const seq = ++S.seq;
    if (reset && !S.loaded) mount(filesHost, loading('Loading media'));
    try {
      const offset = reset ? 0 : S.files.length;
      const r = await get(`/admin/events/${eventId}/contents${qs({
        folder_id: S.folderId, status: 'all', limit: CONFIG.LIMITS.PAGE_SIZE, offset, type: S.type, sort: S.sort, q: S.q, scope: S.q ? 'event' : undefined })}`);
      if (seq !== S.seq) return;
      S.loaded = true;
      S.current = r.current; S.crumbs = r.breadcrumbs; S.folders = r.folders;
      S.files = reset ? r.files.items : S.files.concat(r.files.items);
      S.total = r.files.total; S.hasMore = r.files.has_more;
      renderAll();
    } catch (e) {
      if (seq !== S.seq) return;
      if (e.status === 404 && S.folderId) { S.folderId = null; history.replaceState(null, '', url(null)); return load(true); }
      mount(filesHost, emptyState('alert', 'Could not load media', e.message, h('button', { class: 'btn primary', type: 'button', onclick: () => load(true) }, 'Try again')));
    }
  }

  function openFolder(id, push = true) {
    S.folderId = id; S.selected.clear(); S.selecting = false; S.q = '';
    if (push) history.pushState(null, '', url(id));
    renderToolbar(); load(true);
  }
  window.addEventListener('popstate', () => {
    const f = new URLSearchParams(location.search).get('folder') || null;
    if (f !== S.folderId) openFolder(f, false);
  });

  function renderCrumbs() {
    const items = [{ id: null, name: 'All media' }, ...S.crumbs];
    mount(crumbsHost, items.map((c, i) => [
      i > 0 ? icon('chevron', 14) : null,
      i === items.length - 1 && !S.q ? h('span', { class: 'crumb current' }, c.name) : h('button', { class: 'crumb', type: 'button', onclick: () => openFolder(c.id) }, c.name)]));
  }

  function renderToolbar() {
    const chip = (key, label) => h('button', { class: `chip${S.type === key ? ' active' : ''}`, type: 'button', onclick: () => { S.type = key; renderToolbar(); load(true); } }, label);
    const search = h('input', { class: 'input', type: 'search', placeholder: 'Search filename', value: S.q, 'aria-label': 'Search by filename' });
    search.addEventListener('input', debounce(() => { S.q = search.value.trim(); load(true); }, 350));
    const sort = h('select', { class: 'input sort', 'aria-label': 'Sort', value: S.sort, onchange: (e) => { S.sort = e.target.value; load(true); } },
      h('option', { value: 'newest' }, 'Newest'), h('option', { value: 'oldest' }, 'Oldest'), h('option', { value: 'filename' }, 'Filename'));
    mount(toolbarHost,
      S.ro ? null : h('div', { class: 'row gap-s wrap' },
        h('button', { class: 'btn secondary', type: 'button', onclick: createFolder }, icon('folder-plus', 18), 'New folder'),
        h('a', { class: 'btn primary', href: ROUTES.upload(eventId, S.folderId) }, icon('upload', 18), 'Upload here'),
        h('button', { class: `btn ${S.selecting ? 'primary' : 'secondary'}`, type: 'button', 'aria-pressed': String(S.selecting), onclick: () => { S.selecting = !S.selecting; if (!S.selecting) S.selected.clear(); renderToolbar(); renderFiles(); renderSelbar(); } }, icon('select', 18), S.selecting ? 'Done' : 'Select'),
        S.selecting ? h('button', { class: 'btn ghost', type: 'button', onclick: () => { S.files.forEach((f) => S.selected.set(f.id, f)); renderFiles(); renderSelbar(); } }, 'Select all loaded') : null),
      h('div', { class: 'row gap-s wrap filters' }, h('div', { class: 'search grow' }, icon('search', 18), search), h('div', { class: 'chips' }, chip('', 'All'), chip('photo', 'Photos'), chip('video', 'Videos')), sort));
  }

  /* ---------- folders ---------- */
  function folderCard(f) {
    const prev = [0, 1].map((i) => h('div', { class: 'fc-th' }, thumbImg(f.previews[i])));
    return h('article', { class: 'folder-card' },
      h('button', { class: 'folder-open', type: 'button', onclick: () => openFolder(f.id), 'aria-label': `Open folder ${f.name}` },
        h('div', { class: 'fc-cover' }, thumbImg(f.cover) || h('div', { class: 'cover-ph' }, icon('folder', 30))),
        h('div', { class: 'fc-strip' }, prev)),
      h('div', { class: 'fc-foot' }, icon('folder', 18),
        h('div', { class: 'grow' }, h('b', { class: 'fc-name' }, f.name),
          h('small', null, f.file_count === 0 ? 'Empty - hidden from visitors' : `${f.file_count} file${f.file_count === 1 ? '' : 's'}${f.cover_mode === 'manual' ? ' - chosen cover' : ''}`)),
        S.ro ? null : h('button', { class: 'btn icon ghost', type: 'button', 'aria-label': `Actions for ${f.name}`, onclick: () => folderMenu(f) }, icon('more'))));
  }

  function renderFolders() {
    if (S.q || !S.folders.length) { clear(foldersHost); return; }
    mount(foldersHost, h('h2', { class: 'h3' }, 'Folders'), h('div', { class: 'folder-grid' }, S.folders.map(folderCard)));
  }

  function folderMenu(f) {
    actionSheet(f.name, [
      { label: 'Open', icon: 'folder', onClick: () => openFolder(f.id) },
      { label: 'Rename', icon: 'edit', onClick: () => renameFolder(f) },
      { label: 'Move', icon: 'move', onClick: () => moveFolder(f) },
      f.cover_mode === 'manual' && f.cover && f.cover.thumbnail_url ? { label: 'Adjust cover position', icon: 'move', hint: 'Drag to choose the visible area', onClick: () => adjustFolderCover(f) } : null,
      f.cover_mode === 'manual' ? { label: 'Use automatic cover', icon: 'refresh', hint: 'Newest photo or video', onClick: () => act(() => patch(`/admin/folders/${f.id}`, { cover_mode: 'auto' }), 'Cover is now automatic') } : null,
      { label: 'Delete folder', icon: 'trash', danger: true, onClick: () => deleteFolder(f) },
    ]);
  }

  async function createFolder() {
    const v = await formDialog({ title: 'New folder', submitLabel: 'Create', fields: [{ name: 'name', label: 'Folder name', required: true, maxLength: 150 }] });
    if (!v) return;
    try {
      const body = { event_id: eventId, name: v.name };
      if (S.folderId) body.parent_id = S.folderId;
      await post('/admin/folders', body);
      toast('Folder created. It appears to visitors once it has files.', 'success');
      await load(true);
    } catch (e) { showError(e.status === 409 ? new Error('A folder with that name already exists here') : e); }
  }

  async function renameFolder(f) {
    const v = await formDialog({ title: 'Rename folder', submitLabel: 'Rename', fields: [{ name: 'name', label: 'Folder name', required: true, maxLength: 150, value: f.name }] });
    if (!v || v.name === f.name) return;
    act(() => patch(`/admin/folders/${f.id}`, { name: v.name }), 'Folder renamed', (e) => (e.status === 409 ? new Error('A folder with that name already exists here') : e));
  }

  async function moveFolder(f) {
    const r = await pickFolder({ eventId, startFolderId: S.folderId, title: `Move "${f.name}" to`, confirmLabel: 'Move here', excludeId: f.id });
    if (!r) return;
    act(() => patch(`/admin/folders/${f.id}`, { parent_id: r.folderId }), 'Folder moved', (e) => (e.status === 409 ? new Error('A folder with that name already exists there') : e));
  }

  async function deleteFolder(f) {
    const ok = await confirmDialog({
      title: `Delete "${f.name}"?`, danger: true, confirmLabel: 'Delete folder',
      message: h('div', null, h('p', null, `The folder, its subfolders and ${f.file_count} file${f.file_count === 1 ? '' : 's'} move to the recycle bin as one item. You can restore them for 2 days, then they are permanently deleted.`), h('p', { class: 'muted' }, 'Items in the bin still use your storage.')),
    });
    if (!ok) return;
    act(() => del(`/admin/folders/${f.id}`), 'Folder moved to the recycle bin');
  }

  /* ---------- files ---------- */
  function tile(f) {
    const sel = S.selected.has(f.id);
    const t = h('button', {
      class: `tile${sel ? ' selected' : ''}${f.status !== 'ready' ? ' incomplete' : ''}`, type: 'button', 'aria-label': f.filename,
      onclick: () => (S.selecting ? toggle(f) : openFile(f)),
    },
    thumbImg(f) || h('div', { class: 'tile-ph' }, icon(f.media_type === 'video' ? 'video' : 'image', 26)),
    f.media_type === 'video' ? h('span', { class: 'tile-badge' }, icon('play', 11), f.duration_seconds != null ? formatDuration(f.duration_seconds) : null) : null,
    f.status !== 'ready' ? h('span', { class: 'tile-status' }, f.status === 'uploading' ? 'Uploading' : 'Failed') : null,
    S.selecting ? h('span', { class: 'tile-check' }, sel ? icon('check', 16) : null) : null,
    h('span', { class: 'tile-name' }, f.filename));
    tileEls.set(f.id, t);
    return t;
  }

  function renderFiles() {
    tileEls.clear();
    if (!S.files.length) {
      const nothing = !S.folders.length && !S.q && !S.type;
      mount(filesHost, nothing
        ? emptyState('image', S.folderId ? 'This folder is empty' : 'No media yet', S.ro ? '' : 'Upload photos and videos, or create folders to organise them.',
          S.ro ? null : h('a', { class: 'btn primary', href: ROUTES.upload(eventId, S.folderId) }, icon('upload', 18), 'Upload here'))
        : S.q || S.type ? emptyState('search', 'No files found', 'Try a different search or filter.') : null);
      mount(moreHost); return;
    }
    mount(filesHost,
      h('h2', { class: 'h3' }, S.q ? `Search results (${S.total})` : S.folders.length ? `Files here (${S.total})` : `Files (${S.total})`),
      h('div', { class: 'tile-grid' }, S.files.map(tile)));
    mount(moreHost, S.hasMore ? h('button', { class: 'btn secondary', type: 'button', onclick: (e) => withBusy(e.currentTarget, () => load(false)) }, `Load more (${S.files.length} of ${S.total})`) : null);
  }

  function toggle(f) {
    if (S.selected.has(f.id)) S.selected.delete(f.id); else S.selected.set(f.id, f);
    const t = tileEls.get(f.id);
    if (t) { const on = S.selected.has(f.id); t.classList.toggle('selected', on); const c = t.querySelector('.tile-check'); if (c) mount(c, on ? icon('check', 16) : null); }
    renderSelbar();
  }

  function renderSelbar() {
    const n = S.selected.size;
    selbar.hidden = !(S.selecting && n > 0) || S.ro;
    if (selbar.hidden) return;
    const files = [...S.selected.values()];
    mount(selbar,
      h('button', { class: 'btn icon ghost', type: 'button', 'aria-label': 'Clear selection', onclick: () => { S.selected.clear(); renderFiles(); renderSelbar(); } }, icon('x')),
      h('b', { class: 'grow' }, `${n} selected`),
      n === 1 ? h('button', { class: 'btn secondary sm', type: 'button', onclick: () => setCover(files[0]) }, icon('star', 16), 'Cover') : null,
      n === 1 && files[0].media_type === 'video' && files[0].status === 'ready' ? h('button', { class: 'btn secondary sm', type: 'button', onclick: () => setVideoThumb(files[0]) }, icon('video', 16), 'Thumbnail') : null,
      h('button', { class: 'btn secondary sm', type: 'button', onclick: () => moveFiles(files) }, icon('move', 16), 'Move'),
      h('button', { class: 'btn danger sm', type: 'button', onclick: () => deleteFiles(files) }, icon('trash', 16), 'Delete'));
  }

  function openFile(f) {
    const rows = [['Type', f.media_type === 'video' ? 'Video' : 'Photo'], ['Size', formatBytes(f.size_bytes)], f.width && f.height ? ['Dimensions', `${f.width} x ${f.height}`] : null,
      f.duration_seconds != null ? ['Duration', formatDuration(f.duration_seconds)] : null, ['Format', f.mime_type], ['Added', formatDateTime(f.created_at)], ['Status', f.status === 'ready' ? 'Ready' : f.status === 'uploading' ? 'Incomplete upload' : 'Failed']].filter(Boolean);
    const m = openModal({
      title: f.filename, className: 'small',
      body: h('div', { class: 'stack' },
        h('div', { class: 'preview' }, thumbImg(f) || h('div', { class: 'cover-ph' }, icon(f.media_type === 'video' ? 'video' : 'image', 36))),
        h('dl', { class: 'facts' }, rows.map(([k, v]) => [h('dt', null, k), h('dd', null, v)])),
        f.status !== 'ready' ? h('p', { class: 'banner warn flat' }, icon('info', 18), h('span', null, 'This upload did not finish. Visitors cannot see it. Delete it and upload again.')) : null),
      footer: S.ro ? null : [
        f.status === 'ready' ? h('button', { class: 'btn secondary', type: 'button', onclick: () => { m.close(); setCover(f); } }, icon('star', 18), 'Set as cover') : null,
        f.status === 'ready' && f.media_type === 'video' ? h('button', { class: 'btn secondary', type: 'button', onclick: () => { m.close(); setVideoThumb(f); } }, icon('video', 18), f.thumbnail_url ? 'Change thumbnail' : 'Choose thumbnail') : null,
        h('button', { class: 'btn secondary', type: 'button', onclick: () => { m.close(); renameFile(f); } }, icon('edit', 18), 'Rename'),
        h('button', { class: 'btn secondary', type: 'button', onclick: () => { m.close(); moveFiles([f]); } }, icon('move', 18), 'Move'),
        h('button', { class: 'btn danger', type: 'button', onclick: () => { m.close(); deleteFiles([f]); } }, icon('trash', 18), 'Delete')],
    });
  }

  // Slide through the video, pick a frame, upload it as the thumbnail (replaces the current one).
  async function setVideoThumb(f) {
    let src;
    try { src = (await get(`/admin/files/${f.id}/source`)).url; } catch (e) { showError(e); return; }
    const blob = await pickVideoThumbnail({ src, duration: f.duration_seconds, title: `Thumbnail for ${f.filename}` });
    if (!blob) return;
    await act(async () => {
      const info = await post(`/admin/files/${f.id}/thumbnail`);
      let res;
      try { res = await fetch(info.upload_url, { method: 'PUT', headers: { 'Content-Type': info.content_type || 'image/jpeg' }, body: blob }); }
      catch { throw new Error('Could not reach storage. Check your connection and try again.'); }
      if (!res.ok) throw new Error(`Storage refused the thumbnail (${res.status})`);
      await post(`/admin/files/${f.id}/thumbnail/confirm`, { key: info.key });
    }, 'Thumbnail updated');
  }

  async function renameFile(f) {
    const v = await formDialog({ title: 'Rename file', submitLabel: 'Rename', intro: 'Only the name shown and used for downloads changes. The stored original is untouched.', fields: [{ name: 'filename', label: 'File name', required: true, maxLength: 255, value: f.filename }] });
    if (!v || v.filename === f.filename) return;
    act(() => patch(`/admin/files/${f.id}`, { filename: v.filename }), 'File renamed');
  }

  async function moveFiles(files) {
    const r = await pickFolder({ eventId, startFolderId: S.folderId, title: `Move ${files.length} file${files.length === 1 ? '' : 's'} to`, confirmLabel: 'Move here' });
    if (!r) return;
    S.selected.clear();
    act(() => post('/admin/files/bulk', { action: 'move', file_ids: files.map((f) => f.id), folder_id: r.folderId }), `Moved ${files.length} file${files.length === 1 ? '' : 's'}`);
  }

  async function deleteFiles(files) {
    const ok = await confirmDialog({
      title: `Delete ${files.length} file${files.length === 1 ? '' : 's'}?`, danger: true, confirmLabel: 'Delete',
      message: 'They move to the recycle bin. You can restore them for 2 days, then they are permanently deleted. Unfinished uploads are removed at once.',
    });
    if (!ok) return;
    S.selected.clear();
    act(() => post('/admin/files/bulk', { action: 'delete', file_ids: files.map((f) => f.id) }), `Moved ${files.length} file${files.length === 1 ? '' : 's'} to the recycle bin`);
  }

  // Cover targets: the event, plus every folder in the current path when the file sits directly in the current folder.
  // After choosing where, a window opens to drag the photo so only the wanted area shows.
  function setCover(f) {
    if (f.status !== 'ready') { toast('Only finished uploads can be used as a cover', 'error'); return; }
    if (f.media_type === 'video' && !f.thumbnail_url) { toast('This video has no thumbnail yet. Open it and choose a thumbnail first.', 'error'); return; }
    const items = [{ label: 'Event cover', icon: 'star', hint: event.title, onClick: () => pickAndSave(f, 'event', `/admin/events/${eventId}`, 'Event cover updated') }];
    if (f.folder_id && f.folder_id === S.folderId) {
      for (const c of S.crumbs.slice().reverse()) items.push({ label: `Folder cover: ${c.name}`, icon: 'folder', onClick: () => pickAndSave(f, 'folder', `/admin/folders/${c.id}`, `Cover of "${c.name}" updated`) });
    }
    actionSheet('Set as cover for', items);
  }

  async function pickAndSave(f, kind, path, okMsg) {
    if (!f.thumbnail_url) { act(() => patch(path, { cover_mode: 'manual', cover_file_id: f.id }), okMsg); return; }
    const p = await positionCover({ src: f.thumbnail_url, kind, title: kind === 'event' ? 'Position event cover' : 'Position folder cover' });
    if (!p) return;
    act(() => patch(path, { cover_mode: 'manual', cover_file_id: f.id, cover_pos_x: p.x, cover_pos_y: p.y }), okMsg);
  }

  async function adjustFolderCover(f) {
    const p = await positionCover({ src: f.cover.thumbnail_url, kind: 'folder', x: f.cover.pos_x, y: f.cover.pos_y, title: `Position cover of "${f.name}"` });
    if (!p) return;
    act(() => patch(`/admin/folders/${f.id}`, { cover_pos_x: p.x, cover_pos_y: p.y }), 'Cover position saved');
  }

  async function act(fn, okMsg, mapErr) {
    try { await fn(); if (okMsg) toast(okMsg, 'success'); await load(true); onChanged(); }
    catch (e) { showError(mapErr ? mapErr(e) : e); }
  }

  renderToolbar(); renderCrumbs();
  const renderAll = () => { renderCrumbs(); renderFolders(); renderFiles(); renderSelbar(); };
  load(true);

  return {
    reload: () => load(true),
    setReadOnly(v) { if (S.ro === v) return; S.ro = v; if (v) { S.selecting = false; S.selected.clear(); } renderToolbar(); if (S.loaded) renderAll(); },
  };
}
