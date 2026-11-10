// tests/taken.mjs  -  date taken reader:  node tests/taken.mjs   (uses small fixtures made with PIL, see below)
import { readFileSync, existsSync } from 'node:fs';
import { readTakenAt, exifDateFromBytes } from '../js/admin/taken.js';
let pass = 0, fail = 0;
const check = (n, c) => { c ? pass++ : (fail++, console.log('FAIL', n)); if (c) console.log('PASS', n); };
const fileOf = (p) => new File([readFileSync(new URL('../' + p, import.meta.url))], p.split('/').pop());

if (existsSync('tests/fixtures/exif_test.jpg')) {
  check('JPEG: DateTimeOriginal + offset +03:00 -> UTC', (await readTakenAt(fileOf('tests/fixtures/exif_test.jpg'), 'photo')) === '2024-05-01T07:20:30.000Z');
  check('JPEG: falls back to the plain DateTime tag', (await readTakenAt(fileOf('tests/fixtures/exif_ifd0.jpg'), 'photo')) === '2019-12-31T20:59:59.000Z');
  check('JPEG without EXIF -> null (sorts by upload time)', (await readTakenAt(fileOf('tests/fixtures/no_exif.jpg'), 'photo')) === null);
  check('MP4 with moov at the END of the file', (await readTakenAt(fileOf('tests/fixtures/t.mp4'), 'video')) === '2024-05-01T07:20:30.000Z');
  check('MP4 with moov at the front', (await readTakenAt(fileOf('tests/fixtures/t_front.mp4'), 'video')) === '2024-05-01T07:20:30.000Z');
} else console.log('SKIP fixtures missing (tests/fixtures)');
check('garbage bytes never throw and give null', (await readTakenAt(new File([new Uint8Array(500).fill(7)], 'x.jpg'), 'photo')) === null && (await readTakenAt(new File([new Uint8Array(30).fill(7)], 'x.mp4'), 'video')) === null);
check('empty file gives null', (await readTakenAt(new File([], 'e.jpg'), 'photo')) === null && exifDateFromBytes(new ArrayBuffer(0)) === null);
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
