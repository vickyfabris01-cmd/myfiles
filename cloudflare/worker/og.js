// cloudflare/worker/og.js
// Link previews (WhatsApp, Telegram, Slack, iMessage...). Crawlers do not run JavaScript, so the
// Pages function (functions/e/[[path]].js) asks this module for the title/description/image and
// writes them into the page's <meta> tags.
//
// Preview image = one 1200x630 collage: the event cover (large, left) + the two most recent
// photos stacked on the right. A video contributes its thumbnail. The collage is built with the
// Cloudflare Images binding and cached in R2 (events/<id>/og.jpg), rebuilt only when the
// selection changes.
import { loadEvent } from './public.js';
import { hashToken } from './tokens.js';
import { OBJECT_KEYS } from './config.js';

export const OG_W = 1200;
export const OG_H = 630;
const GAP = 6;
const BIG_MAX_BYTES = 12 * 1024 * 1024;   // same cap the public hero uses for full-quality covers
const SMALL_MAX_BYTES = 4 * 1024 * 1024;  // tiles are tiny, so only use an original when there is no thumbnail
const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']); // what the Images binding can read
const clamp = (n) => (Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 50);

// Which R2 object to read for a file. role 'big' = the cover slot, 'small' = a right-hand tile.
export function sourceKey(f, role) {
  const photoOk = f.media_type === 'photo' && f.object_key && IMAGE_MIMES.has(f.mime_type);
  if (role === 'big' && photoOk && f.size_bytes <= BIG_MAX_BYTES) return f.object_key; // sharp original
  if (f.thumbnail_key) return f.thumbnail_key;                                           // photo or video thumbnail
  if (photoOk && f.size_bytes <= SMALL_MAX_BYTES) return f.object_key;
  return null; // e.g. a video without a thumbnail, or a HEIC without one: nothing a crawler can show
}

// cover first, then the most recent others. Returns at most 3 usable files, each with its R2 key.
export function pickFiles(coverRow, recentRows) {
  const out = [];
  const seen = new Set();
  const add = (f, role) => {
    if (!f || seen.has(f.id)) return;
    const key = sourceKey(f, role);
    if (!key) return;
    seen.add(f.id);
    out.push({ id: f.id, key, thumb: f.thumbnail_key || null });
  };
  add(coverRow, 'big');
  // if the cover is unusable the newest usable file takes the big slot instead
  for (const f of recentRows) {
    if (out.length >= 3) break;
    add(f, out.length === 0 ? 'big' : 'small');
  }
  return out;
}

// [{left, top, width, height}] per picked file: big cover 796px + 6px gap + 398px column = 1200
export function layoutFor(n) {
  const rightLeft = OG_W - Math.round((OG_W - GAP) / 3);          // 802
  const bigW = rightLeft - GAP;                                    // 796
  const rightW = OG_W - rightLeft;                                 // 398
  if (n <= 1) return [{ left: 0, top: 0, width: OG_W, height: OG_H }];
  if (n === 2) return [
    { left: 0, top: 0, width: bigW, height: OG_H },
    { left: rightLeft, top: 0, width: rightW, height: OG_H },
  ];
  const h = Math.floor((OG_H - GAP) / 2);                          // 312
  return [
    { left: 0, top: 0, width: bigW, height: OG_H },
    { left: rightLeft, top: 0, width: rightW, height: h },
    { left: rightLeft, top: OG_H - h, width: rightW, height: h },
  ];
}

async function select(db, e) {
  const coverId = await db.rpc('event_cover_file', { p_event: e.id });
  const cols = 'id,media_type,mime_type,size_bytes,object_key,thumbnail_key,created_at';
  const recent = await db.select('media_files', {
    select: cols, event_id: `eq.${e.id}`, status: 'eq.ready', order: 'created_at.desc,id.desc', limit: 12,
  });
  let cover = coverId ? recent.find((r) => r.id === coverId) : null;
  if (coverId && !cover) {
    [cover] = await db.select('media_files', { select: cols, id: `eq.${coverId}`, limit: 1 });
  }
  const files = pickFiles(cover, recent);
  const manual = e.cover_mode === 'manual' && cover && files[0] && files[0].id === cover.id;
  const pos = manual ? { x: clamp(e.cover_pos_x), y: clamp(e.cover_pos_y) } : null;
  // fingerprint: changes whenever the collage would look different (also used to bust crawler caches)
  const fp = (await hashToken(['v1', ...files.map((f) => `${f.id}:${f.key}`), pos ? `${pos.x},${pos.y}` : '-'].join('|'))).slice(0, 16);
  return { files, pos, fp };
}

