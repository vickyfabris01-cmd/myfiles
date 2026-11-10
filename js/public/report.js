// js/public/report.js  -  the visitor's "Report" dialog.
// The visitor reports the whole event, the folder they are in, or one photo or video (optional).
// Naming a file lets the owner open that one file to review the report; the dialog says so plainly.
import { pub } from './api.js';
import { h } from '../util.js';
import { icon } from '../icons.js';
import { openModal, toast, showError, withBusy } from '../ui.js';

const MAX = 1000;

export function openReport({ token, folderId = null, folderName = null, files = [], file = null }) {
  const choices = [{ value: 'event', label: 'The whole event' }];
  if (folderId) choices.push({ value: 'folder', label: `This folder${folderName ? `: ${folderName}` : ''}` });
  if (file || files.length) choices.push({ value: 'file', label: file ? `This file: ${file.filename}` : 'One photo or video' });

  let scope = file ? 'file' : folderId ? 'folder' : 'event';
  let picked = file || null;

  const pickerHost = h('div', { class: 'rp-picker', hidden: true });
  const pickedNote = h('p', { class: 'hint rp-picked', hidden: true });

  function renderPicker() {
    pickerHost.hidden = scope !== 'file' || !!file;     // when opened from the viewer the file is already chosen
    pickedNote.hidden = scope !== 'file';
    pickedNote.textContent = picked ? `Selected: ${picked.filename}` : 'Tap a picture below to choose it.';
    pickerHost.replaceChildren(...files.slice(0, 60).map((f) => {
      const on = picked && picked.id === f.id;
      return h('button', { class: `rp-thumb${on ? ' on' : ''}`, type: 'button', 'aria-label': f.filename, 'aria-pressed': on ? 'true' : 'false', onclick: () => { picked = f; renderPicker(); } },
        f.thumbnail_url ? h('img', { src: f.thumbnail_url, alt: '', loading: 'lazy' }) : h('span', { class: 'rp-ph' }, icon(f.media_type === 'video' ? 'video' : 'image', 22)));
    }));
  }

  const radios = choices.map((c) => h('label', { class: 'rp-opt' },
    h('input', { type: 'radio', name: 'rp-scope', value: c.value, checked: c.value === scope, onchange: () => { scope = c.value; renderPicker(); } }),
    h('span', null, c.label)));
  const reason = h('textarea', { class: 'input', rows: 4, maxlength: MAX, placeholder: 'What is the problem?', 'aria-label': 'What is the problem?' });
  const send = h('button', { class: 'btn primary', type: 'submit' }, 'Send report');

  const form = h('form', { class: 'form', novalidate: true },
    h('p', { class: 'muted' }, 'Tell us what is wrong, for example illegal, abusive or private content shared without permission.'),
    choices.length > 1 ? h('fieldset', { class: 'rp-scope' }, h('legend', { class: 'label' }, 'What are you reporting?'), radios) : null,
    pickedNote, pickerHost,
    h('label', { class: 'field' }, h('span', { class: 'label' }, 'What is the problem?'), reason),
    h('p', { class: 'hint' }, 'If you point to a photo or video, the service owner may open that one file to check your report. This is optional. Without it, the owner reviews your message only. See the ', h('a', { href: '/privacy.html' }, 'Privacy notice'), '.'),
    h('div', { class: 'modal-foot inline' }, h('button', { class: 'btn secondary', type: 'button', onclick: () => m.close() }, 'Cancel'), send));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = reason.value.trim();
    if (!text) { reason.focus(); reason.classList.add('invalid'); toast('Please describe the problem', 'error'); return; }
    if (scope === 'file' && !picked) { toast('Choose the photo or video, or pick another option', 'error'); return; }
    const body = { reason: text };
    if (scope === 'file' && picked) body.file_id = picked.id;
    if (scope === 'folder' && folderId) body.folder_id = folderId;
    try {
      await withBusy(send, () => pub('POST', `/event/${encodeURIComponent(token)}/report`, body));
      toast('Thank you. The owner has been notified.', 'success');
      m.close(true);
    } catch (err) { showError(err); }
  });

  const m = openModal({ title: 'Report', body: form, className: 'small' });
  renderPicker();
  setTimeout(() => reason.focus(), 30);
  return m.closed;
}
