// Reading a PDF: run each page's drawing commands, note where every character
// lands, put the characters back into lines and find the dates in them.
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFNumber, PDFRawStream, PDFRef, EncryptedPDFError } from 'pdf-lib';
import { parseOps, num } from './lexer.js';
import { loadFont, streamBinary } from './fonts.js';
import { findDates } from '../dates.js';

const N = (k) => PDFName.of(k);
export const IDENT = [1, 0, 0, 1, 0, 0];
// m first, then n
export const mul = (m, n) => [
  m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
];
export const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
export function inverse(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!det) return IDENT;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}

export class PdfError extends Error {
  constructor(code) { super(code); this.code = code; }
}

export async function loadDoc(bytes) {
  try {
    return await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (e) {
    if (e instanceof EncryptedPDFError || /encrypt/i.test(e.message)) throw new PdfError('encrypted');
    throw new PdfError('broken');
  }
}

const numsOf = (args) => args.map((a) => (a.t === 'num' ? a.v : 0));
const COMPONENTS = { DeviceGray: 1, G: 1, CalGray: 1, DeviceRGB: 3, RGB: 3, CalRGB: 3, DeviceCMYK: 4, CMYK: 4 };
const FILL = { 1: (v) => `${v.map(num).join(' ')} g`, 3: (v) => `${v.map(num).join(' ')} rg`, 4: (v) => `${v.map(num).join(' ')} k` };

function colorComponents(ctx, resources, name) {
  if (COMPONENTS[name]) return COMPONENTS[name];
  const spaces = resources?.lookup(N('ColorSpace'));
  let cs = spaces instanceof PDFDict ? spaces.lookup(N(name)) : null;
  if (cs instanceof PDFName) return COMPONENTS[cs.decodeText()] || 0;
  if (cs instanceof PDFArray) {
    const kind = ctx.lookup(cs.get(0));
    const k = kind instanceof PDFName ? kind.decodeText() : '';
    if (COMPONENTS[k]) return COMPONENTS[k];
    if (k === 'ICCBased') {
      const s = ctx.lookup(cs.get(1));
      const n = s instanceof PDFRawStream ? s.dict.lookup(N('N')) : null;
      return n instanceof PDFNumber ? n.asNumber() : 0;
    }
  }
  return 0;
}

// Run one page. Returns its characters; content streams go into `env.streams`.
function runPage(env, page, pageIndex) {
  const ctx = env.ctx;
  const node = page.node;
  const contents = node.get(N('Contents'));
  const refs = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];
  const parts = [];
  for (const r of refs) {
    const s = ctx.lookup(r);
    if (s instanceof PDFRawStream) parts.push(streamBinary(s));
  }
  const key = `p${pageIndex}`;
  const glyphs = [];
  const hidden = [];
  const resources = node.Resources();
  const stream = { key, page: pageIndex, src: parts.join('\n'), resources };
  env.streams.set(key, stream);
  const box = page.getCropBox();
  run(env, stream, resources, IDENT, { glyphs, hidden, pageIndex, box, depth: 0, path: [] });
  return { glyphs, hidden };
}

function initialState(ctm) {
  return { ctm, font: null, size: 0, tc: 0, tw: 0, th: 1, tl: 0, ts: 0, tr: 0, fill: '0 g', fillN: 1 };
}

