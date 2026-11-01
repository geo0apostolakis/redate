// Writing new dates into a PDF.
//
// Each date is taken out of the drawing commands that drew it, and the new
// text goes in its place: in the same font when that font already has every
// character, otherwise drawn on top in the font's own program or in a font
// with the same measurements (Arimo for Arial, Tinos for Times, ...). The rest
// of the line stays put, or moves as Word would move it (right aligned,
// centred, justified). The changes are appended to the end of the original
// file, so every original byte stays as it was.
import { PDFName, PDFDict } from 'pdf-lib';
import { writeTJ, num, binaryToBytes, bytesToBinary } from './lexer.js';
import { loadDoc, mul } from './read.js';
import { trueTypeFont } from './embed.js';

const N = (k) => PDFName.of(k);
const isSpace = (t) => t.length > 0 && /^\s+$/.test(t);

// The new text is drawn in runs: digits take the look of the old date's
// digits, letters that of its letters, everything else that of the character
// before it. Most dates are one run in one font.
function runsOf(item, full) {
  const G = item.seg.glyphs.slice(item.i0, item.i1 + 1).filter((g) => !isSpace(g.text));
  const digit = G.find((g) => /\p{N}/u.test(g.text)) || G[0];
  const letter = G.find((g) => /\p{L}/u.test(g.text)) || G[0];
  const alike = (p, q) => p.o.font === q.o.font && p.o.size === q.o.size;
  const runs = [];
  let prev = null;
  for (const ch of full) {
    const ref = /\p{N}/u.test(ch) ? digit : /\p{L}/u.test(ch) ? letter : prev || G[0];
    const last = runs[runs.length - 1];
    if (last && alike(last.ref, ref)) last.text += ch;
    else runs.push({ ref, text: ch });
    prev = ref;
  }
  return runs;
}

// 'same': the PDF's own font draws it; 'original': drawn on top with the
// same font; 'similar': drawn on top with a font of the same measurements
function runMode(run) {
  const f = run.ref.o.font;
  const chars = [...run.text].filter((c) => !/\s/.test(c));
  if (chars.every((c) => f.encode(c))) return 'same';
  if (f.programHas(chars.join(''))) return 'original';
  return 'similar';
}
const RANK = { same: 0, original: 1, similar: 2 };
export function fontMode(item, text) {
  let worst = 'same';
  for (const run of runsOf(item, item.pre + text + item.suf)) {
    const m = runMode(run);
    if (RANK[m] > RANK[worst]) worst = m;
  }
  return worst;
}

export function fallbackFile(f) {
  const fam = /calibri|carlito/i.test(f.base) ? 'Carlito' : f.mono ? 'Cousine' : f.serif ? 'Tinos' : 'Arimo';
  const italic = f.italic && fam !== 'Cousine';
  return `${fam}-${f.bold && italic ? 'BoldItalic' : f.bold ? 'Bold' : italic ? 'Italic' : 'Regular'}.ttf`;
}

const advance = (info, code) => {
  const f = info.font;
  return ((f.width(code) / 1000) * info.size + info.tc + (f.oneByte && code === 32 ? info.tw : 0)) * info.th;
};

// the gaps that stand for spaces inside the old date, in page units
function virtualGaps(item) {
  const { seg, i0, i1 } = item;
  const out = [];
  for (let i = i0 + 1; i <= i1; i++) {
    const g = seg.glyphs[i];
    if (seg.map[g.at - 1] === -1) { const p = seg.glyphs[i - 1]; out.push(g.along - (p.along + p.len)); }
  }
  return out;
}

const average = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

