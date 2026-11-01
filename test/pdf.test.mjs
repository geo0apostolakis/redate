import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { parseOps } from '../src/pdf/lexer.js';
import { readPdf } from '../src/pdf/read.js';
import { writePdf, fontMode } from '../src/pdf/write.js';
import { formatLike } from '../src/dates.js';

const fixture = async (name) => new Uint8Array(await readFile(new URL(`fixtures/${name}`, import.meta.url)));
const fonts = new URL('../public/fonts/fallback/', import.meta.url);
const loadFont = async (name) => new Uint8Array(await readFile(new URL(name, fonts)));
const nov5 = { y: 2026, m: 11, d: 5 };

async function setAll(name, date = nov5) {
  const an = await readPdf(await fixture(name));
  const edits = an.items.map((item) => ({ item, text: formatLike(item.match, date) }));
  const out = await writePdf(an, edits, { loadFont });
  return { an, edits, out };
}

async function pageText(bytes, n) {
  const doc = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, verbosity: 0 }).promise;
  const tc = await (await doc.getPage(n)).getTextContent();
  return tc.items.map((i) => i.str).join(' ');
}

function assertAppended(orig, out) {
  assert.ok(out.length > orig.length);
  for (let i = 0; i < orig.length; i++) if (orig[i] !== out[i]) assert.fail(`byte ${i} of the original changed`);
}

// the text line in `an` that contains `text`
const lineWith = (an, page, text) => an.pages[page - 1].segments.find((s) => s.text.includes(text));

test('content stream reader: strings, escapes, arrays, inline images', () => {
  const ops = parseOps('BT /F1 12 Tf (a\\(b\\)c \\101\\n) Tj [<0041> -250 (x)] TJ ET BI /W 1 /H 1 ID \x00EI\x01 EI Q % note\n1 0 0 1 5 5 cm');
  assert.deepEqual(ops.map((o) => o.op), ['BT', 'Tf', 'Tj', 'TJ', 'ET', 'BI', 'Q', 'cm']);
  assert.equal(ops[2].args[0].bytes, 'a(b)c A\n');
  assert.deepEqual(ops[3].args[0].v.map((e) => e.bytes ?? e.v), ['\x00A', -250, 'x']);
  assert.deepEqual(ops[7].args.map((a) => a.v), [1, 0, 0, 1, 5, 5]);
});

test('Chrome letter: every date found, changed, and only appended to the file', async () => {
  const { an, edits, out } = await setAll('chrome-letter.pdf');
  assert.deepEqual(an.items.map((i) => i.text), ['15 Οκτωβρίου 2026', 'Πέμπτη 15 Οκτωβρίου 2026', '23.10.2026', '20/10/26',
    '18 Οκτωβρίου', '23.10.2026', '05.11.2026', 'October 30, 2026']);
  assert.deepEqual(edits.map((e) => fontMode(e.item, e.text)), ['similar', 'similar', 'similar', 'same', 'similar', 'same', 'same', 'similar']);
  assertAppended(an.bytes, out);
  await PDFDocument.load(out, { updateMetadata: false });
  const text = await pageText(out, 1);
  for (const t of ['5 Νοεμβρίου 2026', 'Πέμπτη 5 Νοεμβρίου 2026', '05.11.2026', '05/11/26', '5 Νοεμβρίου', 'November 5, 2026']) assert.ok(text.includes(t), t);
  for (const t of ['Οκτωβρίου', '23.10.2026', '20/10/26', 'October']) assert.ok(!text.includes(t), t);
  // still in the text: what only looks like a date
  assert.ok(text.includes('2026–2027') && text.includes('210 2611 234'));
});

test('Chrome letter: right-aligned and centred lines keep their alignment', async () => {
  const { an, out } = await setAll('chrome-letter.pdf');
  const after = await readPdf(out);
  const r0 = lineWith(an, 1, 'Ίλιον'), r1 = lineWith(after, 1, 'Ίλιον');
  assert.ok(r1.text.startsWith('Ίλιον, 5 Νοεμβρίου 2026'), r1.text);
  assert.ok(Math.abs(r1.end - r0.end) < 0.05, `right edge moved ${r1.end - r0.end}`);
  assert.ok(r1.start > r0.start + 3, 'the shorter date moves the line right');
  const c0 = lineWith(an, 1, 'Πέμπτη'), c1 = lineWith(after, 1, 'Πέμπτη');
  assert.ok(Math.abs((c1.start + c1.end) / 2 - (c0.start + c0.end) / 2) < 0.05, 'centre moved');
});

test('standard fonts: written in the same font, the rest of the line follows', async () => {
  const { an, edits, out } = await setAll('std-fonts.pdf');
  assert.deepEqual(edits.map((e) => [e.text, fontMode(e.item, e.text)]), [['05/11/2026', 'same'], ['November 5, 2026', 'same'], ['Thu, Nov 5, 2026', 'same']]);
  assertAppended(an.bytes, out);
  const after = await readPdf(out);
  assert.equal(lineWith(after, 1, 'Due').text, 'Due November 5, 2026 at the latest.');
  assert.equal(after.items.length, 3);
});

test('macOS letter: a justified line keeps both edges', async () => {
  const { an, out } = await setAll('quartz-letter.pdf');
  // this font's spaces are non-breaking ones
  const plain = (s) => s.replace(/\s/g, ' ');
  assert.deepEqual(an.items.map((i) => plain(i.text)), ['15 Οκτωβρίου 2026', '15/10/2026', '15 Οκτωβρίου 2026', '12.10.2026', '1 Οκτωβρίου 2026']);
  assertAppended(an.bytes, out);
  const after = await readPdf(out);
  const j0 = lineWith(an, 1, '18:00'), j1 = lineWith(after, 1, '18:00');
  assert.ok(plain(j1.text).startsWith('5 Νοεμβρίου 2026 στις 18:00'), j1.text);
  assert.ok(Math.abs(j1.start - j0.start) < 0.05 && Math.abs(j1.end - j0.end) < 0.05, 'justified edges moved');
  const r0 = lineWith(an, 1, 'Αθήνα'), r1 = lineWith(after, 1, 'Αθήνα');
  assert.ok(Math.abs(r1.end - r0.end) < 0.05);
  assert.deepEqual(after.items.map((i) => plain(i.text)), ['5 Νοεμβρίου 2026', '05/11/2026', '5 Νοεμβρίου 2026', '05.11.2026', '5 Νοεμβρίου 2026']);
});

test('no change gives the same file back', async () => {
  const an = await readPdf(await fixture('std-fonts.pdf'));
  const out = await writePdf(an, an.items.map((item) => ({ item, text: item.text })), { loadFont });
  assert.equal(out, an.bytes);
});

test('a locked PDF is refused with its own reason', async () => {
  await assert.rejects(readPdf(await fixture('locked.pdf')), (e) => e.code === 'encrypted');
});