function run(env, stream, resources, base, page) {
  const ctx = env.ctx;
  const ops = (stream.ops = parseOps(stream.src));
  stream.base = base;
  const invBase = inverse(base);
  let gs = initialState(base);
  const stack = [];
  let tm = null, tlm = null;
  const fontCache = new Map();
  const fontFor = (name) => {
    if (fontCache.has(name)) return fontCache.get(name);
    const fonts = resources?.lookup(N('Font'));
    const ref = fonts instanceof PDFDict ? fonts.get(N(name)) : null;
    const dict = ref ? ctx.lookup(ref) : null;
    let f = null;
    if (dict instanceof PDFDict) {
      const k = ref instanceof PDFRef ? ref.toString() : `${stream.key}/${name}`;
      if (!env.fonts.has(k)) env.fonts.set(k, loadFont(ctx, dict, k));
      f = env.fonts.get(k);
    }
    fontCache.set(name, f);
    return f;
  };
  const td = (tx, ty) => { tlm = mul([1, 0, 0, 1, tx, ty], tlm); tm = tlm.slice(); };

  const show = (i, elems) => {
    if (!tm || !gs.font) return;
    const f = gs.font;
    const info = {
      s: stream.key, i, font: f, size: gs.size, tc: gs.tc, tw: gs.tw, th: gs.th, ts: gs.ts, tr: gs.tr,
      tm: tm.slice(), ctm: gs.ctm, lctm: mul(gs.ctm, invBase), fill: gs.fill,
    };
    const M = mul(info.tm, gs.ctm);
    info.sx = Math.hypot(M[0], M[1]);
    const fs = Math.abs(gs.size) * Math.hypot(M[2], M[3]);
    const record = !page.skip && f.supported && !f.vertical && gs.size * gs.th !== 0 && info.sx > 0;
    const invisible = gs.tr === 3 || gs.tr === 7;
    let pen = 0;
    let k = 0;
    for (const e of elems) {
      if (e.t === 'num') { pen -= (e.v / 1000) * gs.size * gs.th; continue; }
      if (e.bytes === undefined) continue;
      for (const c of f.split(e.bytes)) {
        const text = f.text(c.code);
        const adv = ((f.width(c.code) / 1000) * gs.size + gs.tc + (f.oneByte && c.code === 32 ? gs.tw : 0)) * gs.th;
        f.use(c.code, c.bytes, text);
        if (record) {
          const [x, y] = apply(M, pen, gs.ts);
          const b = page.box;
          // text outside the visible page (printer's marks in the trim area) is not listed
          const outside = x < b.x - 1 || x > b.x + b.width + 1 || y < b.y - 1 || y > b.y + b.height + 1;
          const g = { o: info, k, code: c.code, bytes: c.bytes, text, tx: pen, adv, x, y, dx: adv * M[0], dy: adv * M[1], fs };
          if (!outside) (invisible ? page.hidden : page.glyphs).push(g);
        }
        pen += adv;
        k++;
      }
    }
    info.end = pen;
    info.count = k;
    tm = mul([1, 0, 0, 1, pen, 0], tm);
  };

  for (let i = 0; i < ops.length; i++) {
    const { op, args } = ops[i];
    switch (op) {
      case 'q': stack.push(gs); gs = { ...gs }; break;
      case 'Q': if (stack.length) gs = stack.pop(); break;
      case 'cm': if (args.length === 6) gs.ctm = mul(numsOf(args), gs.ctm); break;
      case 'g': gs.fill = FILL[1](numsOf(args)); gs.fillN = 1; break;
      case 'rg': gs.fill = FILL[3](numsOf(args)); gs.fillN = 3; break;
      case 'k': gs.fill = FILL[4](numsOf(args)); gs.fillN = 4; break;
      case 'cs': {
        const n = args[0]?.t === 'name' ? colorComponents(ctx, resources, args[0].v) : 0;
        gs.fillN = n;
        gs.fill = n === 4 ? '0 0 0 1 k' : n === 3 ? '0 0 0 rg' : '0 g';
        break;
      }
      case 'sc': case 'scn': {
        const v = args.filter((a) => a.t === 'num').map((a) => a.v);
        if (FILL[gs.fillN] && v.length === gs.fillN) gs.fill = FILL[gs.fillN](v);
        break;
      }
      case 'BT': tm = IDENT.slice(); tlm = IDENT.slice(); break;
      case 'ET': tm = null; break;
      case 'Tf': gs.font = args[0]?.t === 'name' ? fontFor(args[0].v) : null; gs.size = args[1]?.v ?? 0; break;
      case 'Tc': gs.tc = args[0]?.v ?? 0; break;
      case 'Tw': gs.tw = args[0]?.v ?? 0; break;
      case 'Tz': gs.th = (args[0]?.v ?? 100) / 100; break;
      case 'TL': gs.tl = args[0]?.v ?? 0; break;
      case 'Ts': gs.ts = args[0]?.v ?? 0; break;
      case 'Tr': gs.tr = args[0]?.v ?? 0; break;
      case 'Td': if (tm) td(args[0]?.v ?? 0, args[1]?.v ?? 0); break;
      case 'TD': if (tm) { gs.tl = -(args[1]?.v ?? 0); td(args[0]?.v ?? 0, args[1]?.v ?? 0); } break;
      case 'Tm': if (tm && args.length === 6) { tlm = numsOf(args); tm = tlm.slice(); } break;
      case 'T*': if (tm) td(0, -gs.tl); break;
      case 'Tj': if (args[0]) show(i, [args[0]]); break;
      case 'TJ': if (args[0]?.t === 'arr') show(i, args[0].v); break;
      case "'": if (tm) { td(0, -gs.tl); if (args[0]) show(i, [args[0]]); } break;
      case '"':
        if (tm && args.length >= 3) {
          gs.tw = args[0].v; gs.tc = args[1].v;
          td(0, -gs.tl);
          show(i, [args[2]]);
        }
        break;
      case 'Do': {
        if (args[0]?.t !== 'name' || page.depth > 12) break;
        const xs = resources?.lookup(N('XObject'));
        const ref = xs instanceof PDFDict ? xs.get(N(args[0].v)) : null;
        if (!(ref instanceof PDFRef)) break;
        const x = ctx.lookup(ref);
        if (!(x instanceof PDFRawStream) || x.dict.lookup(N('Subtype'))?.decodeText?.() !== 'Form') break;
        const key = `x${ref.objectNumber}_${ref.generationNumber}`;
        if (page.path.includes(key)) break;
        let pages = env.formPages.get(key);
        if (!pages) env.formPages.set(key, (pages = new Set()));
        pages.add(page.pageIndex);
        const seen = env.streams.has(key);
        const m = x.dict.lookup(N('Matrix'));
        const matrix = m instanceof PDFArray && m.size() === 6 ? m.asArray().map((v) => ctx.lookup(v)?.asNumber?.() ?? 0) : IDENT;
        const res = x.dict.lookup(N('Resources'));
        const sub = seen ? { ...env.streams.get(key) } : { key, ref, src: '', resources: res instanceof PDFDict ? res : resources };
        if (!seen) {
          try { sub.src = streamBinary(x); } catch { sub.src = ''; }
          env.streams.set(key, sub);
        }
        // a form drawn a second time is read again only to keep its fonts' codes; its text was listed already
        run(env, seen ? { ...sub } : sub, sub.resources, mul(matrix, gs.ctm),
          { ...page, skip: page.skip || seen, depth: page.depth + 1, path: [...page.path, key] });
        break;
      }
      default: break;
    }
  }
  stream.qEnd = stack.length;
  stream.btOpen = !!tm;
}

