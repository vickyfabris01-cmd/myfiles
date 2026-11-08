// js/admin/cover-position.js  -  "Position cover" window: drag the photo so only the part you want shows.
// Resolves { x, y } (0-100, the same numbers the public page uses for object-position) or null if cancelled.
import { h } from '../util.js';
import { icon } from '../icons.js';
import { openModal } from '../ui.js';

const clamp = (n) => Math.min(100, Math.max(0, n));

// kind: 'event' (wide banner) or 'folder' (4:3 card)
export function positionCover({ src, kind = 'event', x = 50, y = 50, title = 'Position cover' }) {
  return new Promise((resolve) => {
    const pos = { x: clamp(Number(x) || 50), y: clamp(Number(y) || 50) };
    const wide = kind === 'event';
    const img = h('img', { class: 'cp-img', src, alt: '', draggable: 'false' });
    const frame = h('div', { class: `cp-frame ${wide ? 'wide' : 'card'}`, tabindex: '0', role: 'group', 'aria-label': 'Drag to choose the visible area' }, img,
      h('div', { class: 'cp-hint' }, icon('move', 16), 'Drag the photo'));
    const phoneImg = h('img', { class: 'cp-img', src, alt: '', draggable: 'false' });
    const phone = wide ? h('div', { class: 'cp-phone' }, phoneImg) : null;

    const apply = () => {
      const p = `${pos.x}% ${pos.y}%`;
      img.style.objectPosition = p;
      phoneImg.style.objectPosition = p;
    };
    apply();

    // How far the photo overflows the frame (in px) decides how much one px of dragging moves it.
    const overflow = () => {
      const fw = frame.clientWidth, fh = frame.clientHeight;
      const nw = img.naturalWidth || fw, nh = img.naturalHeight || fh;
      const s = Math.max(fw / nw, fh / nh);
      return { ox: Math.max(0, nw * s - fw), oy: Math.max(0, nh * s - fh) };
    };

    let drag = null;
    frame.addEventListener('pointerdown', (e) => {
      drag = { px: e.clientX, py: e.clientY, x: pos.x, y: pos.y, ...overflow() };
      frame.setPointerCapture(e.pointerId);
      frame.classList.add('dragging');
    });
    frame.addEventListener('pointermove', (e) => {
      if (!drag) return;
      // dragging the photo right shows more of its left side, so the focus point moves the opposite way
      if (drag.ox > 1) pos.x = clamp(drag.x - ((e.clientX - drag.px) / drag.ox) * 100);
      if (drag.oy > 1) pos.y = clamp(drag.y - ((e.clientY - drag.py) / drag.oy) * 100);
      apply();
    });
    const end = () => { drag = null; frame.classList.remove('dragging'); };
    frame.addEventListener('pointerup', end);
    frame.addEventListener('pointercancel', end);
    frame.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 10 : 2;
      const k = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (!k) return;
      e.preventDefault();
      pos.x = clamp(pos.x + k[0]); pos.y = clamp(pos.y + k[1]); apply();
    });

    const m = openModal({
      title,
      className: 'cover-pos',
      body: h('div', { class: 'stack' },
        h('p', { class: 'muted' }, 'Drag the photo until the part you want is showing. Visitors see exactly this area, in full quality.'),
        frame,
        phone ? h('div', { class: 'cp-phone-row' }, phone, h('small', { class: 'muted' }, 'Phone preview. Screens of different shapes show a slightly different crop, the area you chose always stays in view.')) : null),
      footer: [
        h('button', { class: 'btn ghost', type: 'button', onclick: () => { pos.x = 50; pos.y = 50; apply(); } }, 'Centre'),
        h('button', { class: 'btn secondary', type: 'button', onclick: () => m.close(null) }, 'Cancel'),
        h('button', { class: 'btn primary', type: 'button', onclick: () => m.close({ x: Math.round(pos.x * 10) / 10, y: Math.round(pos.y * 10) / 10 }) }, icon('check', 18), 'Save cover'),
      ],
    });
    m.closed.then((val) => resolve(val || null));
  });
}
