// cloudflare/worker/names.js
// The name a guest gets when they download a file:  <Event>_<Folder>_<YYYY-MM-DD-HH-MM-SS>.<ext>
//   * Event: the event title. Folder: the folder the file is in (left out for files not in a folder).
//   * The time is when the photo/video was TAKEN (upload time when that is unknown), in Nairobi time.
//   * Spaces become "-", characters that file systems refuse are dropped, each part is cut to 40 characters.
//   * A file the host renamed by hand (name_is_custom) keeps the name the host typed.
// The stored name (original_filename) is never changed by this; the convention is applied when the download is prepared,
// so renaming an event or folder, or moving a file, is reflected in the next download.
const TZ = 'Africa/Nairobi';
const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const MIME_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'heic', 'image/heif': 'heif', 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm' };

export function stamp(iso) {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return null;
  const o = {};
  for (const p of fmt.formatToParts(d)) o[p.type] = p.value;
  return `${o.year}-${o.month}-${o.day}-${o.hour}-${o.minute}-${o.second}`;
}

const part = (s) => String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '').replace(/\s+/g, '-').replace(/[-_]{2,}/g, '-').replace(/^[-_.]+|[-_.]+$/g, '').slice(0, 40).replace(/[-_.]+$/, '');

const extOf = (name, mime) => {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name || '');
  return m ? m[1].toLowerCase() : (MIME_EXT[mime] || '');
};

// file: { original_filename, mime_type, taken_at, created_at, name_is_custom }
export function downloadName({ event, folder, file }) {
  if ((file.name_is_custom || file.name_applied) && file.original_filename) return file.original_filename;   // already stored (by the host, or by the convention)
  const when = stamp(file.taken_at || file.created_at);
  const base = [part(event) || 'event', folder ? part(folder) : null, when].filter(Boolean).join('_');
  const ext = extOf(file.original_filename, file.mime_type);
  return ext ? `${base}.${ext}` : base;
}

// "X.jpg" -> "X-2.jpg" for the 2nd file that would get the same name in the same folder
export function withSuffix(name, n) {
  if (n < 2) return name;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)}-${n}${name.slice(dot)}` : `${name}-${n}`;
}
