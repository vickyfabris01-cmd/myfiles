// js/ui.js  -  toasts, dialogs, sheets, busy buttons
import { h } from './util.js';
import { icon } from './icons.js';

let toastHost = null;
export function toast(message, type = 'info', ms = 4000) {
  if (!toastHost) {
    toastHost = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastHost);
  }
  const t = h('div', { class: `toast ${type}` }, icon(type === 'error' ? 'alert' : type === 'success' ? 'check' : 'info', 18), h('span', null, message));
  toastHost.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 250); }, ms);
}

export function showError(err, fallback = 'Something went wrong') {
  console.error(err);
  toast((err && err.message) || fallback, 'error', 6000);
}

// Low-level modal built on <dialog>. Returns { el, close(value), closed: Promise }.
export function openModal({ title, body, footer, className = '' }) {
  const dlg = h('dialog', { class: `modal ${className}`, 'aria-label': title });
  let closed = false;
  const waiters = [];
  function close(value) {
    if (closed) return;
    closed = true;
    try { if (typeof dlg.close === 'function') dlg.close(); } catch { /* ignore */ }
    dlg.remove();
    waiters.forEach((f) => f(value));
  }
  dlg.append(
    h('div', { class: 'modal-head' }, h('h2', null, title), h('button', { class: 'btn icon ghost', type: 'button', 'aria-label': 'Close', onclick: () => close() }, icon('x'))),
    h('div', { class: 'modal-body' }, body),
    footer ? h('div', { class: 'modal-foot' }, footer) : null,
  );
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); });
  document.body.append(dlg);
  if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
  return { el: dlg, close, closed: new Promise((r) => waiters.push(r)) };
}

export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const ok = h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, type: 'button', onclick: () => m.close(true) }, confirmLabel);
    const no = h('button', { class: 'btn secondary', type: 'button', onclick: () => m.close(false) }, 'Cancel');
    const m = openModal({ title, body: typeof message === 'string' ? h('p', null, message) : message, footer: [no, ok], className: 'small' });
    m.closed.then((v) => resolve(v === true));
  });
}

// fields: [{ name, label, type, value, required, placeholder, maxLength, rows, options:[{value,label}], hint }]
export function formDialog({ title, fields, submitLabel = 'Save', intro }) {
  return new Promise((resolve) => {
    const controls = {};
    const rows = fields.map((f) => {
      let c;
      if (f.type === 'textarea') c = h('textarea', { class: 'input', name: f.name, rows: f.rows || 3, maxlength: f.maxLength, placeholder: f.placeholder, required: !!f.required, value: f.value ?? '' });
      else if (f.type === 'select') c = h('select', { class: 'input', name: f.name, value: f.value }, f.options.map((o) => h('option', { value: o.value }, o.label)));
      else c = h('input', { class: 'input', name: f.name, type: f.type || 'text', maxlength: f.maxLength, placeholder: f.placeholder, required: !!f.required, min: f.min, value: f.value ?? '', autocomplete: 'off' });
      controls[f.name] = c;
      return h('label', { class: 'field' }, h('span', { class: 'label' }, f.label), c, f.hint ? h('span', { class: 'hint' }, f.hint) : null);
    });
    const form = h('form', { class: 'form', novalidate: true },
      intro ? h('p', { class: 'muted' }, intro) : null, rows,
      h('div', { class: 'modal-foot inline' },
        h('button', { class: 'btn secondary', type: 'button', onclick: () => m.close(null) }, 'Cancel'),
        h('button', { class: 'btn primary', type: 'submit' }, submitLabel)),
    );
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      for (const f of fields) {
        const c = controls[f.name];
        if (f.required && !String(c.value).trim()) { c.focus(); c.classList.add('invalid'); toast(`${f.label} is required`, 'error'); return; }
      }
      const out = {};
      for (const f of fields) out[f.name] = controls[f.name].value.trim();
      m.close(out);
    });
    const m = openModal({ title, body: form, className: 'small' });
    m.closed.then((v) => resolve(v || null));
    setTimeout(() => { const first = form.querySelector('input,textarea,select'); if (first) first.focus(); }, 30);
  });
}

// Bottom sheet on phones, small dialog on desktop. items: [{ label, icon, danger, onClick, hint }]
export function actionSheet(title, items) {
  const list = h('div', { class: 'sheet-list' }, items.filter(Boolean).map((it) =>
    h('button', {
      class: `sheet-item${it.danger ? ' danger' : ''}`, type: 'button',
      onclick: () => { m.close(); setTimeout(() => it.onClick && it.onClick(), 0); },
    }, it.icon ? icon(it.icon, 20) : null, h('span', null, h('b', null, it.label), it.hint ? h('small', null, it.hint) : null))));
  const m = openModal({ title, body: list, className: 'sheet' });
  return m;
}

export async function withBusy(btn, fn) {
  if (btn) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); }
  try { return await fn(); } finally { if (btn) { btn.disabled = false; btn.removeAttribute('aria-busy'); } }
}

export const loading = (text = 'Loading') => h('div', { class: 'loading' }, h('span', { class: 'spinner' }), h('span', null, text));

export const emptyState = (iconName, title, text, ...actions) =>
  h('div', { class: 'empty' }, h('div', { class: 'empty-ic' }, icon(iconName, 28)), h('h3', null, title), text ? h('p', { class: 'muted' }, text) : null, actions.length ? h('div', { class: 'row center' }, actions) : null);
