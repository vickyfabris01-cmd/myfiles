// cloudflare/worker/index.js
// Entry point: CORS, rate limiting, routing, auth, uniform {success, data, error} responses, cron.
import { ApiError, Created, corsHeaders, rateLimit } from './utils.js';
import { RATE } from './config.js';
import { makeDb } from './db.js';
import { requireUser } from './auth.js';
import * as pub from './public.js';
import * as dl from './downloads.js';
import * as og from './og.js';
import * as ev from './events.js';
import * as fo from './folders.js';
import * as fi from './files.js';
import * as up from './uploads.js';
import * as bin from './bin.js';
import * as usage from './usage.js';
import * as rep from './reports.js';
import * as sup from './super.js';
import { runSchedules } from './schedules.js';
import { purgeExpiredEvents, purgeExpiredBin, cleanupExpiredUploads } from './cleanup.js';

// [method, path, rate group, who may call it, handler]
// who: false = anyone (public) | 'any' = any signed-in confirmed account | 'host' = an ACTIVE host | 'super' = the ACTIVE super admin
// Every 'host' handler checks that the event / folder / file / upload belongs to the caller (see owner.js).
const ROUTES = [
  ['GET', '/health', 'public', false, () => ({ status: 'ok' })],

  // public
  ['POST', '/event/validate', 'validate', false, pub.validate],
  ['GET', '/event/:token/folders', 'public', false, pub.folders],
  ['GET', '/event/:token/files', 'public', false, pub.files],
  ['GET', '/event/:token/manifest', 'public', false, dl.manifest],
  ['POST', '/event/:token/download', 'download', false, dl.urls],
  ['GET', '/event/:token/preview', 'public', false, og.preview],   // title/description/image for link previews
  ['GET', '/event/:token/og.jpg', 'public', false, og.image],      // the preview collage (raw image)
  ['POST', '/event/:token/report', 'report', false, rep.submit],   // public "Report" link

  // admin: session
  ['GET', '/admin/me', 'admin', 'any', ({ admin }) => ({ admin })],   // also works for pending and suspended accounts, so they can see their status

  // admin: events
  ['GET', '/admin/events', 'admin', 'host', ev.list],
  ['POST', '/admin/events', 'admin', 'host', ev.create],
  ['GET', '/admin/events/:id', 'admin', 'host', ev.get],
  ['PATCH', '/admin/events/:id', 'admin', 'host', ev.update],
  ['DELETE', '/admin/events/:id', 'admin', 'host', ev.remove],
  ['POST', '/admin/events/:id/restore', 'admin', 'host', ev.restore],
  ['POST', '/admin/events/:id/publish', 'admin', 'host', ev.publish],
  ['POST', '/admin/events/:id/schedule', 'admin', 'host', ev.schedule],
  ['GET', '/admin/events/:id/share-link', 'admin', 'host', ev.shareLink],
  ['POST', '/admin/events/:id/share-link/regenerate', 'admin', 'host', ev.regenerateShareLink],
  ['GET', '/admin/events/:id/contents', 'admin', 'host', fo.contents],

  // admin: folders
  ['POST', '/admin/folders', 'admin', 'host', fo.create],
  ['PATCH', '/admin/folders/:id', 'admin', 'host', fo.update],
  ['DELETE', '/admin/folders/:id', 'admin', 'host', fo.remove],

  // admin: files
  ['POST', '/admin/files/bulk', 'admin', 'host', fi.bulk],
  ['PATCH', '/admin/files/:id', 'admin', 'host', fi.update],
  ['DELETE', '/admin/files/:id', 'admin', 'host', fi.remove],
  ['GET', '/admin/files/:id/source', 'admin', 'host', fi.sourceUrl],
  ['POST', '/admin/files/:id/thumbnail', 'admin', 'host', fi.thumbnailUrl],
  ['POST', '/admin/files/:id/thumbnail/confirm', 'admin', 'host', fi.thumbnailConfirm],

  // admin: uploads
  ['POST', '/admin/upload/authorize', 'admin', 'host', up.authorize],
  ['POST', '/admin/upload/parts', 'admin', 'host', up.parts],
  ['GET', '/admin/upload/status', 'admin', 'host', up.status],
  ['POST', '/admin/upload/complete', 'admin', 'host', up.complete],
  ['POST', '/admin/upload/abort', 'admin', 'host', up.abort],

  // host: recycle bin, storage, account
  ['GET', '/admin/bin', 'admin', 'host', bin.list],
  ['POST', '/admin/bin/restore', 'admin', 'host', bin.restore],
  ['POST', '/admin/bin/delete', 'admin', 'host', bin.deleteItem],
  ['POST', '/admin/bin/empty', 'admin', 'host', bin.empty],
  ['GET', '/admin/storage', 'admin', 'host', usage.storage],
  ['POST', '/admin/account/delete', 'admin', 'host', usage.deleteAccount],

  // super admin (counts and sizes only, never event content)
  ['GET', '/super/overview', 'admin', 'super', sup.overview],
  ['GET', '/super/hosts', 'admin', 'super', sup.hosts],
  ['PATCH', '/super/settings', 'admin', 'super', sup.updateSettings],
  ['POST', '/super/hosts/:id/approve', 'admin', 'super', sup.hostAction('approve')],
  ['POST', '/super/hosts/:id/suspend', 'admin', 'super', sup.hostAction('suspend')],
  ['POST', '/super/hosts/:id/restore', 'admin', 'super', sup.hostAction('restore')],
  ['POST', '/super/hosts/:id/storage', 'admin', 'super', sup.addStorage],
  ['GET', '/super/reports', 'admin', 'super', sup.reports],
  ['POST', '/super/reports/:id/dismiss', 'admin', 'super', sup.dismissReport],
  ['POST', '/super/reports/:id/suspend-event', 'admin', 'super', sup.suspendEvent],
  ['POST', '/super/reports/:id/unsuspend-event', 'admin', 'super', sup.unsuspendEvent],
  ['POST', '/super/reports/:id/suspend-host', 'admin', 'super', sup.suspendHostFromReport],
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
    console.log('bin purge', JSON.stringify(await purgeExpiredBin(env, db)));
  } catch (e) { console.error('bin purge failed', e && e.message); }
  try {
    console.log('expired uploads', await cleanupExpiredUploads(env, db));
  } catch (e) { console.error('upload cleanup failed', e && e.message); }
}

export default {
  async fetch(request, env, execCtx) {
    const cors = corsHeaders(env, request.headers.get('Origin'));
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      const url = new URL(request.url);
      const route = match(request.method, url.pathname);
      if (!route) throw new ApiError(404, 'NOT_FOUND', 'Route not found');
      rateLimit(request, route.group, RATE[route.group]);
      const db = makeDb(env);
      const ctx = { request, env, db, url, params: route.params, waitUntil: execCtx && execCtx.waitUntil ? (p) => execCtx.waitUntil(p) : null };
      if (route.admin) { ctx.admin = await requireUser(request, env, db, route.admin); ctx.user = ctx.admin; }
      const out = await route.handler(ctx);
      if (out instanceof Response) return out; // raw responses (images)
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