// Characters of a page, put into lines in reading order. Each line is split
// where there is a wide gap (columns, tab stops).
function makeLines(glyphs) {
  const groups = new Map();
  for (const g of glyphs) {
    const len = Math.hypot(g.dx, g.dy);
    let ang;
    if (len > 1e-6) ang = Math.atan2(g.dy, g.dx);
    else { const M = mul(g.o.tm, g.o.ctm); ang = Math.atan2(M[1], M[0]); }
    const key = Math.round((ang * 180) / Math.PI);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(g);
    g.len = len;
  }
  const segments = [];
  for (const [key, list] of groups) {
    const a = (key * Math.PI) / 180;
    const cos = Math.cos(a), sin = Math.sin(a);
    for (const g of list) { g.along = g.x * cos + g.y * sin; g.perp = -g.x * sin + g.y * cos; }
    const byPerp = list.slice().sort((p, q) => q.perp - p.perp);
    const lines = [];
    let cur = null;
    for (const g of byPerp) {
      if (cur && Math.abs(cur.perp - g.perp) <= 0.3 * Math.min(cur.fs, g.fs || cur.fs)) cur.glyphs.push(g);
      else { cur = { perp: g.perp, fs: g.fs || 1, glyphs: [g] }; lines.push(cur); }
    }
    for (const line of lines) {
      // stable: characters at the same place keep the order they were drawn in
      const gl = line.glyphs.map((g, i) => [g, i]).sort((p, q) => p[0].along - q[0].along || p[1] - q[1]).map((p) => p[0]);
      let seg = null;
      let prev = null;
      for (const g of gl) {
        const size = Math.max(g.fs, prev?.fs || 0) || 1;
        // the same character drawn again on top (fake bold, shadow) goes with the first one
        if (prev && g.text === prev.text && Math.abs(g.along - prev.along) < 0.15 * size && Math.abs(g.perp - prev.perp) < 0.15 * size) {
          (prev.twins ||= []).push(g);
          continue;
        }
        const gap = prev ? g.along - (prev.along + prev.len) : 0;
        if (!seg || gap > 3 * size) {
          seg = { key, cos, sin, perp: line.perp, glyphs: [], text: '', map: [] };
          segments.push(seg);
        } else if (gap > 0.15 * size && !/\s$/.test(prev.text) && !/^\s/.test(g.text)) {
          seg.text += ' ';
          seg.map.push(-1);
        }
        g.at = seg.text.length;
        seg.glyphs.push(g);
        for (let i = 0; i < g.text.length; i++) seg.map.push(seg.glyphs.length - 1);
        seg.text += g.text;
        prev = g;
      }
    }
  }
  // a line's edges are where its first and last visible characters are
  for (const s of segments) {
    const ink = s.glyphs.filter((g) => !/^\s*$/.test(g.text));
    const first = ink[0] || s.glyphs[0], last = ink[ink.length - 1] || s.glyphs[s.glyphs.length - 1];
    s.start = first.along;
    s.end = last.along + last.len;
  }
  // top to bottom, then left to right
  segments.sort((p, q) => q.perp - p.perp || p.start - q.start);
  return segments;
}

