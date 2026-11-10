// js/util.js  -  DOM helper, formatting, Nairobi-time helpers
import { CONFIG } from './config.js';

const TZ = CONFIG.TIMEZONE;
const EAT_OFFSET = '+03:00'; // Africa/Nairobi has no daylight saving

function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k === null || k === undefined || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}

// h('div', { class: 'x', onclick: fn }, child, 'text')  -  never uses innerHTML, so user content is always escaped
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) { kids.unshift(attrs); attrs = null; }
  let value;
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'value') value = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  append(el, kids);
  if (value !== undefined) el.value = value;
  return el;
}

export const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
export const mount = (el, ...kids) => { clear(el); append(el, kids); return el; };

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${i === 0 || n >= 100 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
}

export function formatDuration(s) {
  s = Math.max(0, Math.round(s));
  const m = Math.floor(s / 60), sec = s % 60;
  if (m >= 60) return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

export const formatEventDate = (d) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
    .format(new Date(`${d}T00:00:00Z`));

export const formatDateTime = (iso) =>
  `${new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(iso))} EAT`;

function nairobiParts(date) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const o = {};
  for (const p of parts) o[p.type] = p.value;
  return o;
}
export const todayNairobi = () => { const p = nairobiParts(new Date()); return `${p.year}-${p.month}-${p.day}`; };
export const toInputValue = (iso) => { const p = nairobiParts(new Date(iso)); return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`; };
export const nowInputValue = () => toInputValue(new Date().toISOString());
export const fromInputValue = (v) => new Date(`${v}:00${EAT_OFFSET}`).toISOString();

export function timeLeft(iso) {
  const ms = Date.parse(iso) - Date.now();
  if (ms <= 0) return 'any moment now';
  const d = Math.floor(ms / 86400000), hr = Math.floor((ms % 86400000) / 3600000), mi = Math.floor((ms % 3600000) / 60000);
  if (d > 0) return `${d} day${d === 1 ? '' : 's'} ${hr} hour${hr === 1 ? '' : 's'}`;
  if (hr > 0) return `${hr} hour${hr === 1 ? '' : 's'} ${mi} min`;
  return mi > 0 ? `${mi} min` : 'less than a minute';
}

export const debounce = (fn, ms = 300) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back */ }
  const ta = h('textarea', { class: 'offscreen', 'aria-hidden': 'true' }); ta.value = text;
  document.body.append(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

export const STATE_LABEL = { published: 'Published', unpublished: 'Unpublished', scheduled: 'Scheduled', pending_deletion: 'Pending deletion', suspended: 'Suspended' };
