// js/admin/taken.js  -  reads "date taken" in the browser, only from the first bytes of the file. The file is never changed.
//   photos : EXIF DateTimeOriginal (JPEG, HEIC, WebP; others simply have no date)
//   videos : the creation time inside the MP4 / MOV header
// Returns an ISO string, or null when the file has no date (for example photos forwarded on WhatsApp). The server then sorts
// those files by upload time. Nothing here ever throws.
const DEFAULT_OFFSET = '+03:00'; // EXIF times have no time zone; when the photo does not say, assume East Africa Time

const u16 = (d, o, le) => d.getUint16(o, le);
const u32 = (d, o, le) => d.getUint32(o, le);

// "2024:05:01 10:20:30" (+ optional "+03:00") -> ISO
function exifToIso(text, offset) {
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(text || '');
  if (!m || m[1] === '0000') return null;
  const off = /^[+-]\d{2}:\d{2}$/.test(offset || '') ? offset : DEFAULT_OFFSET;
  const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${off}`);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

const ascii = (d, o, n) => { let s = ''; for (let i = 0; i < n && o + i < d.byteLength; i++) { const c = d.getUint8(o + i); if (c === 0) break; s += String.fromCharCode(c); } return s; };

// Parses a TIFF block (the EXIF payload). `base` is where the TIFF header starts inside `d`.
export function parseTiff(d, base) {
  try {
    const bom = u16(d, base, false);
    const le = bom === 0x4949;
    if (!le && bom !== 0x4d4d) return null;
    if (u16(d, base + 2, le) !== 42) return null;
    const readIfd = (off) => {
      const out = {};
      const pos = base + off;
      const n = u16(d, pos, le);
      for (let i = 0; i < n && i < 400; i++) {
        const e = pos + 2 + i * 12;
        if (e + 12 > d.byteLength) break;
        const tag = u16(d, e, le), type = u16(d, e + 2, le), count = u32(d, e + 4, le);
        if (type === 2) { const voff = count > 4 ? base + u32(d, e + 8, le) : e + 8; out[tag] = ascii(d, voff, count); }
        else if (type === 4 && count === 1) out[tag] = u32(d, e + 8, le);
      }
      return out;
    };
    const ifd0 = readIfd(u32(d, base + 4, le));
    const sub = ifd0[0x8769] ? readIfd(ifd0[0x8769]) : {};
    const text = sub[0x9003] || sub[0x9004] || ifd0[0x0132];
    return exifToIso(text, sub[0x9011]);
  } catch { return null; }
}

// JPEG: walk the segments to the Exif APP1. Anything else (HEIC, WebP, ...): look for a TIFF header in the first bytes.
export function exifDateFromBytes(buf) {
  const d = new DataView(buf);
  if (d.byteLength > 4 && d.getUint16(0) === 0xffd8) {
    let o = 2;
    while (o + 4 < d.byteLength) {
      if (d.getUint8(o) !== 0xff) break;
      const marker = d.getUint8(o + 1), len = d.getUint16(o + 2);
      if (marker === 0xe1 && ascii(d, o + 4, 4) === 'Exif') return parseTiff(d, o + 10);
      if (marker === 0xda) break; // image data starts: no EXIF
      o += 2 + len;
    }
    return null;
  }
  for (let o = 0; o + 8 < d.byteLength; o++) {
    const a = d.getUint16(o);
    if ((a === 0x4949 && d.getUint16(o + 2, true) === 42) || (a === 0x4d4d && d.getUint16(o + 2, false) === 42)) {
      const r = parseTiff(d, o);
      if (r) return r;
    }
  }
  return null;
}

const MAC_EPOCH_OFFSET = 2082844800; // seconds between 1904-01-01 and 1970-01-01

// MP4 / MOV: find moov > mvhd and read its creation time (UTC).
export async function mp4DateFromFile(file) {
  const read = async (o, n) => new DataView(await file.slice(o, Math.min(file.size, o + n)).arrayBuffer());
  let o = 0;
  for (let hops = 0; hops < 64 && o + 16 <= file.size; hops++) {
    const d = await read(o, 16);
    let size = d.getUint32(0);
    const type = ascii(d, 4, 4);
    let header = 8;
    if (size === 1) { size = Number(d.getBigUint64(8)); header = 16; }
    if (size === 0) size = file.size - o;
    if (size < header) return null;
    if (type === 'moov') {
      const m = await read(o + header, 120);
      for (let p = 0; p + 16 < m.byteLength;) {
        const csize = m.getUint32(p), ctype = ascii(m, p + 4, 4);
        if (csize < 8) break;
        if (ctype === 'mvhd') {
          const version = m.getUint8(p + 8);
          const secs = version === 1 ? Number(m.getBigUint64(p + 12)) : m.getUint32(p + 12);
          if (!secs) return null;
          const t = (secs - MAC_EPOCH_OFFSET) * 1000;
          return Number.isFinite(t) && t > Date.UTC(1990, 0, 1) && t < Date.now() + 2 * 86400000 ? new Date(t).toISOString() : null;
        }
        p += csize;
      }
      return null;
    }
    o += size;
  }
  return null;
}

export async function readTakenAt(file, kind) {
  try {
    if (kind === 'video') return await mp4DateFromFile(file);
    const iso = exifDateFromBytes(await file.slice(0, 262144).arrayBuffer());
    return iso && Date.parse(iso) > Date.UTC(1990, 0, 1) && Date.parse(iso) < Date.now() + 2 * 86400000 ? iso : null;
  } catch { return null; }
}