// Where each line's text block starts and ends, per direction, for alignment
function textBounds(segments) {
  const b = new Map();
  for (const s of segments) {
    if (!s.text.trim()) continue;
    const x = b.get(s.key) || { min: Infinity, max: -Infinity };
    x.min = Math.min(x.min, s.start);
    x.max = Math.max(x.max, s.end);
    b.set(s.key, x);
  }
  return b;
}

// Open a PDF and list its dates.
export async function readPdf(bytes) {
  const doc = await loadDoc(bytes);
  const ctx = doc.context;
  const env = { ctx, fonts: new Map(), streams: new Map(), formPages: new Map() };
  const pages = doc.getPages();
  const items = [];
  let hiddenDates = 0;
  let anyText = false;
  const pageInfo = [];
  pages.forEach((page, pi) => {
    const { glyphs, hidden } = runPage(env, page, pi);
    if (glyphs.length) anyText = true;
    const segments = makeLines(glyphs);
    const box = page.getCropBox();
    pageInfo.push({ segments, bounds: textBounds(segments), box });
    for (const seg of segments) {
      if (!/\d/.test(seg.text)) continue;
      for (const d of findDates(seg.text)) {
        const idx = [];
        for (let c = d.start; c < d.end; c++) if (seg.map[c] >= 0 && idx[idx.length - 1] !== seg.map[c]) idx.push(seg.map[c]);
        if (!idx.length) continue;
        const i0 = idx[0], i1 = idx[idx.length - 1];
        const g0 = seg.glyphs[i0], g1 = seg.glyphs[i1];
        const forms = new Set(seg.glyphs.slice(i0, i1 + 1).map((g) => g.o.s).filter((s) => s[0] === 'x'));
        const others = Math.max(0, ...[...forms].map((s) => env.formPages.get(s).size - 1));
        items.push({
          id: `p${pi}@${items.length}`, kind: 'pdf', page: pi + 1, top: pi + 1,
          where: `Σελίδα ${pi + 1}` + (others ? ` (και σε ${others === 1 ? '1 ακόμα σελίδα' : `${others} ακόμα σελίδες`})` : ''),
          match: d, text: d.text,
          before: seg.text.slice(Math.max(0, d.start - 40), d.start), after: seg.text.slice(d.end, d.end + 40),
          seg, i0, i1, pre: seg.text.slice(g0.at, d.start), suf: seg.text.slice(d.end, g1.at + g1.text.length),
          mirrors: [],
        });
      }
    }
    for (const seg of makeLines(hidden)) if (/\d/.test(seg.text)) hiddenDates += findDates(seg.text).length;
  });
  return { bytes, doc, env, pages: pageInfo, items, hiddenDates, anyText, pageCount: pages.length, largest: ctx.largestObjectNumber };
}
