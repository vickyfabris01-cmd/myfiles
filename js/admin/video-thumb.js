// js/admin/video-thumb.js - "Choose thumbnail" window for a video: slide to the moment you want, then use that frame.
// Resolves a JPEG Blob (about 480 px, well under the 2 MB limit) or null if cancelled.
import { h } from '../util.js';
import { icon } from '../icons.js';
import { openModal } from '../ui.js';

const MAX = 480;
const clock = (t) => {
  const s = Math.max(0, t || 0);
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
};

// Draw the current frame to a small JPEG. Throws SecurityError if the video came from another origin without CORS.
export function frameToBlob(video, max = MAX, quality = 0.85) {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) throw new Error('no frame');
  const s = Math.min(1, max / Math.max(vw, vh));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(vw * s));
  canvas.height = Math.max(1, Math.round(vh * s));
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/jpeg', quality));
}

export function pickVideoThumbnail({ src, duration = null, title = 'Choose thumbnail' }) {
  return new Promise((resolve) => {
    const video = h('video', { class: 'vt-video', muted: '', playsinline: '', preload: 'auto', crossorigin: 'anonymous', 'aria-label': 'Video preview' });
    video.muted = true; video.playsInline = true; video.crossOrigin = 'anonymous';
    const status = h('div', { class: 'vt-status' }, h('span', { class: 'spinner' }), h('span', null, 'Loading video'));
    const stage = h('div', { class: 'vt-stage' }, video, status);
    const range = h('input', { class: 'vt-range', type: 'range', min: '0', max: '0', step: '0.05', value: '0', disabled: '', 'aria-label': 'Position in the video' });
    const label = h('span', { class: 'vt-time' }, '0:00.0');
    const total = h('span', { class: 'vt-time muted' }, '');
    const err = h('p', { class: 'form-msg' });
    const step = (d, text) => h('button', { class: 'btn secondary sm', type: 'button', onclick: () => nudge(d), 'aria-label': `${d < 0 ? 'Back' : 'Forward'} ${Math.abs(d)} seconds` }, text);
    const useBtn = h('button', { class: 'btn primary', type: 'button', disabled: '' }, icon('check', 18), 'Use this frame');
    const cancel = h('button', { class: 'btn secondary', type: 'button' }, 'Cancel');

    let dur = Number.isFinite(duration) && duration > 0 ? duration : 0;
    let ready = false, want = null, busy = false;

    const setTime = (t) => {
      const max = dur || Number(range.max) || 0;
      want = Math.min(Math.max(0, t), Math.max(0, max - 0.05));
      range.value = String(want);
      label.textContent = clock(want);
      if (!video.seeking) seek();
    };
    function seek() { if (want == null) return; const t = want; want = null; try { video.currentTime = t; } catch { /* not ready */ } }
    function nudge(d) { if (ready) setTime((Number(range.value) || 0) + d); }

    video.addEventListener('seeked', () => { if (want != null) seek(); });
    video.addEventListener('loadedmetadata', () => {
      if (Number.isFinite(video.duration) && video.duration > 0) dur = video.duration;
      range.max = String(dur || 0);
      total.textContent = dur ? `/ ${clock(dur)}` : '';
    });
    video.addEventListener('loadeddata', () => {
      ready = true; status.hidden = true; range.disabled = false; useBtn.disabled = false;
      // start a little in, the very first frame is often black
      setTime(Math.min(1, (dur || 2) / 2));
    });
    video.addEventListener('error', () => {
      status.hidden = false;
      status.replaceChildren(icon('alert', 20), h('span', null, 'This browser cannot play this video here. Try Chrome or another browser, or upload it again as MP4 (H.264).'));
    });
    range.addEventListener('input', () => { setTime(Number(range.value)); err.classList.remove('show'); });

    cancel.onclick = () => m.close(null);
    useBtn.onclick = async () => {
      if (!ready || busy) return;
      busy = true; useBtn.disabled = true;
      try {
        if (video.seeking) await new Promise((r) => video.addEventListener('seeked', r, { once: true }));
        m.close(await frameToBlob(video));
      } catch (e) {
        busy = false; useBtn.disabled = false;
        err.textContent = e && e.name === 'SecurityError'
          ? 'The browser blocked reading this frame. The storage bucket must allow this site in its CORS settings (see SETUP.md, step 2).'
          : 'Could not capture this frame. Try a different moment.';
        err.classList.add('show');
      }
    };

    const m = openModal({
      title, className: 'vt',
      body: h('div', { class: 'stack' },
        stage,
        h('div', { class: 'vt-controls' }, range, h('div', { class: 'row between' }, h('span', null, label, ' ', total), h('div', { class: 'row gap-s' }, step(-1, '-1s'), step(-0.1, '-0.1s'), step(0.1, '+0.1s'), step(1, '+1s')))),
        h('p', { class: 'hint' }, 'Slide to the moment you want, then tap Use this frame.'),
        err),
      footer: [cancel, useBtn],
    });
    m.closed.then((v) => { try { video.pause(); video.removeAttribute('src'); video.load(); } catch { /* ignore */ } resolve(v || null); });
    video.src = src;
  });
}
