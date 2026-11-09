// js/admin/thumbs.js  -  makes a small JPEG preview in the browser. The ORIGINAL file is never touched or re-encoded.
const MAX = 480;

const fit = (w, h) => { const s = Math.min(1, MAX / Math.max(w, h)); return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))]; };
const toBlob = (canvas) => new Promise((res) => canvas.toBlob((b) => res(b), 'image/jpeg', 0.8));
const timeout = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms));

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode failed')); };
    img.src = url;
  });
}

async function imageThumb(file) {
  let src, width, height, release = () => {};
  try {
    src = await createImageBitmap(file, { imageOrientation: 'from-image' });
    width = src.width; height = src.height; release = () => src.close && src.close();
  } catch {
    src = await loadImage(file); // fallback (also handles formats the browser can show but not bitmap-decode)
    width = src.naturalWidth; height = src.naturalHeight;
  }
  const [w, h] = fit(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(src, 0, 0, w, h);
  release();
  return { blob: await toBlob(canvas), width, height };
}

// Mean brightness (0-255) of a frame, from a tiny copy. Used to skip black opening frames.
function brightness(video) {
  try {
    const c = document.createElement('canvas'); c.width = 16; c.height = 16;
    const g = c.getContext('2d'); g.drawImage(video, 0, 0, 16, 16);
    const d = g.getImageData(0, 0, 16, 16).data; let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
    return sum / (d.length / 4);
  } catch { return 255; }
}

// Tries a few moments (a bit in, 25%, 50%, the start) and keeps the first frame that is not black.
function videoThumb(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    v.setAttribute('playsinline', ''); v.setAttribute('muted', '');
    const out = { blob: null, width: null, height: null, duration: null };
    let finished = false;
    const done = () => {
      if (finished) return; finished = true; clearTimeout(timer);
      URL.revokeObjectURL(url); v.removeAttribute('src'); try { v.load(); } catch { /* ignore */ }
      resolve(out);
    };
    const timer = setTimeout(done, 25000);
    const once = (ev, ms) => new Promise((res) => {
      const t = setTimeout(() => { v.removeEventListener(ev, f); res(false); }, ms);
      const f = () => { clearTimeout(t); res(true); };
      v.addEventListener(ev, f, { once: true });
    });
    const seekTo = async (t) => {
      if (Math.abs(v.currentTime - t) < 0.02 && v.readyState >= 2) return true;
      const waiting = once('seeked', 6000);
      try { v.currentTime = t; } catch { return false; }
      return waiting;
    };
    v.addEventListener('error', done);
    v.addEventListener('loadedmetadata', async () => {
      out.width = v.videoWidth || null; out.height = v.videoHeight || null;
      out.duration = Number.isFinite(v.duration) ? v.duration : null;
      if (v.readyState < 2) await once('loadeddata', 8000);
      const d = out.duration || 2;
      const times = [...new Set([Math.min(1, d / 2), d * 0.25, d * 0.5, 0].map((t) => Math.max(0, Math.min(t, d - 0.05))))];
      let best = null, bestLum = -1;
      for (const t of times) {
        if (finished) return;
        if (!(await seekTo(t)) || !v.videoWidth) continue;
        const lum = brightness(v);
        if (lum > bestLum) {
          try {
            const [w, h] = fit(v.videoWidth, v.videoHeight);
            const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
            canvas.getContext('2d').drawImage(v, 0, 0, w, h);
            const blob = await toBlob(canvas);
            if (blob) { best = blob; bestLum = lum; }
          } catch { /* try the next moment */ }
        }
        if (bestLum > 24) break; // a real picture, stop here
      }
      out.blob = best; done();
    });
    v.src = url;
  });
}

// Never throws. blob is null when the browser cannot decode the file (for example HEIC on most Android browsers).
export async function makeThumbnail(file, kind) {
  try {
    const r = await Promise.race([kind === 'video' ? videoThumb(file) : imageThumb(file), timeout(20000)]);
    return { blob: r.blob || null, width: r.width || null, height: r.height || null, duration: r.duration ?? null };
  } catch {
    return { blob: null, width: null, height: null, duration: null };
  }
}
