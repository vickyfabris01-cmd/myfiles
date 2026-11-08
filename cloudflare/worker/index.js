// cloudflare/worker/index.js
// Entry point: CORS, rate limiting, routing, auth, uniform {success, data, error} responses, cron.
import { ApiError, Created, corsHeaders, rateLimit } from './utils.js';
import { RATE } from './config.js';
import { makeDb } from './db.js';
import { requireAdmin } from './auth.js';
import * as pub from './public.js';
import * as dl from './downloads.js';
import * as ev from './events.js';
import * as fo from './folders.js';
import * as fi from './files.js';
import * as up from './uploads.js';
import { runSchedules } from './schedules.js';
import { purgeExpiredEvents, cleanupExpiredUploads } from './cleanup.js';

// [method, path, rate group, requires admin, handler]
const ROUTES = [
  ['GET', '/health', 'public', false, () => ({ status: 'ok' })],

  // public
  ['POST', '/event/validate', 'validate', false, pub.validate],
  ['GET', '/event/:token/folders', 'public', false, pub.folders],
  ['GET', '/event/:token/files', 'public', false, pub.files],
  ['GET', '/event/:token/manifest', 'public', false, dl.manifest],
  ['POST', '/event/:token/download', 'download', false, dl.urls],

  // admin: session
  ['GET', '/admin/me', 'admin', true, ({ admin }) => ({ admin })],

  // admin: events
  ['GET', '/admin/events', 'admin', true, ev.list],
  ['POST', '/admin/events', 'admin', true, ev.create],
  ['GET', '/admin/events/:id', 'admin', true, ev.get],
  ['PATCH', '/admin/events/:id', 'admin', true, ev.update],
  ['DELETE', '/admin/events/:id', 'admin', true, ev.remove],
  ['POST', '/admin/events/:id/restore', 'admin', true, ev.restore],
  ['POST', '/admin/events/:id/publish', 'admin', true, ev.publish],
  ['POST', '/admin/events/:id/schedule', 'admin', true, ev.schedule],
  ['GET', '/admin/events/:id/share-link', 'admin', true, ev.shareLink],
  ['POST', '/admin/events/:id/share-link/regenerate', 'admin', true, ev.regenerateShareLink],
  ['GET', '/admin/events/:id/contents', 'admin', true, fo.contents],

  // admin: folders
  ['POST', '/admin/folders', 'admin', true, fo.create],
  ['PATCH', '/admin/folders/:id', 'admin', true, fo.update],
  ['DELETE', '/admin/folders/:id', 'admin', true, fo.remove],

  // admin: files
  ['POST', '/admin/files/bulk', 'admin', true, fi.bulk],
  ['PATCH', '/admin/files/:id', 'admin', true, fi.update],
  ['DELETE', '/admin/files/:id', 'admin', true, fi.remove],
  ['POST', '/admin/files/:id/thumbnail', 'admin', true, fi.thumbnailUrl],
  ['POST', '/admin/files/:id/thumbnail/confirm', 'admin', true, fi.thumbnailConfirm],

  // admin: uploads
  ['POST', '/admin/upload/authorize', 'admin', true, up.authorize],
  ['POST', '/admin/upload/parts', 'admin', true, up.parts],
  ['GET', '/admin/upload/status', 'admin', true, up.status],
  ['POST', '/admin/upload/complete', 'admin', true, up.complete],
  ['POST', '/admin/upload/abort', 'admin', true, up.abort],
].map(([method, path, group, admin, handler]) => ({
  method,
  group,
  admin,
  handler,
  re: new RegExp('^' + path.replace(/:([a-z_]+)/g, '(?<$1>[^/]+)') + '/?$'),
}));

function match(method, pathname) {
  for (const r of ROUTES) {
    if (r.method !== method) continue;
    const m = r.re.exec(pathname);
    if (m) return { ...r, params: { ...(m.groups || {}) } };
  }
  return null;
}

function send(body, status, cors, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...cors,
      ...extra,
    },
  });
}

function errorResponse(err, cors) {
  if (err instanceof ApiError) {
    const extra = err.status === 429 && err.details ? { 'Retry-After': String(err.details.retry_after) } : {};
    return send({ success: false, data: null, error: { code: err.code, message: err.message, details: err.details } }, err.status, cors, extra);
  }
  console.error('Unhandled error', err && err.stack ? err.stack : err);
  return send({ success: false, data: null, error: { code: 'INTERNAL_ERROR', message: 'Something went wrong', details: null } }, 500, cors);
}

async function runScheduled(event, env) {
  const db = makeDb(env);
  try {
    console.log('schedules', JSON.stringify(await runSchedules(db)));
  } catch (e) { console.error('schedules failed', e && e.message); }
  if (event.cron === '* * * * *') return; // the minute tick only handles publishing
  try {
    console.log('purge', JSON.stringify(await purgeExpiredEvents(env, db)));
  } catch (e) { console.error('purge failed', e && e.message); }
  try {
    console.log('expired uploads', await cleanupExpiredUploads(env, db));
  } catch (e) { console.error('upload cleanup failed', e && e.message); }
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(env, request.headers.get('Origin'));
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      const url = new URL(request.url);
      const route = match(request.method, url.pathname);
      if (!route) throw new ApiError(404, 'NOT_FOUND', 'Route not found');
      rateLimit(request, route.group, RATE[route.group]);
      const db = makeDb(env);
      const ctx = { request, env, db, url, params: route.params };
      if (route.admin) ctx.admin = await requireAdmin(request, env, db);
      const out = await route.handler(ctx);
      const created = out instanceof Created;
      return send({ success: true, data: created ? out.data : out, error: null }, created ? 201 : 200, cors);
    } catch (err) {
      return errorResponse(err, cors);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduled(event, env));
  },
};
