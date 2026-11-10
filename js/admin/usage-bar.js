// js/admin/usage-bar.js  -  the storage bar used on the events page and the storage page.
import { h, formatBytes } from '../util.js';

// s = response of GET /admin/storage
export function usageBar(s) {
  const q = s.quota_bytes || 1;
  const parts = [
    ['photos', 'Photos', s.photos_bytes],
    ['videos', 'Videos', s.videos_bytes],
    ['bin', 'Recycle bin', s.bin_bytes],
    ['pending', 'Uploading', s.pending_bytes],
  ];
  const pct = Math.min(100, (s.used_bytes / q) * 100);
  return h('div', { class: 'usage' },
    h('div', { class: 'usage-bar', role: 'img', 'aria-label': `${formatBytes(s.used_bytes)} of ${formatBytes(q)} used (${pct.toFixed(0)} percent)` },
      parts.map(([cls, label, n]) => (n > 0 ? h('span', { class: `usage-seg ${cls}`, style: `width:${Math.min(100, (n / q) * 100)}%`, title: `${label}: ${formatBytes(n)}` }) : null))),
    h('div', { class: 'usage-legend' },
      parts.map(([cls, label, n]) => h('span', { class: 'usage-key' }, h('i', { class: `usage-dot ${cls}` }), `${label} ${formatBytes(n)}`)),
      h('span', { class: 'usage-key' }, h('i', { class: 'usage-dot free' }), `Free ${formatBytes(s.free_bytes)}`)));
}
