// The PDF steps from the command line, for checking the output.
//   node scripts/pdf-cli.mjs IN.pdf                         list the dates
//   node scripts/pdf-cli.mjs IN.pdf 2026-11-05 OUT.pdf      set every date
import { readFile, writeFile } from 'node:fs/promises';
import { readPdf } from '../src/pdf/read.js';
import { writePdf, fontMode } from '../src/pdf/write.js';
import { formatLike, fromISO } from '../src/dates.js';

const [input, iso, out] = process.argv.slice(2);
const an = await readPdf(new Uint8Array(await readFile(input)));
console.log(`${an.pageCount} pages, text: ${an.anyText}, hidden dates: ${an.hiddenDates}`);
for (const it of an.items) console.log(`${it.where}: «${it.text}»  …${it.before.slice(-20)}[${it.text}]${it.after.slice(0, 20)}…  font ${it.seg.glyphs[it.i0].o.font.baseFont}`);
if (!iso) process.exit(0);
const edits = an.items.map((item) => ({ item, text: formatLike(item.match, fromISO(iso)) }));
for (const e of edits) console.log(`  ${e.item.text} -> ${e.text} (${fontMode(e.item, e.text)})`);
const fonts = new URL('../public/fonts/fallback/', import.meta.url);
const bytes = await writePdf(an, edits, { loadFont: async (name) => new Uint8Array(await readFile(new URL(name, fonts))) });
await writeFile(out, bytes);
console.log('wrote', out, bytes.length, 'bytes, was', an.bytes.length);
