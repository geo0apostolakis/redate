// Files whose pages are pictures with text boxes on top (like a deck exported
// to Word) can be drawn exactly: the picture, then each text box line with
// the font embedded in the file. This part reads that layout; render.js draws it.
import { parseXml, kids, kid, find, findFirst } from './xml.js';

const TWIP_EMU = 635;

export function deobfuscate(bytes, key) {
  const hex = key.replace(/[{}-]/g, '');
  const k = [];
  for (let i = 0; i < 16; i++) k.push(parseInt(hex.substr(i * 2, 2), 16));
  k.reverse();
  const out = new Uint8Array(bytes);
  for (let i = 0; i < 32 && i < out.length; i++) out[i] ^= k[i % 16];
  return out;
}

function relsMap(xml) {
  const map = {};
  if (!xml) return map;
  for (const r of find(parseXml(xml), 'Relationship')) map[r.attrs.Id] = r.attrs.Target;
  return map;
}

const resolve = (base, target) => (target.startsWith('/') ? target.slice(1) : base + target);

// Read access to a .docx: `text(name)` and `bytes(name)` resolve to null for a
// missing part. `changed` holds parts with edits not saved yet.
export function source(zip, changed = {}) {
  return {
    text: async (n) => (n in changed ? changed[n] : zip.file(n) ? zip.file(n).async('string') : null),
    bytes: async (n) => (zip.file(n) ? zip.file(n).async('uint8array') : null),
  };
}

// { 'Font Name': Uint8Array } for the regular style of every embedded font
export async function embeddedFonts(src) {
  const table = await src.text('word/fontTable.xml');
  if (!table) return {};
  const rels = relsMap(await src.text('word/_rels/fontTable.xml.rels'));
  const out = {};
  for (const f of find(parseXml(table), 'w:font')) {
    const emb = kid(f, 'w:embedRegular') || kid(f, 'w:embedBold') || kid(f, 'w:embedItalic');
    const target = emb && rels[emb.attrs['r:id']];
    const bytes = target && (await src.bytes(resolve('word/', target)));
    if (!bytes) continue;
    out[f.attrs['w:name']] = emb.attrs['w:fontKey'] ? deobfuscate(bytes, emb.attrs['w:fontKey']) : bytes;
  }
  return out;
}

const num = (v, d = 0) => (v === undefined || v === null || v === '' ? d : Number(v));
const on = (el) => !!el && !['0', 'false', 'off'].includes(el.attrs['w:val']);

function runStyle(rPr, base) {
  const s = { ...base };
  if (!rPr) return s;
  const f = kid(rPr, 'w:rFonts');
  if (f) s.font = f.attrs['w:hAnsi'] || f.attrs['w:ascii'] || f.attrs['w:cs'] || s.font;
  const sz = kid(rPr, 'w:sz');
  if (sz) s.size = num(sz.attrs['w:val']) / 2;
  const c = kid(rPr, 'w:color');
  if (c && c.attrs['w:val'] && c.attrs['w:val'] !== 'auto') s.color = c.attrs['w:val'];
  const sp = kid(rPr, 'w:spacing');
  if (sp) s.spacing = num(sp.attrs['w:val']) / 20;
  if (kid(rPr, 'w:caps')) s.caps = on(kid(rPr, 'w:caps'));
  return s;
}

function paragraphLines(txbx, base) {
  return kids(txbx, 'w:p').map((p) => {
    const pPr = kid(p, 'w:pPr');
    const jc = kid(pPr, 'w:jc')?.attrs['w:val'] || 'left';
    const sp = kid(pPr, 'w:spacing');
    const pStyle = runStyle(kid(pPr, 'w:rPr'), base);
    const runs = [];
    for (const r of find(p, 'w:r')) {
      const st = runStyle(kid(r, 'w:rPr'), base);
      let text = '';
      for (const c of kids(r)) {
        if (c.name === 'w:t') text += c.children.map((x) => x.text || '').join('');
        else if (c.name === 'w:tab') text += ' ';
      }
      if (text) runs.push({ ...st, text: st.caps ? text.toUpperCase() : text });
    }
    return {
      align: { start: 'left', end: 'right', both: 'left', distribute: 'left' }[jc] || jc,
      before: num(sp?.attrs['w:before']) / 20, after: num(sp?.attrs['w:after']) / 20,
      line: sp?.attrs['w:lineRule'] === 'exact' || sp?.attrs['w:lineRule'] === 'atLeast'
        ? { pt: num(sp.attrs['w:line']) / 20, rule: sp.attrs['w:lineRule'] }
        : { mult: num(sp?.attrs['w:line'], 240) / 240 },
      runs, empty: pStyle,
    };
  });
}

