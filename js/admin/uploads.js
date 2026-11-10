// js/admin/uploads.js  -  upload engine + upload page.
// Bytes go straight from the browser to R2 with presigned URLs. Originals are never read into memory whole, resized or re-encoded.
import { api, get, qs } from '../api.js';
import { CONFIG } from '../config.js';
import { requireAdmin, ROUTES } from './auth.js';
import { makeThumbnail } from './thumbs.js';
import { readTakenAt } from './taken.js';
import { pickFolder } from './folders.js';
import { h, mount, formatBytes } from '../util.js';
import { icon } from '../icons.js';
import { toast, showError, loading, emptyState, openModal } from '../ui.js';

/* ================= helpers ================= */
const EXT = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif', avif: 'image/avif', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo', '3gp': 'video/3gpp',
};
const extOf = (name) => name.split('.').pop().toLowerCase();

export function guessMime(file) {
  const t = (file.type || '').toLowerCase();
  if ((t.startsWith('image/') || t.startsWith('video/')) && t !== 'image/svg+xml') return t;
  return EXT[extOf(file.name)] || null;
}
export function kindOf(file) {
  const m = guessMime(file);
  return m ? (m.startsWith('video/') ? 'video' : 'photo') : null;
}

const abortErr = () => new DOMException('Aborted', 'AbortError');
const isAbort = (e) => e && e.name === 'AbortError';
const chunkArr = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
const sleep = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); rej(abortErr()); }, { once: true });
});

// PUT with real upload progress (fetch cannot report upload progress).
export function xhrPut(url, blob, { contentType, onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) { reject(abortErr()); return; }
    const x = new XMLHttpRequest();
    x.open('PUT', url);
    if (contentType) x.setRequestHeader('Content-Type', contentType);
    x.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded); };
    x.onload = () => (x.status >= 200 && x.status < 300 ? resolve({ etag: x.getResponseHeader('ETag') }) : reject(Object.assign(new Error(`Upload failed (${x.status})`), { status: x.status })));
    x.onerror = () => reject(Object.assign(new Error('Connection lost'), { status: 0 }));
    x.onabort = () => reject(abortErr());
    if (signal) signal.addEventListener('abort', () => x.abort(), { once: true });
    x.send(blob);
  });
}

const friendly = (e) => (e && (e.status === 0 || e.code === 'NETWORK') ? 'Connection lost. Tap Retry to continue where it stopped.' : (e && e.message) || 'Upload failed');

