// pdf.js loads these files at run time (CMaps, standard fonts, image decoders,
// colour profile). Run after updating pdfjs-dist: node scripts/copy-pdfjs.mjs
import { cp, rm } from 'node:fs/promises';
const from = new URL('../node_modules/pdfjs-dist/', import.meta.url);
const to = new URL('../public/pdfjs/', import.meta.url);
await rm(to, { recursive: true, force: true });
for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) await cp(new URL(`${dir}/`, from), new URL(`${dir}/`, to), { recursive: true });
await cp(new URL('LICENSE', from), new URL('LICENSE', to));
console.log('copied pdf.js assets to public/pdfjs');