// the spacing the old date was drawn with, in page units: word gaps (when
// spaces were left out and the words moved apart instead) and extra room
// between letters
function spacing(item) {
  const { seg, i0, i1 } = item;
  const G = seg.glyphs;
  const gaps = virtualGaps(item);
  const extra = [];
  for (let j = i0; j < i1; j++) {
    const a = G[j], b = G[j + 1];
    if (seg.map[b.at - 1] === -1 || isSpace(a.text) || isSpace(b.text)) continue;
    extra.push(b.along - (a.along + a.len));
  }
  extra.sort((p, q) => p - q);
  const median = extra.length ? extra[Math.floor(extra.length / 2)] : 0;
  return {
    real: (f) => G.slice(i0, i1 + 1).find((g) => isSpace(g.text) && g.o.font === f),
    gaps: gaps.length > 0,
    gap: gaps.length ? average(gaps) : 0.25 * G[i0].fs,
    track: Math.abs(median) > 0.02 * G[i0].fs ? median : 0,
  };
}

// The new text laid out glyph by glyph. Each run gets items { x, adv, ... }
// with x in page units from the start of the date and adv in the run's
// text units. fontFor(font, chars) -> { font, hasSpace } for runs drawn on top.
async function layout(item, full, fontFor) {
  const sp = spacing(item);
  const runs = runsOf(item, full);
  let x = 0, gaps = 0, any = false;
  for (const run of runs) {
    const info = run.ref.o, f = info.font;
    run.mode = runMode(run);
    let glyphOf, withSpace;
    if (run.mode === 'same') {
      const real = sp.real(f);
      const space = real ? { code: real.code, bytes: real.bytes } : !sp.gaps ? f.encode(' ') : null;
      glyphOf = (ch) => {
        const e = ch === ' ' ? space : f.encode(ch);
        return { bytes: e.bytes, adv: advance(info, e.code) };
      };
      withSpace = !!space;
    } else {
      const of = await fontFor(f, [...run.text].filter((c) => !/\s/.test(c)).join(''));
      run.font = of.font;
      glyphOf = (ch) => ({ hex: of.font.encode(ch).hex, adv: ((of.font.width(ch) / 1000) * info.size + info.tc) * info.th });
      withSpace = of.hasSpace && (!!sp.real(f) || !sp.gaps);
    }
    run.items = [];
    for (const ch of run.text) {
      const blank = /\s/.test(ch);
      if (blank && !withSpace) { gaps++; continue; }
      x += any && !gaps ? sp.track : sp.gap * gaps;
      gaps = 0;
      const g = glyphOf(blank ? ' ' : ch);
      run.items.push({ ...g, x });
      x += g.adv * info.sx;
      any = true;
    }
  }
  x += sp.gap * gaps;
  return { runs: runs.filter((r) => r.items.length), width: x };
}

// One drawing command written again with some characters left out, some
// moved and new ones put in. Its total advance stays the same, so nothing
// drawn after it moves.
function rebuildOp(op, ed) {
  const info = ed.info, f = info.font;
  const unit = (info.size * info.th) / 1000;
  const elems = op.op === 'TJ' ? op.args[0].v : [op.args[op.args.length - 1]];
  const out = [];
  let pen = 0, x = 0, k = 0;
  const moveTo = (target) => {
    const d = target - pen;
    if (Math.abs(d) < 1e-7) return;
    const n = -d / unit;
    if (typeof out[out.length - 1] === 'number') out[out.length - 1] += n;
    else out.push(n);
    pen = target;
  };
  const emit = (bytes, adv) => {
    const last = out[out.length - 1];
    if (last && typeof last === 'object') last.bytes += bytes;
    else out.push({ bytes });
    pen += adv;
  };
  const inserts = (at) => {
    for (const ins of ed.insert) if (ins.before === at) for (const it of ins.items) { moveTo(it.x); emit(it.bytes, it.adv); }
  };
  for (const e of elems) {
    if (e.t === 'num') { x -= e.v * unit; continue; }
    if (e.bytes === undefined) continue;
    for (const c of f.split(e.bytes)) {
      inserts(k);
      const adv = advance(info, c.code);
      if (!ed.drop.has(k)) { moveTo(x + (ed.shift.get(k) || 0)); emit(c.bytes, adv); }
      x += adv;
      k++;
    }
  }
  inserts(k);
  moveTo(x);
  const tj = writeTJ(out.filter((e) => typeof e !== 'number' || Math.abs(e) > 1e-4));
  if (op.op === "'") return `T* ${tj}`;
  if (op.op === '"') return `${num(op.args[0].v)} Tw ${num(op.args[1].v)} Tc T* ${tj}`;
  return tj;
}