function describe(e) {
  const bits = [];
  if (e.event_date) {
    const d = new Date(`${e.event_date}T00:00:00Z`);
    if (!Number.isNaN(d.getTime())) bits.push(d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }));
  }
  if (e.location) bits.push(e.location);
  const head = bits.join(' \u00b7 ');
  const body = (e.description || '').replace(/\s+/g, ' ').trim();
  const text = [head, body].filter(Boolean).join(' \u2014 ');
  return text.length > 200 ? `${text.slice(0, 197).trimEnd()}...` : text;
}

// GET /event/:token/preview  ->  { title, description, image: {url, width, height} | null }
export async function preview({ env, db, params, url }) {
  const e = await loadEvent(db, params.token);
  const { files, fp } = await select(db, e);
  const api = `${url.origin}/event/${encodeURIComponent(params.token)}/og.jpg?v=${fp}`;
  return {
    title: e.title,
    description: describe(e),
    image: files.length
      ? { url: api, width: env.IMAGES ? OG_W : null, height: env.IMAGES ? OG_H : null }
      : null,
  };
}

const imageHeaders = (extra = {}) => ({
  'Content-Type': 'image/jpeg',
  'Cache-Control': 'public, max-age=86400',
  'X-Content-Type-Options': 'nosniff',
  ...extra,
});

async function single(env, key) {
  const obj = await env.BUCKET.get(key);
  if (!obj) return null;
  return new Response(obj.body, {
    headers: imageHeaders({ 'Content-Type': (obj.httpMetadata && obj.httpMetadata.contentType) || 'image/jpeg' }),
  });
}

async function collage(env, files, pos) {
  const slots = layoutFor(files.length);
  const objs = await Promise.all(files.map((f) => env.BUCKET.get(f.key)));
  if (objs.some((o) => !o)) throw new Error('missing object');

  const gravity = pos ? { x: pos.x / 100, y: pos.y / 100 } : 'auto';
  const fit = (stream, s, g = 'auto') => env.IMAGES.input(stream).transform({ width: s.width, height: s.height, fit: 'cover', gravity: g });

  if (files.length === 1) {
    const out = await fit(objs[0].body, slots[0], gravity).output({ format: 'image/jpeg', quality: 82 });
    return out.response();
  }
  // dim, blurred cover as the canvas so the gaps between tiles look intentional (a stream can be read once, so fetch it again)
  const bg = await env.BUCKET.get(files[0].key);
  if (!bg) throw new Error('missing object');
  let chain = env.IMAGES.input(bg.body)
    .transform({ width: OG_W, height: OG_H, fit: 'cover', blur: 60, brightness: 0.5 });
  chain = chain.draw(fit(objs[0].body, slots[0], gravity), { left: slots[0].left, top: slots[0].top });
  for (let i = 1; i < files.length; i++) {
    chain = chain.draw(fit(objs[i].body, slots[i]), { left: slots[i].left, top: slots[i].top });
  }
  const out = await chain.output({ format: 'image/jpeg', quality: 82 });
  return out.response();
}

// GET /event/:token/og.jpg  (raw image, not the JSON envelope)
export async function image({ env, db, params, waitUntil }) {
  const e = await loadEvent(db, params.token);
  const { files, pos, fp } = await select(db, e);
  if (!files.length) return new Response('No image', { status: 404, headers: { 'Cache-Control': 'no-store' } });

  const cacheKey = `${OBJECT_KEYS.prefix(e.id)}og.jpg`;
  if (env.IMAGES) {
    const hit = await env.BUCKET.get(cacheKey);
    if (hit && hit.customMetadata && hit.customMetadata.fp === fp) {
      return new Response(hit.body, { headers: imageHeaders() });
    }
    try {
      const res = await collage(env, files, pos);
      const buf = await res.arrayBuffer();
      const save = env.BUCKET.put(cacheKey, buf, { httpMetadata: { contentType: 'image/jpeg' }, customMetadata: { fp } })
        .catch((err) => console.error('og cache write failed', err && err.message));
      if (waitUntil) waitUntil(save); else await save;
      return new Response(buf, { headers: imageHeaders() });
    } catch (err) {
      console.error('og collage failed, using single image', err && err.message);
    }
  }
  // No Images binding (or it failed): the cover's small thumbnail is still a valid, light preview.
  const fallback = await single(env, files[0].thumb || files[0].key); // prefer the light 480px thumbnail
  if (fallback) return fallback;
  return new Response('No image', { status: 404, headers: { 'Cache-Control': 'no-store' } });
}
