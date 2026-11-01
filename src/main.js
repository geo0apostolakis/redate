import JSZip from 'jszip';
import './fonts.css';
import './style.css';
import { findDocxDates, applyEdits, TEXT_PARTS } from './docx-dates.js';
import { formatLike, toISO, fromISO } from './dates.js';
import { source, pictureLayout, embeddedFonts, missingFonts } from './layout.js';

const renderer = () => import('./render.js');
const pdfModule = () => import('./pdf/index.js');
const previewer = () => import('./pdf/preview.js');

const $ = (id) => document.getElementById(id);
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

let state = null;

function show(el, on = true) { el.hidden = !on; }

function message(text, kind = 'info') {
  const m = $('message');
  m.textContent = text;
  m.className = 'message' + (kind === 'error' ? ' error' : '');
  show(m, !!text);
}

function plural(n, one, many) { return `${n} ${n === 1 ? one : many}`; }

const NOT_A_FILE = 'Αυτό δεν είναι αρχείο Word (.docx) ή PDF. Διαλέξτε ένα αρχείο .docx ή .pdf.';
const PDF_LOCKED = 'Αυτό το PDF είναι κλειδωμένο με κωδικό ή προστασία, οπότε δεν μπορεί να αλλάξει. Χρειάζεται το ίδιο PDF χωρίς κλείδωμα.';
const PDF_BROKEN = 'Το PDF δεν ανοίγει. Ίσως είναι χαλασμένο.';
const PDF_PICTURES = 'Οι σελίδες αυτού του PDF είναι εικόνες (για παράδειγμα σκαναρισμένες), οπότε οι ημερομηνίες πάνω τους δεν είναι κείμενο που αλλάζει. Χρειάζεται το αρχικό αρχείο, π.χ. το Word.';
const NO_DATES = 'Δεν βρέθηκε καμία ημερομηνία στο κείμενο του αρχείου.';
const SIMILAR_FONT = 'Γράφεται με παρόμοια γραμματοσειρά, γιατί σε αυτή του PDF λείπουν γράμματα.';

const isPdf = (file, buf) => /\.pdf$/i.test(file.name) || new TextDecoder('latin1').decode(buf.subarray(0, 1024)).includes('%PDF-');

function reset() {
  state = null;
  pdfRun++;
  $('rows').replaceChildren();
  $('pages').replaceChildren();
  show($('drop'));
  show($('loaded'), false);
  show($('step-dates'), false);
  show($('step-preview'), false);
  show($('savebar'), false);
  show($('save-docx'));
  $('save-pdf').textContent = 'Κατέβασμα PDF';
  $('save-pdf').className = 'btn btn-secondary';
  message('');
  $('file').value = '';
}

async function openFile(file) {
  reset();
  if (!file) return;
  if (/\.doc$/i.test(file.name)) {
    message('Αυτό είναι παλιό αρχείο .doc. Ανοίξτε το στο Word, αποθηκεύστε το ως .docx και δοκιμάστε ξανά.', 'error');
    return;
  }
  message('Άνοιγμα του αρχείου…');
  const buf = new Uint8Array(await file.arrayBuffer());
  if (buf[0] === 0xd0 && buf[1] === 0xcf) {
    message('Το αρχείο δεν ανοίγει. Αν έχει κωδικό, αφαιρέστε τον στο Word και δοκιμάστε ξανά.', 'error');
    return;
  }
  if (isPdf(file, buf)) return openPdf(file, buf);
  let zip;
  try {
    zip = await JSZip.loadAsync(buf);
  } catch {
    message(NOT_A_FILE, 'error');
    return;
  }
  if (!zip.file('word/document.xml')) {
    message(NOT_A_FILE, 'error');
    return;
  }
  const parts = {};
  for (const name of Object.keys(zip.files)) {
    if (TEXT_PARTS.test(name)) parts[name] = await zip.file(name).async('string');
  }
  const items = findDocxDates(parts);
  let layout = null;
  let fonts = {};
  try {
    const l = await pictureLayout(source(zip));
    if (!l.reason) {
      layout = l;
      fonts = await embeddedFonts(source(zip));
      if (missingFonts(layout, fonts).length) layout = { ...layout, noFonts: true };
    }
  } catch (e) {
    console.warn('no preview', e);
    layout = null;
  }

  state = { kind: 'docx', file, zip, parts, layout, fonts, images: new Map(), rows: items.map(makeRow) };
  $('file-name').textContent = file.name;
  show($('drop'), false);
  show($('loaded'));

  if (!items.length) {
    $('file-meta').textContent = 'Δεν βρέθηκαν ημερομηνίες';
    const pictures = layout && !layout.pages.some((p) => p.boxes.length);
    message(pictures
      ? 'Οι σελίδες αυτού του αρχείου είναι εικόνες, οπότε οι ημερομηνίες πάνω τους δεν είναι κείμενο που αλλάζει. Χρειάζεται η έκδοση του αρχείου που έχει γραπτή ημερομηνία.'
      : NO_DATES);
    return;
  }
  message('');
  $('file-meta').textContent = `Βρέθηκαν ${plural(items.length, 'ημερομηνία', 'ημερομηνίες')}`;
  renderRows();
  show($('all'), items.length > 1);
  $('all-date').value = todayISO();
  show($('step-dates'));
  show($('savebar'));
  show($('save-pdf'), !!(layout && !layout.noFonts));
  updateSummary();
  if (layout && !layout.noFonts) {
    show($('step-preview'));
    await renderPreview();
  }
}