// how a line moves when one date in it gets wider or narrower, and whether
// lines on this page end at a common right margin
function lineRule(pageInfo, seg) {
  const b = pageInfo.bounds.get(seg.key);
  if (!b) return { rule: 'left', margin: false };
  const tol = 2;
  const same = pageInfo.segments.filter((s) => s.key === seg.key);
  const atLeft = Math.abs(seg.start - b.min) < tol;
  const atRight = Math.abs(seg.end - b.max) < tol;
  const margin = same.filter((s) => Math.abs(s.end - b.max) < tol).length >= 2;
  const full = same.filter((s) => Math.abs(s.start - b.min) < tol && Math.abs(s.end - b.max) < tol).length;
  if (atLeft && atRight && full >= 2) return { rule: 'justify', margin };
  if (atLeft) return { rule: 'left', margin };
  if (atRight && margin) return { rule: 'right', margin };
  const box = pageInfo.box;
  const pc = (box.x + box.width / 2) * seg.cos + (box.y + box.height / 2) * seg.sin;
  const mid = (seg.start + seg.end) / 2;
  if (Math.abs(mid - (b.min + b.max) / 2) < 1.5 || Math.abs(mid - pc) < 1.5) return { rule: 'center', margin };
  return { rule: atRight ? 'right' : 'left', margin };
}

function tailOf(bytes) {
  const tail = bytesToBinary(bytes.subarray(Math.max(0, bytes.length - 2048)));
  const i = tail.lastIndexOf('startxref');
  if (i < 0) return null;
  const prev = parseInt(tail.slice(i + 9).trim(), 10);
  if (!(prev > 0 && prev < bytes.length)) return null;
  const at = bytesToBinary(bytes.subarray(prev, Math.min(bytes.length, prev + 64)));
  let stream;
  let size = 0;
  if (/^\s*xref/.test(at)) {
    stream = false;
    const rest = bytesToBinary(bytes.subarray(prev));
    const t = rest.indexOf('trailer');
    const m = t >= 0 && rest.slice(t, t + 4096).match(/\/Size\s+(\d+)/);
    if (m) size = Number(m[1]);
  } else if (/^\s*\d+\s+\d+\s+obj/.test(at)) {
    stream = true;
    const m = bytesToBinary(bytes.subarray(prev, Math.min(bytes.length, prev + 4096))).match(/\/Size\s+(\d+)/);
    if (m) size = Number(m[1]);
  } else return null;
  return { prev, stream, size };
}