/* ================= duplicate warning ================= */
async function sha256Hex(file) {
  const buf = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Looks only at the place the files are going: the chosen folder, or the event's top level when no folder is chosen.
// Returns { duplicates: [{ file, reason, existing }], hashes: Map(file -> sha256) }. A failed check never blocks the upload.
export async function findDuplicates(files, { eventId, folderId, call = api }) {
  const list = Array.from(files).filter((f) => kindOf(f) && f.size > 0);
  const hashes = new Map();
  for (const f of list) {
    if (kindOf(f) === 'photo' && f.size <= CONFIG.LIMITS.IMAGE_BYTES) { try { hashes.set(f, await sha256Hex(f)); } catch { /* no hash: quick check only */ } }
  }
  const dups = new Map();
  const seenKey = new Map(); const seenHash = new Map();
  for (const f of list) { // the same file picked twice in one selection
    const key = `${f.name}\u0000${f.size}`; const hash = hashes.get(f);
    if (seenKey.has(key) || (hash && seenHash.has(hash))) dups.set(f, { file: f, reason: 'in_selection', existing: (seenKey.get(key) || seenHash.get(hash)).name });
    else { seenKey.set(key, f); if (hash) seenHash.set(hash, f); }
  }
  try {
    const todo = list.filter((f) => !dups.has(f));
    for (const part of chunkArr(todo, 100)) {
      const body = { event_id: eventId, files: part.map((f) => ({ name: f.name, size: f.size, hash: hashes.get(f) || undefined })) };
      if (folderId) body.folder_id = folderId;
      const r = await call('POST', '/admin/upload/check', body);
      for (const x of r.results) if (x.duplicate) dups.set(part[x.index], { file: part[x.index], reason: x.duplicate, existing: x.existing_filename });
    }
  } catch { /* offline or server hiccup: upload normally */ }
  return { duplicates: [...dups.values()], hashes };
}

const REASON = {
  same_name_size: (where) => `a file with the same name and size is already ${where}`,
  same_content: (where) => `the same photo (identical content) is already ${where}`,
  in_selection: () => 'you selected it twice',
};

// choice: 'skip' | 'all' | null (cancel)
function duplicateDialog(dups, where) {
  return new Promise((resolve) => {
    const shown = dups.slice(0, 8);
    const body = h('div', { class: 'stack' },
      h('p', null, `${dups.length} of the files you picked look like duplicates. Only files ${where} were compared.`),
      h('ul', { class: 'dup-list' }, shown.map((d) => h('li', null, h('b', null, d.file.name), h('span', { class: 'muted small' }, ` - ${REASON[d.reason](where)}`)))),
      dups.length > shown.length ? h('p', { class: 'muted small' }, `and ${dups.length - shown.length} more`) : null);
    const cancel = h('button', { class: 'btn ghost', type: 'button', onclick: () => m.close(null) }, 'Cancel');
    const all = h('button', { class: 'btn secondary', type: 'button', onclick: () => m.close('all') }, 'Upload anyway');
    const skip = h('button', { class: 'btn primary', type: 'button', onclick: () => m.close('skip') }, 'Skip duplicates');
    const m = openModal({ title: 'Possible duplicates', body, footer: [cancel, all, skip], className: 'small' });
    m.closed.then((v) => resolve(v === 'skip' || v === 'all' ? v : null));
  });
}

/* ================= engine ================= */
const STORE_KEY = 'myfiles.uploads';

export class UploadManager {
  constructor({ put = xhrPut, makeThumb = makeThumbnail, call = api, store = globalThis.localStorage, concurrency = 3, partConcurrency = 3, backoff = 1000 } = {}) {
    Object.assign(this, { put, makeThumb, call, store, concurrency, partConcurrency, backoff });
    this.items = []; this.subs = new Set(); this.running = 0; this.seq = 0; this.wakeLock = null;
  }

  subscribe(fn) { this.subs.add(fn); return () => this.subs.delete(fn); }
  _emit() { this.subs.forEach((f) => f(this)); }

  /* ----- queue ----- */
  addFiles(files, { eventId, folderId = null, hashes = null }) {
    const added = [];
    for (const file of Array.from(files)) {
      const kind = kindOf(file);
      const it = { id: ++this.seq, file, name: file.name, size: file.size, kind, eventId, folderId, status: 'queued', loaded: 0, error: null, warning: null, fatal: false, resumed: false, sessionId: null, fileId: null, previewUrl: null, meta: null, contentHash: (hashes && hashes.get(file)) || null, takenAt: undefined, restarts: 0, netFail: false, result: null, abort: new AbortController() };
      const maxBytes = kind === 'video' ? CONFIG.LIMITS.VIDEO_BYTES : CONFIG.LIMITS.IMAGE_BYTES;
      if (!kind) Object.assign(it, { status: 'failed', fatal: true, error: 'Only photos and videos can be uploaded' });
      else if (file.size === 0) Object.assign(it, { status: 'failed', fatal: true, error: 'This file is empty' });
      else if (file.size > maxBytes) Object.assign(it, { status: 'failed', fatal: true, error: `Too large. ${kind === 'video' ? 'Videos' : 'Photos'} can be at most ${Math.round(maxBytes / 1048576)} MB` });
      this.items.push(it); added.push(it);
    }
    this._emit(); this._pump();
    return added;
  }

  _pump() {
    while (this.running < this.concurrency) {
      const next = this.items.find((i) => i.status === 'queued');
      if (!next) break;
      this._start(next);
    }
  }

  _start(item) {
    this.running++;
    if (this.running === 1) this._wake(true);
    item.status = 'preparing'; this._emit();
    this._process(item)
      .catch((e) => {
        if (item.status === 'cancelled') return;
        if (isAbort(e)) { item.status = 'cancelled'; return; }
        item.status = 'failed'; item.error = friendly(e); item.netFail = e && e.status === 0;
      })
      .finally(() => { this.running--; if (this.running === 0) this._wake(false); this._emit(); this._pump(); });
  }

  async _wake(on) {
    try {
      if (on && typeof navigator !== 'undefined' && navigator.wakeLock) this.wakeLock = await navigator.wakeLock.request('screen');
      else if (!on && this.wakeLock) { await this.wakeLock.release(); this.wakeLock = null; }
    } catch { /* not supported or denied */ }
  }

  async _process(item) {
    for (;;) {
      try { await this._attempt(item); return; }
      catch (e) { if (e && e.restart && item.restarts < 2) { item.restarts++; item.loaded = 0; continue; } throw e; }
    }
  }

  /* ----- persistence of sessions for resume ----- */
  _key(i) { return `${i.eventId}|${i.folderId || ''}|${i.name}|${i.size}|${i.file.lastModified || 0}`; }
  _read() { try { return JSON.parse(this.store.getItem(STORE_KEY)) || {}; } catch { return {}; } }
  _saved(i) { const e = this._read()[this._key(i)]; return e && Date.parse(e.expires_at) > Date.now() ? e.session_id : null; }
  _remember(i, sessionId, expiresAt) { try { const m = this._read(); m[this._key(i)] = { session_id: sessionId, expires_at: expiresAt }; this.store.setItem(STORE_KEY, JSON.stringify(m)); } catch { /* ignore */ } }
  _forget(i) { try { const m = this._read(); delete m[this._key(i)]; this.store.setItem(STORE_KEY, JSON.stringify(m)); } catch { /* ignore */ } }

  /* ----- one upload attempt ----- */
  async _attempt(item) {
    const signal = item.abort.signal;
    item.status = 'preparing'; item.loaded = 0; item.error = null; item.warning = null; this._emit();

    if (!item.meta) {
      item.meta = await this.makeThumb(item.file, item.kind).catch(() => ({ blob: null }));
      if (item.meta.blob && !item.previewUrl) item.previewUrl = URL.createObjectURL(item.meta.blob);
    }
    if (signal.aborted) throw abortErr();
    const meta = item.meta;

    // resume an interrupted upload if we remember its session
    let info = null;
    const saved = this._saved(item);
    if (saved) {
      try {
        const st = await this.call('GET', `/admin/upload/status${qs({ session_id: saved })}`);
        if (st.status === 'completed') { item.status = 'done'; item.loaded = item.size; this._forget(item); return; }
        info = st; item.sessionId = saved; item.fileId = st.file_id; item.resumed = true;
      } catch (e) { if (e.status === 404 || e.status === 410) this._forget(item); else throw e; }
    }
    if (!info) {
      const body = { event_id: item.eventId, filename: item.name, mime_type: guessMime(item.file), size_bytes: item.size };
      if (item.folderId) body.folder_id = item.folderId;
      // date taken (read from the file's first bytes) decides where it sorts; none = sorts by upload time
      if (item.takenAt === undefined) item.takenAt = await readTakenAt(item.file, item.kind);
      if (item.takenAt) body.taken_at = item.takenAt;
      if (item.contentHash) body.content_hash = item.contentHash;
      if (meta.width && meta.height) { body.width = meta.width; body.height = meta.height; }
      if (meta.duration != null) body.duration_seconds = meta.duration;
      info = await this.call('POST', '/admin/upload/authorize', body);
      item.sessionId = info.session_id; item.fileId = info.file_id;
      this._remember(item, info.session_id, info.expires_at);
    }
    if (signal.aborted) throw abortErr();
    item.status = 'uploading'; this._emit();

    // preview first (small), never blocks the original
    let thumbDone = Promise.resolve();
    if (meta.blob) {
      thumbDone = this.put(info.thumbnail_upload_url, meta.blob, { contentType: 'image/jpeg', signal })
        .catch((e) => { if (isAbort(e)) throw e; item.warning = 'Preview could not be uploaded'; });
      thumbDone.catch(() => {});
    } else item.warning = item.kind === 'video' ? 'No thumbnail made. Choose one later from the video\'s details' : 'No preview for this file type';

    const multipart = info.mode === 'multipart';
    let singleUrl = info.upload_url;
    const putSingle = () => this._retry(signal,
      () => this.put(singleUrl, item.file, { contentType: info.content_type || guessMime(item.file), signal, onProgress: (n) => { item.loaded = n; this._emit(); } }),
      async () => { singleUrl = (await this.call('GET', `/admin/upload/status${qs({ session_id: item.sessionId })}`)).upload_url; });

    if (multipart) {
      const done = new Map((info.uploaded_parts || []).map((p) => [p.part_number, p.size]));
      const missing = [];
      for (let n = 1; n <= info.total_parts; n++) if (!done.has(n)) missing.push(n);
      const base = [...done.values()].reduce((a, b) => a + b, 0);
      await this._uploadParts(item, info.part_size, missing, base, signal);
    } else await putSingle();

    await thumbDone;
    item.status = 'finishing'; item.loaded = item.size; this._emit();

    for (let attempt = 0; ; attempt++) {
      try { item.result = (await this.call('POST', '/admin/upload/complete', { session_id: item.sessionId })).file; break; }
      catch (e) {
        if (e.code === 'SIZE_MISMATCH') {
          this._forget(item);
          await this.call('POST', '/admin/upload/abort', { session_id: item.sessionId }).catch(() => {});
          throw Object.assign(new Error(e.message), { restart: true });
        }
        if (e.code === 'UPLOAD_INCOMPLETE' && attempt < 2) {
          const miss = (e.details && e.details.missing_parts) || [];
          if (multipart && miss.length) {
            const ps = info.part_size, total = info.total_parts;
            const missBytes = miss.reduce((s, n) => s + (n < total ? ps : item.size - ps * (total - 1)), 0);
            await this._uploadParts(item, ps, miss, item.size - missBytes, signal);
            continue;
          }
          if (!multipart) { await putSingle(); continue; }
        }
        throw e;
      }
    }
    item.status = 'done'; item.loaded = item.size; this._forget(item); this._emit();
  }

  async _retry(signal, fn, onExpired, tries = 4) {
    for (let a = 0; ; a++) {
      try { return await fn(); }
      catch (e) {
        if (isAbort(e) || signal.aborted) throw isAbort(e) ? e : abortErr();
        const retryable = e.status === 0 || e.status === 403 || e.status >= 500;
        if (!retryable || a >= tries - 1) throw e;
        if (e.status === 403 && onExpired) await onExpired();
        await sleep(this.backoff * 2 ** a, signal);
      }
    }
  }

  async _uploadParts(item, partSize, nums, baseBytes, signal) {
    const inner = new AbortController();
    signal.addEventListener('abort', () => inner.abort(), { once: true });
    const progress = new Map();
    let base = baseBytes;
    const update = () => { let s = base; for (const v of progress.values()) s += v; item.loaded = Math.min(s, item.size); this._emit(); };
    update();
    const urls = new Map();
    const loadUrls = async (list) => {
      for (const c of chunkArr(list, 50)) (await this.call('POST', '/admin/upload/parts', { session_id: item.sessionId, part_numbers: c })).parts.forEach((p) => urls.set(p.part_number, p.url));
    };
    await loadUrls(nums);
    const queue = [...nums];
    const worker = async () => {
      while (queue.length) {
        if (inner.signal.aborted) throw abortErr();
        const n = queue.shift();
        const blob = item.file.slice((n - 1) * partSize, Math.min(item.size, n * partSize));
        await this._retry(inner.signal, async () => {
          progress.set(n, 0);
          await this.put(urls.get(n), blob, { signal: inner.signal, onProgress: (v) => { progress.set(n, v); update(); } });
        }, () => loadUrls([n]));
        progress.delete(n); base += blob.size; update();
      }
    };
    try { await Promise.all(Array.from({ length: Math.min(this.partConcurrency, nums.length) }, worker)); }
    catch (e) { inner.abort(); throw e; }
  }

  /* ----- controls ----- */
  find(id) { return this.items.find((i) => i.id === id); }

  cancel(id) {
    const it = this.find(id);
    if (!it || it.status === 'done' || it.status === 'cancelled') return;
    const session = it.sessionId;
    const wasFatal = it.fatal;
    it.abort.abort(); it.status = 'cancelled'; it.error = null;
    if (session && !wasFatal) { this._forget(it); this.call('POST', '/admin/upload/abort', { session_id: session }).catch(() => {}); }
    this._emit();
  }
  cancelAll() { this.items.filter((i) => !['done', 'cancelled'].includes(i.status)).forEach((i) => this.cancel(i.id)); }

  retry(id) {
    const it = this.find(id);
    if (!it || it.status !== 'failed' || it.fatal) return;
    it.status = 'queued'; it.error = null; it.abort = new AbortController(); this._emit(); this._pump();
  }
  retryFailed({ networkOnly = false } = {}) {
    this.items.filter((i) => i.status === 'failed' && !i.fatal && (!networkOnly || i.netFail)).forEach((i) => this.retry(i.id));
  }

  clearFinished() {
    this.items = this.items.filter((i) => {
      const gone = i.status === 'done' || i.status === 'cancelled' || (i.status === 'failed' && i.fatal);
      if (gone && i.previewUrl) URL.revokeObjectURL(i.previewUrl);
      return !gone;
    });
    this._emit();
  }

  stats() {
    const real = this.items.filter((i) => !i.fatal && i.status !== 'cancelled');
    const c = (s) => real.filter((i) => s.includes(i.status)).length;
    const bytesTotal = real.reduce((s, i) => s + i.size, 0);
    const bytesDone = real.reduce((s, i) => s + (i.status === 'done' ? i.size : Math.min(i.loaded, i.size)), 0);
    return { total: real.length, done: c(['done']), failed: c(['failed']), active: c(['preparing', 'uploading', 'finishing']), queued: c(['queued']), rejected: this.items.filter((i) => i.fatal).length,
      bytesTotal, bytesDone, pct: bytesTotal ? Math.round((bytesDone / bytesTotal) * 100) : 0 };
  }
}

/* ================= page ================= */
const STATUS_TEXT = { queued: 'Waiting', preparing: 'Preparing', finishing: 'Verifying', done: 'Uploaded', cancelled: 'Cancelled' };

export async function initUploadPage() {
  await requireAdmin({ active: 'upload' });
  const app = document.getElementById('app');
  mount(app, loading());
  const params = new URLSearchParams(location.search);
  let events;
  try { events = (await get('/admin/events')).events; } catch (e) { mount(app, emptyState('alert', 'Could not load events', e.message)); return; }
  if (!events.length) { mount(app, emptyState('calendar', 'Create an event first', 'Uploads go into an event.', h('a', { class: 'btn primary', href: ROUTES.events }, 'Go to events'))); return; }

  let space = null; // { quota_bytes, free_bytes } so a big video can say how much of the host's space it will use
  get('/admin/storage').then((x) => { space = x; }).catch(() => {});
  const small = matchMedia('(max-width: 720px)').matches;
  const mgr = new UploadManager({ concurrency: small ? 2 : 3 });
  const dest = { eventId: events.some((e) => e.id === params.get('event')) ? params.get('event') : null, folderId: params.get('folder') || null, path: [] };

  const eventSel = h('select', { class: 'input', 'aria-label': 'Event' }, h('option', { value: '' }, 'Choose an event'), events.map((e) => h('option', { value: e.id }, e.title)));
  const pathHost = h('div', { class: 'dest-path' });
  const changeBtn = h('button', { class: 'btn secondary sm', type: 'button' }, icon('folder', 16), 'Change folder');
  const input = h('input', { type: 'file', multiple: true, accept: 'image/*,video/*,.heic,.heif', hidden: true });
  const zone = h('div', { class: 'dropzone', role: 'button', tabindex: '0', 'aria-label': 'Choose photos and videos' },
    h('div', { class: 'empty-ic' }, icon('upload', 28)), h('h3', null, 'Choose photos and videos'),
    h('p', { class: 'muted' }, 'Tap to pick from your gallery, or drop files here. Originals are uploaded untouched.'),
    h('p', { class: 'hint' }, `Up to ${Math.round(CONFIG.LIMITS.IMAGE_BYTES / 1048576)} MB per photo and ${Math.round(CONFIG.LIMITS.VIDEO_BYTES / 1048576)} MB per video. Tip: recording video at 1080p instead of 4K often halves the size.`));
  const summary = h('section', { class: 'card pad summary', hidden: true });
  const list = h('div', { class: 'u-list' });

  async function refreshPath() {
    if (!dest.eventId) { mount(pathHost, h('span', { class: 'muted' }, 'Pick an event first')); changeBtn.disabled = true; return; }
    changeBtn.disabled = false;
    const ev = events.find((e) => e.id === dest.eventId);
    let names = [];
    if (dest.folderId) {
      try { names = (await get(`/admin/events/${dest.eventId}/contents${qs({ folder_id: dest.folderId, limit: 1 })}`)).breadcrumbs.map((c) => c.name); }
      catch { dest.folderId = null; }
    }
    mount(pathHost, icon('folder', 18), h('span', null, [ev.title, ...names].join(' / ')), dest.folderId ? null : h('span', { class: 'muted small' }, ' (top level)'));
  }
  eventSel.value = dest.eventId || '';
  eventSel.addEventListener('change', () => { dest.eventId = eventSel.value || null; dest.folderId = null; refreshPath(); });
  changeBtn.addEventListener('click', async () => {
    const r = await pickFolder({ eventId: dest.eventId, startFolderId: dest.folderId, title: 'Upload into', confirmLabel: 'Upload here' });
    if (r) { dest.folderId = r.folderId; refreshPath(); }
  });

  let checking = false;
  async function choose(fileList) {
    if (!dest.eventId) { toast('Choose an event first', 'error'); eventSel.focus(); return; }
    if (!fileList || !fileList.length || checking) return;
    let files = Array.from(fileList);
    checking = true; zone.classList.add('busy');
    let hashes = null;
    try {
      const where = dest.folderId ? 'in this folder' : 'at the top level of this event';
      const found = await findDuplicates(files, { eventId: dest.eventId, folderId: dest.folderId });
      hashes = found.hashes;
      if (found.duplicates.length) {
        const choice = await duplicateDialog(found.duplicates, where);
        if (!choice) return;
        if (choice === 'skip') {
          const skipSet = new Set(found.duplicates.map((d) => d.file));
          files = files.filter((f) => !skipSet.has(f));
          toast(`Skipped ${skipSet.size} duplicate${skipSet.size === 1 ? '' : 's'}`, 'info');
        }
      }
    } finally { checking = false; zone.classList.remove('busy'); }
    if (!files.length) return;
    if (space) {
      for (const f of files) {
        if (f.size >= 50 * 1048576 && space.quota_bytes) {
          const pct = Math.max(1, Math.round((f.size / space.quota_bytes) * 100));
          toast(`${f.name} will use ${pct}% of your space (${formatBytes(Math.max(0, space.free_bytes))} free). Recording at 1080p instead of 4K often halves the size.`, pct >= 50 ? 'error' : 'info', 7000);
        }
      }
    }
    mgr.addFiles(files, { eventId: dest.eventId, folderId: dest.folderId, hashes });
  }
  zone.addEventListener('click', () => input.click());
  zone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  input.addEventListener('change', () => { choose(input.files); input.value = ''; });
  ['dragenter', 'dragover'].forEach((t) => zone.addEventListener(t, (e) => { e.preventDefault(); zone.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) => zone.addEventListener(t, (e) => { e.preventDefault(); zone.classList.remove('over'); }));
  zone.addEventListener('drop', (e) => choose(e.dataTransfer && e.dataTransfer.files));

  /* ----- rows ----- */
  const rows = new Map();
  function makeRow(it) {
    const prev = h('div', { class: 'u-prev' });
    const name = h('b', { class: 'u-name' }, it.name);
    const sub = h('small', { class: 'u-sub' });
    const bar = h('div', { class: 'bar' }, h('span', { class: 'bar-fill' }));
    const act = h('div', { class: 'u-act' });
    const row = h('div', { class: 'u-row' }, prev, h('div', { class: 'grow u-main' }, name, sub, bar), act);
    const r = { row, prev, sub, bar, fill: bar.firstChild, act, previewUrl: null, state: '' };
    rows.set(it.id, r);
    return r;
  }
  function updateRow(it) {
    const r = rows.get(it.id) || makeRow(it);
    if (it.previewUrl !== r.previewUrl) { r.previewUrl = it.previewUrl; mount(r.prev, it.previewUrl ? h('img', { src: it.previewUrl, alt: '' }) : icon(it.kind === 'video' ? 'video' : 'image', 22)); }
    else if (!r.prev.firstChild) mount(r.prev, icon(it.kind === 'video' ? 'video' : 'image', 22));
    const pct = it.size ? Math.round((it.loaded / it.size) * 100) : 0;
    let text;
    if (it.status === 'uploading') text = `${it.resumed ? 'Resuming. ' : ''}Uploading ${pct}%`;
    else if (it.status === 'failed') text = it.error;
    else text = STATUS_TEXT[it.status] || it.status;
    r.sub.textContent = `${formatBytes(it.size)} - ${text}${it.status === 'done' && it.warning ? ` (${it.warning})` : ''}`;
    r.row.className = `u-row ${it.status}`;
    r.fill.style.width = `${it.status === 'done' ? 100 : pct}%`;
    r.bar.hidden = !['uploading', 'finishing', 'preparing'].includes(it.status);
    const key = it.status;
    if (r.state !== key) {
      r.state = key;
      const btn = (label, ic, fn, cls = 'ghost') => h('button', { class: `btn icon ${cls}`, type: 'button', 'aria-label': label, title: label, onclick: fn }, icon(ic, 18));
      mount(r.act,
        it.status === 'failed' && !it.fatal ? btn('Retry', 'refresh', () => mgr.retry(it.id)) : null,
        ['queued', 'preparing', 'uploading', 'finishing'].includes(it.status) || (it.status === 'failed' && !it.fatal) ? btn('Cancel', 'x', () => mgr.cancel(it.id)) : null,
        ['done', 'cancelled'].includes(it.status) || (it.status === 'failed' && it.fatal) ? btn('Remove from list', 'x', () => { mgr.items = mgr.items.filter((i) => i.id !== it.id); rows.delete(it.id); r.row.remove(); render(); }) : null,
        it.status === 'done' ? h('span', { class: 'ok-ic' }, icon('check', 20)) : null);
    }
    return r.row;
  }

  let allDoneToast = false;
  function render() {
    const s = mgr.stats();
    summary.hidden = mgr.items.length === 0;
    zone.classList.toggle('compact', mgr.items.length > 0);
    if (!summary.hidden) {
      const remaining = s.queued + s.active;
      const parts = [`${s.done} of ${s.total} uploaded`];
      if (remaining) parts.push(`${remaining} remaining`);
      if (s.failed) parts.push(`${s.failed} failed`);
      if (s.rejected) parts.push(`${s.rejected} skipped`);
      mount(summary,
        h('div', { class: 'row between wrap' }, h('b', null, parts.join(' - ')), h('span', { class: 'muted small' }, `${formatBytes(s.bytesDone)} of ${formatBytes(s.bytesTotal)}`)),
        h('div', { class: 'bar lg' }, (() => { const f = h('span', { class: 'bar-fill' }); f.style.width = `${s.pct}%`; return f; })()),
        h('div', { class: 'row gap-s wrap' },
          s.failed ? h('button', { class: 'btn primary sm', type: 'button', onclick: () => mgr.retryFailed() }, icon('refresh', 16), 'Retry failed') : null,
          remaining || s.failed ? h('button', { class: 'btn secondary sm', type: 'button', onclick: () => mgr.cancelAll() }, icon('x', 16), 'Cancel all') : null,
          h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { mgr.clearFinished(); rows.clear(); mount(list); render(); } }, 'Clear finished'),
          dest.eventId ? h('a', { class: 'btn ghost sm', href: ROUTES.editor(dest.eventId, dest.folderId) }, icon('external', 16), 'Open event') : null));
      if (s.total && !remaining && !s.failed && s.done === s.total && !allDoneToast) { allDoneToast = true; toast('All uploads complete', 'success'); }
      if (remaining) allDoneToast = false;
    }
    const frag = mgr.items.map((it) => updateRow(it));
    const want = frag;
    if (list.children.length !== want.length || want.some((n, i) => list.children[i] !== n)) mount(list, want);
  }

  let queued = false;
  mgr.subscribe(() => {
    if (queued) return; queued = true;
    (globalThis.requestAnimationFrame || ((f) => setTimeout(f, 50)))(() => { queued = false; render(); });
  });

  window.addEventListener('beforeunload', (e) => { const s = mgr.stats(); if (s.active + s.queued > 0) { e.preventDefault(); e.returnValue = ''; } });
  window.addEventListener('offline', () => toast('You are offline. Uploads will pause and can be retried.', 'error', 6000));
  window.addEventListener('online', () => { toast('Back online. Resuming failed uploads.', 'success'); mgr.retryFailed({ networkOnly: true }); });

  mount(app,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Upload'), h('p', { class: 'muted' }, 'Photos and videos are stored exactly as they are: no compression, no resizing.'))),
    h('section', { class: 'card pad stack' },
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'Event'), eventSel),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Folder'), h('div', { class: 'row between wrap gap-s' }, pathHost, changeBtn))),
    zone, input, summary, list);
  refreshPath();
}