async function openPdf(file, buf) {
  const pdf = await pdfModule();
  let an;
  try {
    an = await pdf.readPdf(buf);
  } catch (e) {
    console.warn(e);
    message(e.code === 'encrypted' ? PDF_LOCKED : PDF_BROKEN, 'error');
    return;
  }
  state = { kind: 'pdf', file, pdf, an, rows: an.items.map(makeRow) };
  $('file-name').textContent = file.name;
  show($('drop'), false);
  show($('loaded'));
  if (!an.items.length) {
    $('file-meta').textContent = 'Δεν βρέθηκαν ημερομηνίες';
    message(an.hiddenDates || !an.anyText ? PDF_PICTURES : NO_DATES);
    return;
  }
  message('');
  $('file-meta').textContent = `Βρέθηκαν ${plural(an.items.length, 'ημερομηνία', 'ημερομηνίες')} σε ${plural(an.pageCount, 'σελίδα', 'σελίδες')}`;
  renderRows();
  show($('all'), an.items.length > 1);
  $('all-date').value = todayISO();
  show($('step-dates'));
  show($('savebar'));
  show($('save-docx'), false);
  show($('save-pdf'));
  $('save-pdf').textContent = 'Αποθήκευση PDF';
  $('save-pdf').className = 'btn btn-primary';
  updateSummary();
  show($('step-preview'));
  await renderPdfPreview();
}

function todayISO() {
  const t = new Date();
  return toISO({ y: t.getFullYear(), m: t.getMonth() + 1, d: t.getDate() });
}

function makeRow(item) {
  const v = item.match.value;
  const now = new Date();
  const iso = toISO({ y: v.y ?? now.getFullYear(), m: v.m, d: v.d ?? 1 });
  return { item, origISO: iso, iso, text: item.text, custom: false };
}

function rowChanged(r) { return r.text !== r.item.text; }

