// The web app's steps from the command line, for checking its output.
//   node scripts/cli.mjs IN.docx               list the dates
//   node scripts/cli.mjs IN.docx 2026-11-05 OUT.docx [OUT.pdf]   set every date
import { readFile, writeFile } from 'node:fs/promises';
import JSZip from 'jszip';
import { findDocxDates, applyEdits, TEXT_PARTS } from '../src/docx-dates.js';
import { formatLike, fromISO } from '../src/dates.js';
import { pictureLayout, embeddedFonts, source } from '../src/layout.js';
import { buildPdf } from '../src/render.js';

const [input, iso, outDocx, outPdf] = process.argv.slice(2);
const zip = await JSZip.loadAsync(await readFile(input));
const parts = {};
for (const name of Object.keys(zip.files)) if (TEXT_PARTS.test(name)) parts[name] = await zip.file(name).async('string');
const items = findDocxDates(parts);
for (const it of items) console.log(`${it.where}${it.top ? `, παράγραφος ${it.top}` : ''}: ${it.text}`);
if (!iso) process.exit(0);

const edits = items.map((item) => ({ item, text: formatLike(item.match, fromISO(iso)) }));
const changed = applyEdits(parts, edits);
for (const [name, xml] of Object.entries(changed)) zip.file(name, xml, { createFolders: false });
await writeFile(outDocx, await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));
console.log('wrote', outDocx, edits.map((e) => e.text));
if (outPdf) {
  const src = source(zip, changed);
  const layout = await pictureLayout(src);
  if (layout.reason) throw new Error(`no PDF: ${layout.reason}`);
  await writeFile(outPdf, await buildPdf(src, layout, await embeddedFonts(src), 'test'));
  console.log('wrote', outPdf);
}
