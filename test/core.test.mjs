import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';
import { findDates, formatLike } from '../src/dates.js';
import { findDocxDates, applyEdits, scanPart } from '../src/docx-dates.js';
import { pictureLayout, embeddedFonts, source, missingFonts } from '../src/layout.js';
import { layoutBox } from '../src/render.js';

const d = (y, m, dd) => ({ y, m, d: dd });
const one = (text) => {
  const f = findDates(text);
  assert.equal(f.length, 1, `one date in "${text}", found ${JSON.stringify(f.map((x) => x.text))}`);
  return f[0];
};

test('finds the usual Greek and English forms', () => {
  assert.equal(one('Αθήνα, 15.10.2026').text, '15.10.2026');
  assert.equal(one('07 · 15 Οκτωβρίου 2026').text, '15 Οκτωβρίου 2026');
  assert.equal(one('έως 3/5/26.').text, '3/5/26');
  assert.equal(one('Οκτώβριος 2026').text, 'Οκτώβριος 2026');
  assert.equal(one('Παρασκευή 23 Οκτωβρίου').text, 'Παρασκευή 23 Οκτωβρίου');
  assert.equal(one('ΠΕΜΠΤΗ 15 ΟΚΤΩΒΡΙΟΥ 2026').text, 'ΠΕΜΠΤΗ 15 ΟΚΤΩΒΡΙΟΥ 2026');
  assert.equal(one('signed on October 15, 2026.').text, 'October 15, 2026');
  assert.equal(one('due 2026-10-15').text, '2026-10-15');
  assert.equal(one('στις 5 Οκτ. 2026').text, '5 Οκτ. 2026');
  assert.equal(one('ως τις 15 Οκτωβρίου.').text, '15 Οκτωβρίου');
});

test('skips things that are not dates', () => {
  assert.deepEqual(findDates('Σχολικό έτος 2026–2027'), []);
  assert.deepEqual(findDates('Τηλ. 210 2611 234, ώρα 15.10'), []);
  assert.deepEqual(findDates('31.02.2026'), []);
  assert.deepEqual(findDates('Μάιος'), []);
  assert.deepEqual(findDates('Example 14. 2 may seem slight'), []);
});

test('a weekday that does not fit the date is left out of it', () => {
  // 15 Oct 2026 is a Thursday
  assert.equal(one('Πέμπτη 15 Οκτωβρίου 2026').text, 'Πέμπτη 15 Οκτωβρίου 2026');
  assert.equal(one('Δευτέρα 15 Οκτωβρίου 2026').text, '15 Οκτωβρίου 2026');
});

test('writes the new date in the same style', () => {
  const nov5 = d(2026, 11, 5);
  assert.equal(formatLike(one('15.10.2026'), nov5), '05.11.2026');
  assert.equal(formatLike(one('15/10/26'), nov5), '05/11/26');
  assert.equal(formatLike(one('7.3.2026'), nov5), '5.11.2026');
  assert.equal(formatLike(one('15 Οκτωβρίου 2026'), nov5), '5 Νοεμβρίου 2026');
  assert.equal(formatLike(one('05 Οκτωβρίου 2026'), nov5), '05 Νοεμβρίου 2026');
  assert.equal(formatLike(one('Πέμπτη 15 Οκτωβρίου 2026'), nov5), 'Πέμπτη 5 Νοεμβρίου 2026');
  assert.equal(formatLike(one('Πέμπτη 15 Οκτωβρίου 2026'), d(2026, 11, 9)), 'Δευτέρα 9 Νοεμβρίου 2026');
  assert.equal(formatLike(one('ΠΕΜΠΤΗ 15 ΟΚΤΩΒΡΙΟΥ 2026'), d(2027, 5, 6)), 'ΠΕΜΠΤΗ 6 ΜΑΪΟΥ 2027');
  assert.equal(formatLike(one('Οκτώβριος 2026'), d(2027, 3, 1)), 'Μάρτιος 2027');
  assert.equal(formatLike(one('October 15, 2026'), nov5), 'November 5, 2026');
  assert.equal(formatLike(one('Thu, Oct 15, 2026'), nov5), 'Thu, Nov 5, 2026');
  assert.equal(formatLike(one('2026-10-15'), nov5), '2026-11-05');
  assert.equal(formatLike(one('5 Οκτ. 2026'), nov5), '5 Νοε. 2026');
});

