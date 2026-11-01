// PDF support, loaded only when a PDF is opened.
export { readPdf, PdfError } from './read.js';
export { writePdf, fontMode } from './write.js';

// the stand-in fonts live next to the page
export async function loadFallbackFont(name) {
  const r = await fetch(`/fonts/fallback/${name}`);
  if (!r.ok) throw new Error(`η γραμματοσειρά ${name} δεν φορτώθηκε`);
  return new Uint8Array(await r.arrayBuffer());
}
