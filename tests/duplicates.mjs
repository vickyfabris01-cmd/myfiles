// tests/duplicates.mjs  -  the browser side of the duplicate warning (hashing, same-selection duplicates, request shape):  node tests/duplicates.mjs
import { findDuplicates } from '../js/admin/uploads.js';
let pass = 0, fail = 0;
const check = (n, c) => { c ? pass++ : (fail++, console.log('FAIL', n)); if (c) console.log('PASS', n); };
const jpg = (name, bytes) => new File([new Uint8Array(bytes)], name, { type: 'image/jpeg' });
const mp4 = (name, n) => new File([new Uint8Array(n).fill(1)], name, { type: 'video/mp4' });
const sha = async (f) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', await f.arrayBuffer()))].map((b) => b.toString(16).padStart(2, '0')).join('');

const a = jpg('a.jpg', [1, 2, 3]), b = jpg('b.jpg', [9, 9, 9, 9]), c = mp4('c.mp4', 70000);
let seen = null;
const call = async (_m, _p, body) => { seen = body; return { results: body.files.map((f, i) => ({ index: i, duplicate: f.name === 'a.jpg' ? 'same_name_size' : null, existing_filename: 'a.jpg' })) }; };
const r = await findDuplicates([a, b, c], { eventId: 'E', folderId: 'F', call });
check('request is scoped to the folder', seen.event_id === 'E' && seen.folder_id === 'F');
check('request has no folder_id when uploading to the top level', (await (async () => { let s; await findDuplicates([a], { eventId: 'E', folderId: null, call: async (_m, _p, bd) => { s = bd; return { results: [] }; } }); return !('folder_id' in s); })()));
check('photos are hashed (SHA-256), videos are not', seen.files[0].hash === await sha(a) && seen.files[1].hash === await sha(b) && seen.files[2].hash === undefined);
check('server-reported duplicate is returned with its reason', r.duplicates.length === 1 && r.duplicates[0].file === a && r.duplicates[0].reason === 'same_name_size');
check('hashes are handed back so they can be stored with the upload', r.hashes.get(b) === await sha(b) && !r.hashes.has(c));
const twin = jpg('copy.jpg', [1, 2, 3]);
const r2 = await findDuplicates([a, twin, jpg('a.jpg', [5])], { eventId: 'E', folderId: null, call: async (_m, _p, bd) => ({ results: bd.files.map((f, i) => ({ index: i, duplicate: null })) }) });
check('same photo selected twice (even with another name) is flagged inside the selection', r2.duplicates.some((d) => d.file === twin && d.reason === 'in_selection'));
const r3 = await findDuplicates([a, b], { eventId: 'E', folderId: null, call: async () => { throw new Error('offline'); } });
check('if the check cannot run, nothing is blocked', r3.duplicates.length === 0 && r3.hashes.size === 2);
const r4 = await findDuplicates([new File([], 'empty.jpg', { type: 'image/jpeg' }), new File([new Uint8Array(5)], 'x.txt', { type: 'text/plain' })], { eventId: 'E', folderId: null, call: async () => ({ results: [] }) });
check('empty and non-media files are ignored by the check', r4.duplicates.length === 0);
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
