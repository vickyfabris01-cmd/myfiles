// js/public/downloads.js  -  sequential download queue + download panel.
// No ZIP. One file at a time. Real progress where the browser lets us, a user tap where it does not.
//
// How each file is saved (best available first):
//   1. "Save to a folder"  (desktop Chrome/Edge, File System Access API): streamed to disk, exact progress, no browser prompts.
//   2. fetch -> Blob -> save, for files up to BLOB_MAX: exact progress and completion, so the queue is truly sequential.
//   3. Bigger files without a folder: the queue pauses and asks for one tap per file; the browser's own download manager takes over.
//   Optional "ask before each file" mode for browsers that block automatic multiple downloads.
import { pub, qs } from './api.js';
import { h, mount, formatBytes } from '../util.js';
import { icon } from '../icons.js';
import { openModal, toast, showError } from '../ui.js';

const MB = 1048576;
export const BLOB_MAX = 100 * MB;

const abortErr = () => new DOMException('Aborted', 'AbortError');
const isAbort = (e) => e && e.name === 'AbortError';
const sleep = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); rej(abortErr()); }, { once: true });
});

export function triggerDownload(url, filename) {
  const a = document.createElement('a');
  a.href = url; a.download = filename || ''; a.rel = 'noopener'; a.hidden = true;
  document.body.append(a); a.click();
  setTimeout(() => a.remove(), 1000);
}
export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  triggerDownload(url, filename);
  setTimeout(() => URL.revokeObjectURL(url), 120000);
}
export const supportsFolder = () => typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';