function renderRows() {
  const list = $('rows');
  list.replaceChildren();
  state.rows.forEach((r, i) => {
    const li = document.createElement('li');
    li.className = 'row';
    const where = document.createElement('p');
    where.className = 'row-where';
    where.textContent = r.item.where + (state.kind === 'docx' && state.layout && r.item.top ? ` · σελίδα ${r.item.top}` : '');
    const ctx = document.createElement('p');
    ctx.className = 'row-context';
    const before = r.item.before.replace(/\s+/g, ' ');
    const after = r.item.after.replace(/\s+/g, ' ');
    const mark = document.createElement('mark');
    mark.textContent = r.item.text;
    ctx.append((r.item.before.length >= 40 ? '…' : '') + before, mark, after + (r.item.after.length >= 40 ? '…' : ''));

    const edit = document.createElement('div');
    edit.className = 'row-edit';
    const dateId = `d${i}`, textId = `t${i}`;
    const dl = document.createElement('label');
    dl.className = 'sr';
    dl.htmlFor = dateId;
    dl.textContent = `Νέα ημερομηνία για ${r.item.text}`;
    const date = document.createElement('input');
    date.type = 'date';
    date.id = dateId;
    date.value = r.iso;
    const tl = document.createElement('label');
    tl.className = 'sr';
    tl.htmlFor = textId;
    tl.textContent = 'Πώς θα γραφτεί';
    const text = document.createElement('input');
    text.type = 'text';
    text.id = textId;
    text.className = 'result';
    text.value = r.text;
    text.spellcheck = false;
    const undo = document.createElement('button');
    undo.type = 'button';
    undo.className = 'btn btn-quiet';
    undo.textContent = 'Επαναφορά';
    const stateLine = document.createElement('p');
    stateLine.className = 'row-state';

    const sync = () => {
      li.classList.toggle('changed', rowChanged(r));
      const similar = state.kind === 'pdf' && rowChanged(r) && state.pdf.fontMode(r.item, r.text) === 'similar';
      stateLine.textContent = rowChanged(r) ? `Θα γραφτεί «${r.text}» στη θέση του «${r.item.text}».${similar ? ` ${SIMILAR_FONT}` : ''}` : '';
      undo.disabled = !rowChanged(r) && r.iso === r.origISO;
      updateSummary();
      schedulePreview();
    };
    r.setDate = (iso) => {
      if (!iso) return;
      r.iso = iso;
      r.custom = false;
      r.text = formatLike(r.item.match, fromISO(iso));
      date.value = iso;
      text.value = r.text;
      sync();
    };
    date.addEventListener('change', () => r.setDate(date.value));
    text.addEventListener('input', () => {
      r.text = text.value;
      r.custom = true;
      sync();
    });
    undo.addEventListener('click', () => {
      r.iso = r.origISO;
      r.text = r.item.text;
      r.custom = false;
      date.value = r.iso;
      text.value = r.text;
      sync();
    });
    edit.append(dl, date, tl, text, undo);
    li.append(where, ctx, edit, stateLine);
    list.append(li);
    sync();
  });
}

function edits() {
  return state.rows.filter(rowChanged).map((r) => ({ item: r.item, text: r.text }));
}

// every text part as it would be saved now
function currentParts(s = state) {
  return { ...s.parts, ...applyEdits(s.parts, edits()) };
}

function updateSummary() {
  const n = edits().length;
  $('summary').textContent = n
    ? `Θα αλλάξουν ${plural(n, 'ημερομηνία', 'ημερομηνίες')}.`
    : 'Δεν έχετε αλλάξει καμία ημερομηνία ακόμα.';
  $('save-docx').disabled = n === 0;
  if (state.kind === 'pdf') $('save-pdf').disabled = n === 0;
}

let previewTimer = 0;
function schedulePreview() {
  if (state?.kind === 'pdf') {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(renderPdfPreview, 250);
    return;
  }
  if (!state?.layout || state.layout.noFonts) return;
  clearTimeout(previewTimer);
  previewTimer = setTimeout(renderPreview, 120);
}

function pageFigure(wrap, n) {
  let fig = wrap.querySelector(`[data-page="${n}"]`);
  if (!fig) {
    fig = document.createElement('figure');
    fig.className = 'page';
    fig.dataset.page = n;
    const c = document.createElement('canvas');
    c.setAttribute('role', 'img');
    const cap = document.createElement('figcaption');
    cap.textContent = `Σελίδα ${n}`;
    fig.append(c, cap);
    wrap.append(fig);
  }
  return fig;
}

// the PDF as it would be saved now
function pdfBytes(s = state) {
  return s.pdf.writePdf(s.an, edits(), { loadFont: s.pdf.loadFallbackFont });
}

let pdfRun = 0;
async function renderPdfPreview() {
  const s = state;
  const run = ++pdfRun;
  let bytes;
  try {
    bytes = await pdfBytes(s);
  } catch (e) {
    console.error(e);
    message(`Κάτι πήγε στραβά: ${e.message}`, 'error');
    return;
  }
  const { openPreview, drawPdfPage } = await previewer();
  if (s !== state || run !== pdfRun) return;
  const { doc, close } = await openPreview(bytes);
  try {
    const wrap = $('pages');
    const pages = [...new Set(s.rows.map((r) => r.item.page))].sort((a, b) => a - b);
    for (const n of pages) {
      if (s !== state || run !== pdfRun) return;
      const canvas = pageFigure(wrap, n).querySelector('canvas');
      const w = Math.min(2400, Math.round(wrap.clientWidth * (window.devicePixelRatio || 1)));
      await drawPdfPage(doc, n, canvas, w);
      canvas.setAttribute('aria-label', `Σελίδα ${n} με τις νέες ημερομηνίες`);
    }
  } finally {
    close();
  }
}