const P = (body) => `<w:document><w:body>${body}</w:body></w:document>`;

test('a date split over several pieces is found and rewritten in place', () => {
  const xml = P('<w:p><w:r><w:t xml:space="preserve">Ίλιον, 15 Οκτ</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>ωβρίου 20</w:t></w:r><w:r><w:t>26 &amp; μετά</w:t></w:r></w:p>');
  const parts = { 'word/document.xml': xml };
  const [item] = findDocxDates(parts);
  assert.equal(item.text, '15 Οκτωβρίου 2026');
  const out = applyEdits(parts, [{ item, text: '5 Νοεμβρίου 2026' }])['word/document.xml'];
  assert.equal(out, P('<w:p><w:r><w:t xml:space="preserve">Ίλιον, 5 Νοεμβρίου 2026</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t></w:t></w:r><w:r><w:t> &amp; μετά</w:t></w:r></w:p>')
    .replace('<w:t> &amp;', '<w:t xml:space="preserve"> &amp;'));
});

test('two dates in one paragraph and in one piece', () => {
  const xml = P('<w:p><w:r><w:t>Από 1.10.2026 έως 15.10.2026</w:t></w:r></w:p>');
  const parts = { 'word/document.xml': xml };
  const items = findDocxDates(parts);
  assert.deepEqual(items.map((i) => i.text), ['1.10.2026', '15.10.2026']);
  const out = applyEdits(parts, [{ item: items[0], text: '02.11.2026' }, { item: items[1], text: '20.11.2026' }]);
  assert.equal(out['word/document.xml'], P('<w:p><w:r><w:t>Από 02.11.2026 έως 20.11.2026</w:t></w:r></w:p>'));
});

test('the old copy Word keeps of a text box changes too, and is listed once', () => {
  const box = (t) => `<w:txbxContent><w:p><w:r><w:t>${t}</w:t></w:r></w:p></w:txbxContent>`;
  const xml = P(`<w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wp:anchor><wp:docPr id="1" name="Ημερομηνία"/>${box('15.10.2026')}</wp:anchor></w:drawing></mc:Choice><mc:Fallback><w:pict><v:shape><v:textbox>${box('15.10.2026')}</v:textbox></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p>`);
  const parts = { 'word/document.xml': xml };
  const items = findDocxDates(parts);
  assert.equal(items.length, 1);
  assert.equal(items[0].where, 'Πλαίσιο κειμένου «Ημερομηνία»');
  const out = applyEdits(parts, [{ item: items[0], text: '05.11.2026' }])['word/document.xml'];
  assert.equal(out, xml.replaceAll('15.10.2026', '05.11.2026'));
});

test('headers, tables, tabs and deleted text', () => {
  const parts = {
    'word/header1.xml': '<w:hdr><w:p><w:r><w:t>Ημ/νία: 1/9/2026</w:t></w:r></w:p></w:hdr>',
    'word/document.xml': P('<w:tbl><w:tr><w:tc><w:p><w:r><w:t>15</w:t><w:tab/><w:t>10.2026</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:del><w:r><w:delText>1.1.2026</w:delText></w:r></w:del></w:p>'),
    'word/styles.xml': '<w:t>1.1.2026</w:t>',
  };
  const items = findDocxDates(parts);
  assert.deepEqual(items.map((i) => [i.text, i.where]), [['1/9/2026', 'Κεφαλίδα']]);
  assert.equal(scanPart(parts['word/document.xml'], 'word/document.xml')[0].where, 'table');
});