// "IMG_1.jpg" taken -> "IMG_1 (2).jpg"
export function uniqueName(used, name) {
  const clean = String(name || 'file').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 200) || 'file';
  let candidate = clean, n = 1;
  const dot = clean.lastIndexOf('.');
  const base = dot > 0 ? clean.slice(0, dot) : clean, ext = dot > 0 ? clean.slice(dot) : '';
  while (used.has(candidate.toLowerCase())) candidate = `${base} (${++n})${ext}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

/* ================= engine ================= */
export class DownloadManager {
  constructor({ token, call = pub, fetchFn = (...a) => fetch(...a), save = saveBlob, native = triggerDownload, dir = null, askEach = false, blobMax = BLOB_MAX, backoff = 1000 }) {
    Object.assign(this, { token, call, fetchFn, save, native, dir, askEach, blobMax, backoff });
    this.items = []; this.subs = new Set(); this.running = false; this.stopped = false; this.used = new Set();
  }

  subscribe(fn) { this.subs.add(fn); return () => this.subs.delete(fn); }
  _emit() { this.subs.forEach((f) => f(this)); }

  setItems(files) {
    this.items = files.map((f) => ({ id: f.id, filename: f.filename, size: f.size_bytes ?? f.size ?? 0, mime: f.mime_type || '', status: 'queued', loaded: 0, error: null, abort: null, wait: null, blob: null, url: null, urlAt: 0, saveName: null }));
    this._emit();
  }

  async start() {
    if (this.running) return;
    this.running = true; this.stopped = false; this._emit();
    try {
      for (;;) {
        const it = this.items.find((i) => i.status === 'queued');
        if (!it || this.stopped) break;
        await this._one(it);
      }
    } finally { this.running = false; this._emit(); }
  }

  async _url(it) {
    const r = await this.call('POST', `/event/${this.token}/download`, { file_ids: [it.id] });
    const x = r.items && r.items[0];
    if (!x) throw Object.assign(new Error('This file is no longer available'), { fatal: true });
    it.url = x.url; it.urlAt = Date.now();
    return x.url;
  }

  _name(it) { if (!it.saveName) it.saveName = uniqueName(this.used, it.filename); return it.saveName; }

  async _one(it) {
    it.abort = new AbortController(); it.status = 'preparing'; it.loaded = 0; it.error = null; this._emit();
    try {
      await this._url(it);
      if (it.abort.signal.aborted) throw abortErr();
      if (this.dir) await this._toFolder(it);
      else if (it.size <= this.blobMax) {
        try { await this._toBlob(it); }
        catch (e) {
          // tracked download kept failing at the network level (blocked, flaky, or missing CORS): let the browser download it itself, on a tap
          if (isAbort(e) || it.status === 'cancelled' || e.status !== undefined || e.fatal) throw e;
          it.note = 'Could not track this download. Tap Save to download it with your browser.';
          await this._native(it);
        }
      }
      else await this._native(it);
      if (it.status !== 'cancelled') { it.status = 'done'; it.loaded = it.size; }
    } catch (e) {
      if (it.status === 'cancelled' || isAbort(e)) it.status = 'cancelled';
      else { it.status = 'failed'; it.error = e && e.status === undefined && !e.fatal ? 'Connection lost. Retry to try again.' : (e && e.message) || 'Download failed'; }
    }
    it.blob = null; it.wait = null; this._emit();
  }

  async _download(it, makeSink) {
    for (let attempt = 0; ; attempt++) {
      let sink = null;
      try {
        const res = await this.fetchFn(it.url, { signal: it.abort.signal });
        if (!res.ok) throw Object.assign(new Error(`Download failed (${res.status})`), { status: res.status });
        sink = await makeSink();
        it.status = 'downloading'; it.loaded = 0; this._emit();
        if (res.body && res.body.getReader) {
          const reader = res.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            await sink.write(value); it.loaded += value.length; this._emit();
          }
        } else {
          const buf = new Uint8Array(await res.arrayBuffer());
          await sink.write(buf); it.loaded = buf.length;
        }
        return await sink.finish();
      } catch (e) {
        try { if (sink) await sink.abort(); } catch { /* ignore */ }
        if (isAbort(e) || it.abort.signal.aborted) throw abortErr();
        const retryable = e.status === undefined ? !e.fatal : (e.status === 0 || e.status === 403 || e.status >= 500);
        if (!retryable || attempt >= 3) throw e;
        await sleep(this.backoff * 2 ** attempt, it.abort.signal);
        if (e.status === 403 || Date.now() - it.urlAt > 600000) await this._url(it); // expired link: get a fresh one
      }
    }
  }

  async _toBlob(it) {
    const blob = await this._download(it, () => {
      let chunks = [];
      return { write: (c) => { chunks.push(c); }, abort: () => { chunks = []; }, finish: async () => new Blob(chunks, { type: it.mime || 'application/octet-stream' }) };
    });
    if (this.askEach) { it.blob = blob; it.status = 'ready'; this._emit(); await this._wait(it); return; }
    this.save(blob, this._name(it));
  }

  async _toFolder(it) {
    const name = this._name(it);
    await this._download(it, async () => {
      const handle = await this.dir.getFileHandle(name, { create: true });
      const w = await handle.createWritable();
      return {
        write: (c) => w.write(c), finish: () => w.close(),
        abort: async () => { try { await w.abort(); } catch { /* ignore */ } try { await this.dir.removeEntry(name); } catch { /* ignore */ } },
      };
    });
  }

  async _native(it) { it.status = 'waiting'; this._emit(); await this._wait(it); }

  _wait(it) { return new Promise((res) => { it.wait = res; }); }

  // user tapped Save on an item that is waiting for a tap
  async userSave(id) {
    const it = this.items.find((i) => i.id === id);
    if (!it || !it.wait) return;
    try {
      if (it.status === 'ready' && it.blob) this.save(it.blob, this._name(it));
      else if (it.status === 'waiting') {
        const url = Date.now() - it.urlAt < 600000 ? it.url : await this._url(it);
        this.native(url, this._name(it));
      }
    } catch (e) { it.status = 'failed'; it.error = e.message; }
    const w = it.wait; it.wait = null; w();
  }

  cancel(id) {
    const it = this.items.find((i) => i.id === id);
    if (!it || ['done', 'cancelled'].includes(it.status)) return;
    it.status = 'cancelled';
    if (it.abort) it.abort.abort();
    if (it.wait) { const w = it.wait; it.wait = null; w(); }
    this._emit();
  }
  cancelAll() { this.stopped = true; this.items.forEach((i) => this.cancel(i.id)); }

  retry(id) {
    const it = this.items.find((i) => i.id === id);
    if (!it || !['failed', 'cancelled'].includes(it.status)) return;
    it.status = 'queued'; it.error = null; it.note = null; it.loaded = 0; it.saveName = null;
    this._emit();
    if (!this.running) this.start();
  }
  retryFailed() {
    this.items.filter((i) => i.status === 'failed').forEach((i) => { i.status = 'queued'; i.error = null; i.loaded = 0; i.saveName = null; });
    this._emit();
    if (!this.running) this.start();
  }

  stats() {
    const c = (...s) => this.items.filter((i) => s.includes(i.status)).length;
    const bytesTotal = this.items.reduce((a, i) => a + i.size, 0);
    const bytesDone = this.items.reduce((a, i) => a + (i.status === 'done' ? i.size : Math.min(i.loaded, i.size)), 0);
    return { total: this.items.length, done: c('done'), failed: c('failed'), cancelled: c('cancelled'), remaining: c('queued', 'preparing', 'downloading', 'ready', 'waiting'),
      bytesTotal, bytesDone, pct: bytesTotal ? Math.round((bytesDone / bytesTotal) * 100) : 0 };
  }
}

/* ================= helpers for gathering files ================= */
export async function fetchManifest(token, { scope, folderId }) {
  const out = [];
  for (let offset = 0; ; ) {
    const r = await pub('GET', `/event/${token}/manifest${qs({ scope, folder_id: folderId, offset, limit: 1000 })}`);
    out.push(...r.items.map((f) => ({ id: f.id, filename: f.filename, size_bytes: f.size_bytes, media_type: f.media_type })));
    if (!r.has_more || !r.items.length) break;
    offset += r.items.length;
  }
  return out;
}

// single file: hand the signed URL to the browser (works for any size, browser shows its own progress)
export async function downloadOne(token, file) {
  try {
    const r = await pub('POST', `/event/${token}/download`, { file_ids: [file.id] });
    if (!r.items[0]) throw new Error('This file is no longer available');
    triggerDownload(r.items[0].url, r.items[0].filename);
    toast('Download started', 'success', 2500);
  } catch (e) { showError(e); }
}

/* ================= panel ================= */
let session = null; // { mgr, modal, chip, setup }

function chipEnsure() {
  let chip = document.getElementById('dl-chip');
  if (!chip) { chip = h('button', { id: 'dl-chip', class: 'dl-chip', type: 'button', hidden: true }); document.body.append(chip); }
  return chip;
}

export function hasActiveDownload() { return !!(session && session.mgr && session.mgr.running); }

if (typeof window !== 'undefined') window.addEventListener('beforeunload', (e) => { if (hasActiveDownload()) { e.preventDefault(); e.returnValue = ''; } });

export async function openDownloadFlow({ token, title, collect }) {
  if (hasActiveDownload()) { showPanel(); toast('A download is already running', 'info'); return; }
  const setup = { token, title, files: [], dir: null, askEach: false, state: 'preparing', error: null };
  session = { mgr: null, modal: null, setup };
  showPanel();
  try {
    setup.files = await collect();
    setup.state = setup.files.length ? 'ready' : 'empty';
  } catch (e) { setup.state = 'error'; setup.error = e.message; }
  render();
}

function showPanel() {
  if (!session) return;
  if (session.modal) return;
  session.modal = openModal({ title: session.setup.title || 'Download', body: h('div', { class: 'dl-body' }), className: 'dl-panel' });
  session.modal.closed.then(() => { if (session) { session.modal = null; updateChip(); } });
  render();
}

let pending = false;
function render() {
  if (pending) return; pending = true;
  (globalThis.requestAnimationFrame || ((f) => setTimeout(f, 30)))(() => { pending = false; draw(); updateChip(); });
}

function updateChip() {
  const chip = chipEnsure();
  const m = session && session.mgr;
  if (!m || !m.running || session.modal) { chip.hidden = true; return; }
  const s = m.stats();
  chip.hidden = false;
  mount(chip, icon('download', 18), h('span', null, `Downloading ${Math.min(s.done + 1, s.total)} of ${s.total} - ${s.pct}%`));
  chip.onclick = () => showPanel();
}

function statusText(it) {
  switch (it.status) {
    case 'queued': return 'Waiting';
    case 'preparing': return 'Preparing';
    case 'downloading': return it.size ? `${Math.round((it.loaded / it.size) * 100)}%` : 'Downloading';
    case 'ready': return 'Ready. Tap Save';
    case 'waiting': return it.note || 'Large file. Tap Save';
    case 'done': return 'Saved';
    case 'failed': return it.error || 'Failed';
    case 'cancelled': return 'Cancelled';
    default: return it.status;
  }
}

function draw() {
  if (!session || !session.modal) return;
  const body = session.modal.el.querySelector('.dl-body');
  if (!body) return;
  const { setup, mgr } = session;

  if (!mgr) {
    if (setup.state === 'preparing') return mount(body, h('div', { class: 'loading' }, h('span', { class: 'spinner' }), h('span', null, 'Preparing the file list')));
    if (setup.state === 'error') return mount(body, h('p', { class: 'danger-text' }, setup.error || 'Could not prepare the download'), h('button', { class: 'btn secondary', type: 'button', onclick: () => session.modal.close() }, 'Close'));
    if (setup.state === 'empty') return mount(body, h('p', { class: 'muted' }, 'There are no files to download here.'), h('button', { class: 'btn secondary', type: 'button', onclick: () => session.modal.close() }, 'Close'));
    const total = setup.files.reduce((a, f) => a + (f.size_bytes || 0), 0);
    const big = setup.files.filter((f) => f.size_bytes > BLOB_MAX).length;
    const ask = h('input', { type: 'checkbox', id: 'dl-ask' });
    ask.checked = setup.askEach; ask.addEventListener('change', () => { setup.askEach = ask.checked; });
    const begin = (dir) => {
      const m = new DownloadManager({ token: setup.token, dir, askEach: setup.askEach });
      m.setItems(setup.files); session.mgr = m;
      m.subscribe(render); m.start().then(() => render());
      render();
    };
    return mount(body,
      h('p', null, h('b', null, `${setup.files.length} file${setup.files.length === 1 ? '' : 's'}`), `, ${formatBytes(total)}`),
      h('p', { class: 'muted' }, 'Files download one at a time, as the original photos and videos, with no zip.'),
      supportsFolder() ? h('div', { class: 'dl-note' }, icon('info', 18), h('span', null, 'Recommended: save straight to a folder on this computer. It is the most reliable for many or large files.')) : null,
      big && !supportsFolder() ? h('div', { class: 'dl-note' }, icon('info', 18), h('span', null, `${big} large video${big === 1 ? '' : 's'} will ask for one tap each, because browsers cannot track very large downloads.`)) : null,
      h('label', { class: 'check' }, ask, h('span', null, 'Ask me before saving each file (use this if your browser blocks multiple downloads)')),
      h('div', { class: 'row gap-s wrap dl-actions' },
        supportsFolder() ? h('button', { class: 'btn primary', type: 'button', onclick: async () => {
          try { begin(await window.showDirectoryPicker({ mode: 'readwrite' })); } catch (e) { if (!isAbort(e)) showError(e); }
        } }, icon('folder', 18), 'Save to a folder') : null,
        h('button', { class: `btn ${supportsFolder() ? 'secondary' : 'primary'}`, type: 'button', onclick: () => begin(null) }, icon('download', 18), supportsFolder() ? 'Use browser downloads' : 'Start download'),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => session.modal.close() }, 'Cancel')));
  }

  const s = mgr.stats();
  const active = mgr.items.filter((i) => ['preparing', 'downloading', 'ready', 'waiting'].includes(i.status));
  const failed = mgr.items.filter((i) => i.status === 'failed');
  const next = mgr.items.filter((i) => i.status === 'queued').slice(0, 5);
  const row = (it) => h('div', { class: `dl-row ${it.status}` },
    h('div', { class: 'grow dl-main' }, h('b', { class: 'dl-name' }, it.filename), h('small', null, `${formatBytes(it.size)} - ${statusText(it)}`),
      it.status === 'downloading' ? (() => { const f = h('span', { class: 'bar-fill' }); f.style.width = `${it.size ? Math.round((it.loaded / it.size) * 100) : 0}%`; return h('div', { class: 'bar' }, f); })() : null),
    ['ready', 'waiting'].includes(it.status) ? h('button', { class: 'btn primary sm', type: 'button', onclick: () => mgr.userSave(it.id) }, icon('download', 16), 'Save') : null,
    it.status === 'failed' ? h('button', { class: 'btn secondary sm', type: 'button', onclick: () => mgr.retry(it.id) }, 'Retry') : null,
    ['queued', 'preparing', 'downloading', 'ready', 'waiting'].includes(it.status) ? h('button', { class: 'btn icon ghost sm', type: 'button', 'aria-label': `Cancel ${it.filename}`, onclick: () => mgr.cancel(it.id) }, icon('x', 16)) : null);
  const finished = !mgr.running && s.remaining === 0;
  const bar = h('span', { class: 'bar-fill' }); bar.style.width = `${s.pct}%`;
  mount(body,
    h('div', { class: 'row between wrap' },
      h('b', null, finished ? (s.failed ? `Finished with ${s.failed} problem${s.failed === 1 ? '' : 's'}` : s.cancelled && !s.done ? 'Cancelled' : 'All files saved') : `${s.done} of ${s.total} saved`),
      h('span', { class: 'muted small' }, `${formatBytes(s.bytesDone)} of ${formatBytes(s.bytesTotal)}`)),
    h('div', { class: 'bar lg' }, bar),
    h('p', { class: 'muted small' }, finished ? `${s.done} saved${s.failed ? `, ${s.failed} failed` : ''}${s.cancelled ? `, ${s.cancelled} cancelled` : ''}.` : `${s.remaining} remaining. You can close this window; downloads continue.`),
    h('div', { class: 'dl-list' }, active.map(row), failed.map(row), next.map(row),
      s.remaining - active.length - next.length > 0 ? h('p', { class: 'muted small center' }, `and ${s.remaining - active.length - next.length} more waiting`) : null),
    h('div', { class: 'row gap-s wrap dl-actions' },
      s.failed && !mgr.running ? h('button', { class: 'btn primary', type: 'button', onclick: () => mgr.retryFailed() }, icon('refresh', 18), 'Retry failed') : null,
      mgr.running || s.remaining ? h('button', { class: 'btn danger', type: 'button', onclick: () => mgr.cancelAll() }, icon('x', 18), 'Cancel all') : null,
      h('button', { class: 'btn secondary', type: 'button', onclick: () => session.modal.close() }, finished ? 'Done' : 'Hide')));
}