function offset(pos, pageSize, margins, extent, horizontal) {
  if (!pos) return null;
  const from = pos.attrs.relativeFrom;
  let origin = 0;
  let span = pageSize;
  if (from === 'margin' || from === 'column' || from === 'paragraph' || from === 'line') {
    origin = horizontal ? margins.left : margins.top;
    span = pageSize - (horizontal ? margins.left + margins.right : margins.top + margins.bottom);
  } else if (from !== 'page') return null;
  const off = kid(pos, 'wp:posOffset');
  if (off) return origin + num(off.children[0]?.text);
  const al = kid(pos, 'wp:align')?.children[0]?.text;
  if (al === 'left' || al === 'top') return origin;
  if (al === 'center') return origin + (span - extent) / 2;
  if (al === 'right' || al === 'bottom') return origin + span - extent;
  return null;
}

// The page layout if every page is one full-page picture, else null with a reason.
export async function pictureLayout(src) {
  const doc = parseXml(await src.text('word/document.xml'));
  const rels = relsMap(await src.text('word/_rels/document.xml.rels'));
  const body = find(doc, 'w:body')[0];
  const sects = find(body, 'w:sectPr');
  if (sects.length !== 1) return { reason: 'many-sections' };
  const pg = kid(sects[0], 'w:pgSz');
  const mar = kid(sects[0], 'w:pgMar');
  const W = num(pg?.attrs['w:w']) * TWIP_EMU;
  const H = num(pg?.attrs['w:h']) * TWIP_EMU;
  const margins = {
    left: num(mar?.attrs['w:left']) * TWIP_EMU, right: num(mar?.attrs['w:right']) * TWIP_EMU,
    top: num(mar?.attrs['w:top']) * TWIP_EMU, bottom: num(mar?.attrs['w:bottom']) * TWIP_EMU,
  };
  if (!W || !H) return { reason: 'no-page-size' };
  // defaults from the styles part, if there is one
  let base = { font: null, size: 10, color: '000000', spacing: 0 };
  const styles = await src.text('word/styles.xml');
  if (styles) {
    const rd = findFirst(parseXml(styles), 'w:rPrDefault');
    base = runStyle(kid(rd, 'w:rPr'), base);
  }
  const pages = [];
  for (const el of kids(body)) {
    if (el.name === 'w:sectPr') continue;
    if (el.name !== 'w:p') return { reason: 'not-pictures' };
    // any text outside text boxes means this is a normal document
    const loose = findFirst(el, 'w:t', ['w:txbxContent', 'mc:Fallback']);
    if (loose && loose.children.some((c) => (c.text || '').trim())) return { reason: 'not-pictures' };
    const inlines = find(el, 'wp:inline');
    if (inlines.length !== 1) return { reason: 'not-pictures' };
    const ext = kid(inlines[0], 'wp:extent');
    const cx = num(ext?.attrs.cx), cy = num(ext?.attrs.cy);
    if (Math.abs(cx - W) > W * 0.02 || Math.abs(cy - H) > H * 0.02) return { reason: 'not-pictures' };
    const blip = find(inlines[0], 'a:blip')[0];
    const target = blip && rels[blip.attrs['r:embed']];
    if (!target) return { reason: 'not-pictures' };
    const boxes = [];
    for (const anchor of find(el, 'wp:anchor')) {
      const txbx = find(anchor, 'w:txbxContent')[0];
      if (!txbx) continue;
      const e = kid(anchor, 'wp:extent');
      const bw = num(e?.attrs.cx), bh = num(e?.attrs.cy);
      const x = offset(kid(anchor, 'wp:positionH'), W, margins, bw, true);
      const y = offset(kid(anchor, 'wp:positionV'), H, margins, bh, false);
      if (x === null || y === null) return { reason: 'box-position' };
      const bp = find(anchor, 'wps:bodyPr')[0];
      const ins = (k, d) => num(bp?.attrs[k], d);
      boxes.push({
        name: find(anchor, 'wp:docPr')[0]?.attrs.name || '',
        x, y, w: bw, h: bh,
        inset: { l: ins('lIns', 91440), t: ins('tIns', 45720), r: ins('rIns', 91440), b: ins('bIns', 45720) },
        anchor: bp?.attrs.anchor || 't',
        paras: paragraphLines(txbx, base),
      });
    }
    pages.push({ image: resolve('word/', target), boxes });
  }
  if (!pages.length) return { reason: 'not-pictures' };
  return { W, H, pages };
}

// Fonts the text boxes use that are not inside the file
export function missingFonts(layout, fonts) {
  const need = new Set();
  for (const p of layout.pages) for (const b of p.boxes) for (const para of b.paras) for (const r of para.runs) need.add(r.font);
  return [...need].filter((f) => !f || !fonts[f]);
}