// the changed and new objects, appended after the original bytes
function appendUpdate(orig, doc, modified, firstNew, tail) {
  const ctx = doc.context;
  const refs = new Map();
  for (const r of modified) refs.set(r.objectNumber, r);
  for (const [r] of ctx.enumerateIndirectObjects()) if (r.objectNumber >= firstNew) refs.set(r.objectNumber, r);
  const list = [...refs.values()].sort((a, b) => a.objectNumber - b.objectNumber);
  const chunks = [];
  let offset = orig.length;
  const push = (u8) => { chunks.push(u8); offset += u8.length; };
  const text = (s) => push(binaryToBytes(s));
  text('\n');
  const entries = [];
  for (const r of list) {
    const obj = ctx.lookup(r);
    entries.push({ n: r.objectNumber, g: r.generationNumber, offset });
    text(`${r.objectNumber} ${r.generationNumber} obj\n`);
    const buf = new Uint8Array(obj.sizeInBytes());
    obj.copyBytesInto(buf, 0);
    push(buf);
    text('\nendobj\n');
  }
  const t = ctx.trailerInfo;
  const common = `/Root ${t.Root}${t.Info ? ` /Info ${t.Info}` : ''}${t.ID ? ` /ID ${t.ID}` : ''} /Prev ${tail.prev}`;
  let size = Math.max(tail.size, ...entries.map((e) => e.n + 1));
  const runs = [];
  for (const e of entries) {
    const r = runs[runs.length - 1];
    if (r && r.start + r.list.length === e.n) r.list.push(e);
    else runs.push({ start: e.n, list: [e] });
  }
  if (!tail.stream) {
    const at = offset;
    let x = 'xref\n';
    for (const r of runs) {
      x += `${r.start} ${r.list.length}\n`;
      for (const e of r.list) x += `${String(e.offset).padStart(10, '0')} ${String(e.g).padStart(5, '0')} n\r\n`;
    }
    x += `trailer\n<< /Size ${size} ${common} >>\nstartxref\n${at}\n%%EOF\n`;
    text(x);
  } else {
    const xn = size;
    size = xn + 1;
    const at = offset;
    const me = { n: xn, g: 0, offset: at };
    const last = runs[runs.length - 1];
    if (last && last.start + last.list.length === xn) last.list.push(me);
    else runs.push({ start: xn, list: [me] });
    const rows = runs.flatMap((r) => r.list);
    const data = new Uint8Array(rows.length * 7);
    rows.forEach((e, i) => {
      const p = i * 7;
      data[p] = 1;
      data[p + 1] = (e.offset >>> 24) & 255; data[p + 2] = (e.offset >>> 16) & 255;
      data[p + 3] = (e.offset >>> 8) & 255; data[p + 4] = e.offset & 255;
      data[p + 5] = (e.g >>> 8) & 255; data[p + 6] = e.g & 255;
    });
    const index = runs.map((r) => `${r.start} ${r.list.length}`).join(' ');
    text(`${xn} 0 obj\n<< /Type /XRef /Size ${size} /W [1 4 2] /Index [${index}] ${common} /Length ${data.length} >>\nstream\n`);
    push(data);
    text(`\nendstream\nendobj\nstartxref\n${at}\n%%EOF\n`);
  }
  const out = new Uint8Array(offset);
  out.set(orig, 0);
  let p = orig.length;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}

function freshName(dict, prefix) {
  for (let i = 1; ; i++) {
    const n = `${prefix}${i}`;
    if (!dict.has(N(n))) return n;
  }
}

// a resources dictionary of its own, with a copied Font dictionary, so a
// dictionary shared with other pages does not change
function ownResources(ctx, res) {
  const own = res instanceof PDFDict ? res.clone(ctx) : ctx.obj({});
  const fonts = own.lookup(N('Font'));
  own.set(N('Font'), fonts instanceof PDFDict ? fonts.clone(ctx) : ctx.obj({}));
  return own;
}

// edits: [{ item, text }]. Returns the new file's bytes.
export async function writePdf(an, edits, { loadFont, reuse = true } = {}) {
  if (!edits.some((e) => e.text !== e.item.text)) return an.bytes;
  try {
    return await build(an, edits, loadFont, reuse);
  } catch (e) {
    if (!reuse) throw e;
    console.warn('retrying without the original font programs', e);
    return build(an, edits, loadFont, false);
  }
}

