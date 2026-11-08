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

function videoThumb(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'metadata';
    const out = { blob: null, width: null, height: null, duration: null };
    const done = () => { URL.revokeObjectURL(url); v.removeAttribute('src'); v.load(); resolve(out); };
    const timer = setTimeout(done, 12000);
    v.onerror = () => { clearTimeout(timer); done(); };
    v.onloadedmetadata = () => {
      out.width = v.videoWidth || null; out.height = v.videoHeight || null;
      out.duration = Number.isFinite(v.duration) ? v.duration : null;
      v.currentTime = Math.min(1, (v.duration || 2) / 2);
    };
    v.onseeked = async () => {
      try {
        if (v.videoWidth) {
          const [w, h] = fit(v.videoWidth, v.videoHeight);
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          canvas.getContext('2d').drawImage(v, 0, 0, w, h);
          out.blob = await toBlob(canvas);
        }
      } catch { /* leave blob null */ }
      clearTimeout(timer); done();
    };
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
