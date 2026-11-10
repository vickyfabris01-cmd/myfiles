// cloudflare/worker/reports.js
// Public "Report" link on every event page. The super admin sees these as in-app notifications (see super.js).
import { ApiError, v, readJson } from './utils.js';
import { LIMITS } from './config.js';
import { hashToken } from './tokens.js';
import { loadEvent } from './public.js';

// POST /event/:token/report  { reason }
export async function submit({ request, db, params }) {
  const e = await loadEvent(db, params.token);
  const b = await readJson(request);
  const reason = v.str(b.reason, 'reason', { min: 3, max: LIMITS.REPORT_MAX_CHARS });
  const since = new Date(Date.now() - 3600 * 1000).toISOString();
  const recent = await db.selectCount('reports', { select: 'id', event_id: `eq.${e.id}`, created_at: `gte.${since}`, limit: 1 });
  if (recent.total >= LIMITS.REPORTS_PER_EVENT_HOUR) throw new ApiError(429, 'RATE_LIMITED', 'Too many reports for this event right now. Thank you, the owner has been notified.', { retry_after: 3600 });
  const reporter = await hashToken(request.headers.get('CF-Connecting-IP') || 'unknown');
  const tenMin = new Date(Date.now() - 600 * 1000).toISOString();
  const dup = await db.select('reports', { select: 'id', event_id: `eq.${e.id}`, reporter_hash: `eq.${reporter}`, created_at: `gte.${tenMin}`, limit: 1 });
  if (!dup.length) await db.insert('reports', { event_id: e.id, reason, reporter_hash: reporter });
  return { reported: true };
}
