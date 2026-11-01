// Drawing PDF pages for the preview, with pdf.js.
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
const asset = (dir) => new URL(`/pdfjs/${dir}/`, location.href).href;

// { doc, close }
export async function openPreview(bytes) {
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    cMapUrl: asset('cmaps'), cMapPacked: true,
    standardFontDataUrl: asset('standard_fonts'), wasmUrl: asset('wasm'), iccUrl: asset('iccs'),
    enableXfa: false, verbosity: 0,
  });
  return { doc: await task.promise, close: () => task.destroy() };
}

// page `n` drawn `width` pixels wide into `canvas`, without a blank frame in between
export async function drawPdfPage(doc, n, canvas, width) {
  const page = await doc.getPage(n);
  const vp = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: width / vp.width });
  const off = document.createElement('canvas');
  off.width = Math.round(viewport.width);
  off.height = Math.round(viewport.height);
  const ctx = off.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, off.width, off.height);
  await page.render({ canvasContext: ctx, canvas: off, viewport }).promise;
  canvas.width = off.width;
  canvas.height = off.height;
  canvas.getContext('2d').drawImage(off, 0, 0);
  page.cleanup();
}