async function pageImage(path) {
  if (!state.images.has(path)) {
    const blob = new Blob([await state.zip.file(path).async('uint8array')]);
    const img = new Image();
    img.src = URL.createObjectURL(blob);
    await img.decode();
    state.images.set(path, img);
  }
  return state.images.get(path);
}

async function renderPreview() {
  const s = state;
  let changed;
  try {
    changed = currentParts(s);
  } catch (e) {
    message(e.message, 'error');
    return;
  }
  const layout = await pictureLayout(source(s.zip, changed));
  if (s !== state || layout.reason) return;
  const pages = [...new Set(s.rows.map((r) => r.item.top).filter(Boolean))].sort((a, b) => a - b);
  const wrap = $('pages');
  for (const n of pages) {
    const canvas = pageFigure(wrap, n).querySelector('canvas');
    const page = layout.pages[n - 1];
    const img = await pageImage(page.image);
    const w = Math.min(img.naturalWidth, Math.round(wrap.clientWidth * (window.devicePixelRatio || 1)));
    canvas.width = w;
    canvas.height = Math.round((layout.H / layout.W) * w);
    canvas.setAttribute('aria-label', `Σελίδα ${n} με τις νέες ημερομηνίες`);
    (await renderer()).drawPage(canvas.getContext('2d'), img, layout, page, s.fonts, w);
  }
}

function download(data, name, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

const baseName = () => state.file.name.replace(/\.(docx|pdf)$/i, '');

async function busy(btn, label, job) {
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  try {
    await job();
  } catch (e) {
    console.error(e);
    message(`Κάτι πήγε στραβά: ${e.message}`, 'error');
  } finally {
    btn.textContent = old;
    btn.disabled = false;
    updateSummary();
  }
}

$('save-docx').addEventListener('click', () => busy($('save-docx'), 'Αποθήκευση…', async () => {
  // every text part goes back in, so an edit undone after an earlier save is undone in the file too
  for (const [name, xml] of Object.entries(currentParts())) state.zip.file(name, xml, { createFolders: false });
  const data = await state.zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', mimeType: DOCX_MIME });
  download(data, `${baseName()}.docx`, DOCX_MIME);
  message(`Έτοιμο. Το «${baseName()}.docx» είναι στις Λήψεις σας.`);
}));

$('save-pdf').addEventListener('click', () => busy($('save-pdf'), state.kind === 'pdf' ? 'Αποθήκευση…' : 'Δημιουργία PDF…', async () => {
  if (state.kind === 'pdf') {
    download(await pdfBytes(), `${baseName()}.pdf`, 'application/pdf');
    message(`Έτοιμο. Το «${baseName()}.pdf» είναι στις Λήψεις σας.`);
    return;
  }
  const src = source(state.zip, currentParts());
  const layout = await pictureLayout(src);
  const pdf = await (await renderer()).buildPdf(src, layout, state.fonts, baseName());
  download(pdf, `${baseName()}.pdf`, 'application/pdf');
  message(`Έτοιμο. Το «${baseName()}.pdf» είναι στις Λήψεις σας.`);
}));

$('all-apply').addEventListener('click', () => {
  const iso = $('all-date').value;
  if (!iso) return;
  state.rows.forEach((r) => r.setDate(iso));
});

$('file').addEventListener('change', (e) => openFile(e.target.files[0]));
$('change-file').addEventListener('click', () => { reset(); $('file').click(); });

const drop = $('drop');
['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, () => drop.classList.remove('over')));
drop.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); openFile(e.dataTransfer.files[0]); });
// a file dropped outside the box should not replace the page
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => { e.preventDefault(); if (e.dataTransfer.files[0]) openFile(e.dataTransfer.files[0]); });
window.addEventListener('resize', schedulePreview);
