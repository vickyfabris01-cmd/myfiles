// js/public/viewer.js  -  full-screen photo and video viewer: next/previous, zoom (wheel, pinch, double tap, buttons), pan, swipe.
import { pub } from './api.js';
import { h, mount, formatBytes, formatDateTime, formatDuration } from '../util.js';
import { icon } from '../icons.js';

const MIN = 1, MAX = 6;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export class Viewer {
  // getFiles(): current loaded files, loadMore(): Promise, hasMore(): bool, onDownload(file)
  constructor({ token, getFiles, hasMore, loadMore, onDownload, onReport }) {
    Object.assign(this, { token, getFiles, hasMore, loadMore, onDownload, onReport });
    this.root = null; this.index = -1; this.nav = 0;
    this.scale = 1; this.tx = 0; this.ty = 0; this.pointers = new Map(); this.drag = null; this.pinch = null;
    this.media = null; this.openFlag = false; this.restoreFocus = null; this.pushed = false;
    this._key = (e) => this.onKey(e);
    this._pop = () => { if (this.openFlag) { this.pushed = false; this.close(true); } };
  }

  get isOpen() { return this.openFlag; }
  get file() { return this.getFiles()[this.index]; }

  build() {
    this.titleEl = h('b', { class: 'v-title' });
    this.metaEl = h('span', { class: 'v-meta' });
    this.stage = h('div', { class: 'v-stage' });
    this.spin = h('div', { class: 'v-spin', hidden: true }, h('span', { class: 'spinner' }));
    this.note = h('div', { class: 'v-note', hidden: true });
    this.counter = h('span', { class: 'v-count' });
    const b = (label, ic, fn, cls = '') => h('button', { class: `v-btn ${cls}`, type: 'button', 'aria-label': label, title: label, onclick: fn }, icon(ic, 22));
    this.closeBtn = b('Close', 'x', () => this.close());
    this.prevBtn = b('Previous', 'chevron-left', () => this.go(-1), 'v-nav v-prev');
    this.nextBtn = b('Next', 'chevron', () => this.go(1), 'v-nav v-next');
    this.zoomBtns = h('div', { class: 'v-zoom' }, b('Zoom out', 'zoom-out', () => this.zoomBy(1 / 1.5)), b('Zoom in', 'zoom-in', () => this.zoomBy(1.5)), b('Reset zoom', 'refresh', () => this.resetZoom()));
    this.dlBtn = b('Download original', 'download', () => this.file && this.onDownload(this.file));
    this.reportBtn = this.onReport ? b('Report this file', 'flag', () => this.file && this.onReport(this.file)) : null;
    this.root = h('div', { class: 'v-root', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Media viewer', hidden: true },
      h('div', { class: 'v-top' }, this.closeBtn, h('div', { class: 'v-info' }, this.titleEl, this.metaEl), this.zoomBtns, this.reportBtn, this.dlBtn),
      this.stage, this.prevBtn, this.nextBtn, this.spin, this.note, h('div', { class: 'v-bottom' }, this.counter));
    document.body.append(this.root);

    const st = this.stage;
    st.addEventListener('wheel', (e) => { if (!this.isImage()) return; e.preventDefault(); this.zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX, e.clientY); }, { passive: false });
    st.addEventListener('dblclick', (e) => { if (!this.isImage()) return; if (this.scale > 1.01) this.resetZoom(); else this.zoomAt(2.5, e.clientX, e.clientY); });
    st.addEventListener('pointerdown', (e) => this.pDown(e));
    st.addEventListener('pointermove', (e) => this.pMove(e));
    ['pointerup', 'pointercancel', 'pointerleave'].forEach((t) => st.addEventListener(t, (e) => this.pUp(e)));
  }

  isImage() { return this.media && this.media.tagName === 'IMG'; }

  open(index) {
    if (!this.root) this.build();
    this.restoreFocus = document.activeElement;
    this.openFlag = true; this.root.hidden = false;
    document.body.classList.add('v-open');
    document.addEventListener('keydown', this._key);
    window.addEventListener('popstate', this._pop);
    try { history.pushState({ viewer: true }, ''); this.pushed = true; } catch { this.pushed = false; }
    this.show(index);
    this.closeBtn.focus();
  }

  close(fromPop = false) {
    if (!this.openFlag) return;
    this.openFlag = false; this.nav++;
    this.stopMedia();
    this.root.hidden = true; document.body.classList.remove('v-open');
    document.removeEventListener('keydown', this._key); window.removeEventListener('popstate', this._pop);
    if (!fromPop && this.pushed) { this.pushed = false; try { history.back(); } catch { /* ignore */ } }
    if (this.restoreFocus && this.restoreFocus.focus) this.restoreFocus.focus();
  }

  stopMedia() {
    if (this.media) { if (this.media.tagName === 'VIDEO') { try { this.media.pause(); } catch { /* ignore */ } this.media.removeAttribute('src'); this.media.load && this.media.load(); } this.media.remove(); this.media = null; }
  }

  async go(dir) {
    const files = this.getFiles();
    const next = this.index + dir;
    if (next < 0) return;
    if (next >= files.length) {
      if (this.hasMore()) { this.spin.hidden = false; try { await this.loadMore(); } catch { /* keep position */ } this.spin.hidden = true; }
      if (next >= this.getFiles().length) return;
    }
    this.show(next);
  }

  onKey(e) {
    if (!this.openFlag) return;
    // typing in a dialog (for example the report form) must not move or close the viewer
    const t = e.target;
    if (t && t.closest && (t.closest('dialog') || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (e.key === 'Escape') { e.preventDefault(); this.close(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); this.go(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); this.go(-1); }
    else if (e.key === '+' || e.key === '=') this.zoomBy(1.5);
    else if (e.key === '-') this.zoomBy(1 / 1.5);
    else if (e.key === '0') this.resetZoom();
  }

  /* ----- showing a file ----- */
  async show(index) {
    const files = this.getFiles();
    const f = files[index];
    if (!f) return;
    this.index = index; const my = ++this.nav;
    this.stopMedia(); this.scale = 1; this.tx = 0; this.ty = 0; this.note.hidden = true;
    this.titleEl.textContent = f.filename;
    const bits = [formatBytes(f.size_bytes)];
    if (f.width && f.height) bits.push(`${f.width} x ${f.height}`);
    if (f.media_type === 'video' && f.duration_seconds != null) bits.push(formatDuration(f.duration_seconds));
    bits.push(formatDateTime(f.taken_at || f.created_at).replace(/, \d.*$/, ''));
    this.metaEl.textContent = bits.join(' - ');
    this.counter.textContent = `${index + 1} / ${this.hasMore() ? `${files.length}+` : files.length}`;
    this.prevBtn.disabled = index === 0;
    this.nextBtn.disabled = index >= files.length - 1 && !this.hasMore();
    this.zoomBtns.hidden = f.media_type === 'video';
    if (index >= files.length - 3 && this.hasMore()) this.loadMore().catch(() => {});

    if (f.media_type === 'video') await this.showVideo(f, my); else await this.showPhoto(f, my);
  }

  async inlineUrl(f) {
    const r = await pub('POST', `/event/${this.token}/download`, { file_ids: [f.id], disposition: 'inline' });
    if (!r.items[0]) throw new Error('This file is no longer available');
    return r.items[0].url;
  }

  async showPhoto(f, my) {
    const img = h('img', { class: 'v-img', alt: f.filename, draggable: 'false', decoding: 'async' });
    if (f.thumbnail_url) img.src = f.thumbnail_url; // instant preview while the original loads
    this.media = img; this.stage.append(img); this.apply();
    this.spin.hidden = false;
    try {
      const url = await this.inlineUrl(f);
      if (my !== this.nav) return;
      await new Promise((res, rej) => { const probe = new Image(); probe.onload = res; probe.onerror = () => rej(new Error('decode')); probe.src = url; });
      if (my !== this.nav) return;
      img.src = url;
    } catch {
      if (my !== this.nav) return;
      this.note.textContent = f.thumbnail_url ? 'Showing a preview only. Download the original to see it in full.' : 'This file cannot be displayed here. Use the download button to get the original.';
      this.note.hidden = false;
    }
    if (my === this.nav) this.spin.hidden = true;
  }

  async showVideo(f, my) {
    const v = h('video', { class: 'v-video', controls: true, playsinline: true, preload: 'metadata', poster: f.thumbnail_url || undefined });
    this.media = v; this.stage.append(v); this.spin.hidden = false;
    let retried = false;
    v.addEventListener('loadedmetadata', () => { if (my === this.nav) this.spin.hidden = true; });
    v.addEventListener('error', async () => {
      if (my !== this.nav) return;
      if (!retried) { // signed link may have expired while paused: get a new one and continue from the same spot
        retried = true; const t = v.currentTime || 0;
        try { v.src = await this.inlineUrl(f); v.currentTime = t; v.play().catch(() => {}); return; } catch { /* fall through */ }
      }
      this.spin.hidden = true;
      this.note.textContent = 'This video cannot be played in your browser. Download the original to watch it.'; this.note.hidden = false;
    });
    try { const url = await this.inlineUrl(f); if (my !== this.nav) return; v.src = url; }
    catch { if (my === this.nav) { this.spin.hidden = true; this.note.textContent = 'Could not load this video.'; this.note.hidden = false; } }
  }

  /* ----- zoom / pan ----- */
  apply() {
    if (!this.isImage()) return;
    this.media.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.scale})`;
    this.stage.classList.toggle('zoomed', this.scale > 1.01);
  }
  limit() {
    const r = this.stage.getBoundingClientRect();
    const mx = (r.width * (this.scale - 1)) / 2, my = (r.height * (this.scale - 1)) / 2;
    this.tx = clamp(this.tx, -mx, mx); this.ty = clamp(this.ty, -my, my);
    if (this.scale <= 1.001) { this.tx = 0; this.ty = 0; }
  }
  zoomAt(factor, cx, cy) {
    if (!this.isImage()) return;
    const r = this.stage.getBoundingClientRect();
    const px = cx - (r.left + r.width / 2), py = cy - (r.top + r.height / 2);
    const next = clamp(this.scale * factor, MIN, MAX), k = next / this.scale;
    this.tx = px - (px - this.tx) * k; this.ty = py - (py - this.ty) * k; this.scale = next;
    this.limit(); this.apply();
  }
  zoomBy(f) { const r = this.stage.getBoundingClientRect(); this.zoomAt(f, r.left + r.width / 2, r.top + r.height / 2); }
  resetZoom() { this.scale = 1; this.tx = 0; this.ty = 0; this.apply(); }

  pDown(e) {
    if (e.target.closest && e.target.closest('video')) return; // let the video controls work
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { this.stage.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    if (this.pointers.size === 2) { const [a, b] = [...this.pointers.values()]; this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), s: this.scale }; this.drag = null; }
    else this.drag = { x: e.clientX, y: e.clientY, tx: this.tx, ty: this.ty, t: Date.now(), moved: false };
  }
  pMove(e) {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pinch && this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      this.scale = clamp(this.pinch.s * (d / this.pinch.d), MIN, MAX); this.limit(); this.apply(); return;
    }
    if (this.drag && this.scale > 1.01) {
      this.tx = this.drag.tx + (e.clientX - this.drag.x); this.ty = this.drag.ty + (e.clientY - this.drag.y); this.drag.moved = true; this.limit(); this.apply();
    }
  }
  pUp(e) {
    if (!this.pointers.has(e.pointerId)) return;
    const d = this.drag;
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    if (d && e.type === 'pointerup' && this.scale <= 1.01 && this.pointers.size === 0) {
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) this.go(dx < 0 ? 1 : -1); // swipe
    }
    if (this.pointers.size === 0) this.drag = null;
  }
}