async function build(an, edits, loadFont, reuse) {
  const doc = await loadDoc(an.bytes);
  const ctx = doc.context;
  const tail = tailOf(an.bytes);
  const firstNew = Math.max(ctx.largestObjectNumber, (tail?.size || 0) - 1) + 1;
  ctx.largestObjectNumber = firstNew - 1;

  const opEdits = new Map();
  const opEdit = (info) => {
    const k = `${info.s}:${info.i}`;
    if (!opEdits.has(k)) opEdits.set(k, { info, drop: new Set(), shift: new Map(), insert: [] });
    return opEdits.get(k);
  };
  const overlays = new Map();
  const fontCache = new Map();
  const overlayFont = async (f, chars) => {
    let key, bytes, hasSpace = true;
    if (reuse && f.programHas(chars)) {
      key = `o:${f.key}`;
      const p = f.programFont();
      bytes = p.bytes;
      hasSpace = p.font.hasGlyphForCodePoint(32);
    } else {
      key = `f:${fallbackFile(f)}`;
      if (!fontCache.has(key)) bytes = await loadFont(fallbackFile(f));
    }
    if (!fontCache.has(key)) fontCache.set(key, { font: trueTypeFont(ctx, bytes, f), hasSpace });
    return fontCache.get(key);
  };

  const bySeg = new Map();
  for (const e of edits) {
    if (e.text === e.item.text) continue;
    if (!bySeg.has(e.item.seg)) bySeg.set(e.item.seg, []);
    bySeg.get(e.item.seg).push(e);
  }
  for (const [seg, list] of bySeg) {
    const G = seg.glyphs;
    const pageInfo = an.pages[list[0].item.page - 1];
    const { rule, margin } = lineRule(pageInfo, seg);
    const b = pageInfo.bounds.get(seg.key);
    // P[j]: word gaps from the start of the line up to glyph j; gapW: their widths
    const P = new Float64Array(G.length);
    const gapW = new Float64Array(G.length);
    for (let j = 1; j < G.length; j++) {
      const prev = G[j - 1];
      const open = G[j].along - (prev.along + prev.len);
      const gap = seg.map[G[j].at - 1] === -1 ? open : isSpace(prev.text) ? prev.len + open : 0;
      P[j] = P[j - 1] + (gap ? 1 : 0);
      gapW[j] = gap;
    }
    const avgGap = (from, to) => {
      let n = 0, w = 0;
      for (let j = from; j <= to; j++) if (gapW[j]) { n++; w += gapW[j]; }
      return n ? w / n : 0;
    };
    const S = new Float64Array(G.length);
    const plans = [];
    for (const { item, text } of list) {
      const { i0, i1 } = item;
      const g0 = G[i0], g1 = G[i1];
      const full = item.pre + text + item.suf;
      const s = g0.along;
      const oldW = g1.along + g1.len - s;
      const plan = await layout(item, full, overlayFont);
      const d = plan.width - oldW;
      const nb = P[i0], na = P[G.length - 1] - P[i1];
      // a word gap may shrink to 60% of itself, never under a fifth of the font size
      const shrinkable = (w) => Math.max(0, w - Math.max(0.6 * w, 0.2 * g0.fs));
      let sb = 0, gb = 0, ga = 0;
      if (rule === 'right') sb = -d;
      else if (rule === 'center') sb = -d / 2;
      else if (rule === 'justify' && nb + na > 0) {
        const w = avgGap(1, G.length - 1);
        gb = ga = Math.max(-w, Math.min(d / (nb + na), shrinkable(w)));
      } else if (b && margin && d > 0 && na > 0) {
        // a longer date would push the line past the right margin: take the extra from its word gaps
        const over = seg.end + d - b.max;
        if (over > 0.5) ga = Math.min(over / na, shrinkable(avgGap(i1 + 1, G.length - 1)));
      }
      const ds = sb - gb * nb;
      for (let j = 0; j < G.length; j++) {
        if (j >= i0 && j <= i1) continue;
        S[j] += j < i0 ? sb - gb * P[j] : ds + d - ga * (P[j] - P[i1]);
      }
      plans.push({ item, plan, s, ds });
    }
    for (const { item, plan, s, ds } of plans) {
      const { i0, i1 } = item;
      for (let j = i0; j <= i1; j++) for (const g of [G[j], ...(G[j].twins || [])]) opEdit(g.o).drop.add(g.k);
      const base = s + S[i0] + ds; // where the new date starts, in page units along the line
      for (const run of plan.runs) {
        const ref = run.ref, info = ref.o;
        const toX = (x) => ref.tx + (base + x - ref.along) / info.sx;
        if (run.mode === 'same') {
          opEdit(info).insert.push({ before: ref.k, items: run.items.map((it) => ({ bytes: it.bytes, adv: it.adv, x: toX(it.x) })) });
          continue;
        }
        const unit = (info.size * info.th) / 1000;
        const x0 = toX(run.items[0].x);
        const elems = [];
        let pen = x0;
        for (const it of run.items) {
          const x = toX(it.x);
          if (Math.abs(x - pen) > 1e-7) elems.push(num(-(x - pen) / unit));
          elems.push(it.hex);
          pen = x + it.adv;
        }
        if (!overlays.has(info.s)) overlays.set(info.s, []);
        overlays.get(info.s).push({ info, x: x0, tj: `[${elems.join(' ')}] TJ`, font: run.font });
      }
    }
    for (let j = 0; j < G.length; j++) {
      if (Math.abs(S[j]) < 1e-4 || list.some((e) => j >= e.item.i0 && j <= e.item.i1)) continue;
      for (const g of [G[j], ...(G[j].twins || [])]) opEdit(g.o).shift.set(g.k, S[j] / g.o.sx);
    }
  }

  // write the changed streams
  const byStream = new Map();
  for (const ed of opEdits.values()) {
    if (!byStream.has(ed.info.s)) byStream.set(ed.info.s, []);
    byStream.get(ed.info.s).push(ed);
  }
  for (const k of overlays.keys()) if (!byStream.has(k)) byStream.set(k, []);
  const modified = new Set();
  const pages = doc.getPages();
  for (const [key, eds] of byStream) {
    const st = an.env.streams.get(key);
    eds.sort((p, q) => st.ops[p.info.i].start - st.ops[q.info.i].start);
    let src = '';
    let at = 0;
    for (const ed of eds) {
      const op = st.ops[ed.info.i];
      src += st.src.slice(at, op.start) + rebuildOp(op, ed);
      at = op.end;
    }
    src += st.src.slice(at);
    let res = null;
    const over = overlays.get(key);
    if (over) {
      res = ownResources(ctx, st.resources);
      const fonts = res.lookup(N('Font'));
      let extra = '';
      for (const o of over) {
        const name = freshName(fonts, 'DtF');
        fonts.set(N(name), o.font.ref);
        const tm = mul([1, 0, 0, 1, o.x, 0], o.info.tm);
        extra += `q ${o.info.lctm.map(num).join(' ')} cm ${o.info.fill} BT /${name} ${num(o.info.size)} Tf ${num(o.info.tc)} Tc 0 Tw ${num(o.info.th * 100)} Tz ${num(o.info.ts)} Ts 0 Tr ${tm.map(num).join(' ')} Tm ${o.tj} ET Q\n`;
      }
      src = `q\n${src}\n${st.btOpen ? 'ET\n' : ''}${'Q\n'.repeat(st.qEnd)}Q\n${extra}`;
    }
    const bytes = binaryToBytes(src);
    if (key[0] === 'p') {
      const page = pages[st.page];
      page.node.set(N('Contents'), ctx.register(ctx.flateStream(bytes)));
      if (res) page.node.set(N('Resources'), res);
      modified.add(page.ref);
    } else {
      const old = ctx.lookup(st.ref);
      const dict = {};
      for (const [k, v] of old.dict.entries()) {
        const n = k.decodeText();
        if (!['Length', 'Filter', 'DecodeParms'].includes(n)) dict[n] = v;
      }
      if (res) dict.Resources = res;
      ctx.assign(st.ref, ctx.flateStream(bytes, dict));
      modified.add(st.ref);
    }
  }
  for (const { font } of fontCache.values()) font.finish();
  if (!tail) return doc.save({ useObjectStreams: false, updateFieldAppearances: false });
  return appendUpdate(an.bytes, doc, modified, firstNew, tail);
}
