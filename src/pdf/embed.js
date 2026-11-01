// Putting a TrueType font into a PDF, with only the letters it needs.
//
// The glyphs that are not needed are emptied rather than removed, so every
// glyph keeps its number and the codes in the PDF are the font's own glyph
// numbers (Identity-H). pdf-lib's own subsetting drew most letters blank in
// macOS Preview, which is why this exists.
import { PDFName, PDFString } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

const KEEP = ['OS/2', 'cmap', 'cvt ', 'fpgm', 'gasp', 'glyf', 'head', 'hhea', 'hmtx', 'loca', 'maxp', 'name', 'post', 'prep'];

function tables(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = v.getUint32(0);
  if (version !== 0x00010000 && version !== 0x74727565) throw new Error('not a TrueType font');
  const n = v.getUint16(4);
  const out = {};
  for (let i = 0; i < n; i++) {
    const p = 12 + i * 16;
    const tag = String.fromCharCode(bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3]);
    out[tag] = bytes.subarray(v.getUint32(p + 8), v.getUint32(p + 8) + v.getUint32(p + 12));
  }
  for (const t of ['head', 'hhea', 'hmtx', 'loca', 'glyf', 'maxp']) if (!out[t]) throw new Error(`font has no ${t} table`);
  return out;
}

const view = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);

// glyph number -> bytes of outline data (0 for an empty glyph), for a TrueType file
export function outlineSizes(bytes) {
  const t = tables(bytes);
  const n = view(t.maxp).getUint16(4);
  const long = view(t.head).getInt16(50) === 1;
  const lv = view(t.loca);
  const loc = (g) => (long ? lv.getUint32(g * 4) : lv.getUint16(g * 2) * 2);
  return (g) => (g >= 0 && g < n && (g + 1) * (long ? 4 : 2) < t.loca.length ? Math.max(0, loc(g + 1) - loc(g)) : 0);
}

function checksum(b) {
  let sum = 0;
  const padded = new Uint8Array((b.length + 3) & ~3);
  padded.set(b);
  const v = view(padded);
  for (let i = 0; i < padded.length; i += 4) sum = (sum + v.getUint32(i)) >>> 0;
  return sum;
}

// a font file with only `keep` glyphs drawn
function subsetFont(t, keep) {
  const numGlyphs = view(t.maxp).getUint16(4);
  const long = view(t.head).getInt16(50) === 1;
  const lv = view(t.loca);
  const loc = (g) => (long ? lv.getUint32(g * 4) : lv.getUint16(g * 2) * 2);
  const glyph = (g) => (g < numGlyphs ? t.glyf.subarray(loc(g), Math.max(loc(g), loc(g + 1))) : new Uint8Array(0));
  // composite glyphs need their parts
  const todo = [...keep];
  while (todo.length) {
    const g = todo.pop();
    const d = glyph(g);
    if (d.length < 10 || view(d).getInt16(0) >= 0) continue;
    const v = view(d);
    let p = 10;
    for (;;) {
      const flags = v.getUint16(p);
      const part = v.getUint16(p + 2);
      if (!keep.has(part)) { keep.add(part); todo.push(part); }
      p += 4 + (flags & 1 ? 4 : 2) + (flags & 8 ? 2 : flags & 0x40 ? 4 : flags & 0x80 ? 8 : 0);
      if (!(flags & 0x20) || p + 4 > d.length) break;
    }
  }
  const parts = [];
  const loca = new Uint8Array((numGlyphs + 1) * 4);
  const lw = view(loca);
  let off = 0;
  for (let g = 0; g < numGlyphs; g++) {
    lw.setUint32(g * 4, off);
    if (!keep.has(g)) continue;
    const d = glyph(g);
    parts.push(d);
    off += d.length;
    if (off % 4) { parts.push(new Uint8Array(4 - (off % 4))); off += 4 - (off % 4); }
  }
  lw.setUint32(numGlyphs * 4, off);
  const glyf = new Uint8Array(off);
  let p = 0;
  for (const d of parts) { glyf.set(d, p); p += d.length; }
  const head = t.head.slice();
  view(head).setUint32(8, 0);
  view(head).setInt16(50, 1);
  const out = { ...t, glyf, loca, head };
  if (t.post && t.post.length >= 32) {
    const post = t.post.slice(0, 32);
    view(post).setUint32(0, 0x00030000);
    out.post = post;
  }
  const tags = KEEP.filter((k) => out[k]);
  const n = tags.length;
  let sr = 1, es = 0;
  while (sr * 2 <= n) { sr *= 2; es++; }
  let size = 12 + n * 16;
  for (const k of tags) size += (out[k].length + 3) & ~3;
  const file = new Uint8Array(size);
  const fv = view(file);
  fv.setUint32(0, 0x00010000);
  fv.setUint16(4, n); fv.setUint16(6, sr * 16); fv.setUint16(8, es); fv.setUint16(10, n * 16 - sr * 16);
  let at = 12 + n * 16;
  let headAt = 0;
  tags.forEach((k, i) => {
    const d = out[k];
    const e = 12 + i * 16;
    for (let j = 0; j < 4; j++) file[e + j] = k.charCodeAt(j);
    fv.setUint32(e + 4, checksum(d));
    fv.setUint32(e + 8, at);
    fv.setUint32(e + 12, d.length);
    file.set(d, at);
    if (k === 'head') headAt = at;
    at += (d.length + 3) & ~3;
  });
  fv.setUint32(headAt + 8, (0xb1b0afba - checksum(file)) >>> 0);
  return file;
}

let tagCount = 0;
function tag() {
  let n = ++tagCount + Math.floor(Math.random() * 1e6);
  let s = '';
  for (let i = 0; i < 6; i++) { s += String.fromCharCode(65 + (n % 26)); n = Math.floor(n / 26); }
  return s;
}

// One font to draw new text with. Text is encoded while the page content is
// written; `finish()` then writes the font objects with the letters used.
export function trueTypeFont(ctx, bytes, style = {}) {
  const t = tables(bytes);
  const font = fontkit.create(bytes);
  const upm = view(t.head).getUint16(18) || 1000;
  const nh = view(t.hhea).getUint16(34);
  const hm = view(t.hmtx);
  const advance = (g) => hm.getUint16(4 * Math.min(g, nh - 1)) * (1000 / upm);
  const used = new Map(); // gid -> text
  const ref = ctx.nextRef();
  const gidOf = (ch) => font.glyphForCodePoint(ch.codePointAt(0)).id;
  return {
    ref,
    has: (ch) => font.hasGlyphForCodePoint(ch.codePointAt(0)),
    // <hex> codes, and the number of glyphs
    encode(text) {
      let hex = '';
      let n = 0;
      for (const ch of text) {
        const g = gidOf(ch);
        if (!used.has(g)) used.set(g, ch);
        hex += g.toString(16).padStart(4, '0');
        n++;
      }
      return { hex: `<${hex.toUpperCase()}>`, n };
    },
    width: (text) => [...text].reduce((w, ch) => w + advance(gidOf(ch)), 0),
    finish() {
      const keep = new Set([0, ...used.keys()]);
      const file = subsetFont(t, keep);
      const get = (k, d) => { try { const v = font[k]; return Number.isFinite(v) ? v : d; } catch { return d; } };
      let ps = 'Font';
      try { ps = (font.postscriptName || font.fullName || 'Font').replace(/[^A-Za-z0-9-]/g, ''); } catch {}
      const name = PDFName.of(`${tag()}+${ps || 'Font'}`);
      const s = 1000 / upm;
      let bbox = [0, -200, 1000, 900];
      try { const b = font.bbox; bbox = [b.minX, b.minY, b.maxX, b.maxY].map((x) => Math.round(x * s)); } catch {}
      const flags = 32 | (style.mono ? 1 : 0) | (style.serif ? 2 : 0) | (style.italic ? 64 : 0);
      const descriptor = ctx.register(ctx.obj({
        Type: 'FontDescriptor', FontName: name, Flags: flags, FontBBox: bbox,
        ItalicAngle: get('italicAngle', 0), Ascent: Math.round(get('ascent', 800) * s), Descent: Math.round(get('descent', -200) * s),
        CapHeight: Math.round(get('capHeight', 700) * s), StemV: style.bold ? 120 : 80,
        FontFile2: ctx.register(ctx.flateStream(file, { Length1: file.length })),
      }));
      const gids = [...used.keys()].sort((a, b) => a - b);
      const W = [];
      for (const g of gids) W.push(g, [Math.round(advance(g) * 100) / 100]);
      const cid = ctx.register(ctx.obj({
        Type: 'Font', Subtype: 'CIDFontType2', BaseFont: name,
        CIDSystemInfo: { Registry: PDFString.of('Adobe'), Ordering: PDFString.of('Identity'), Supplement: 0 },
        FontDescriptor: descriptor, W, DW: 1000, CIDToGIDMap: 'Identity',
      }));
      let cmap = '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n';
      for (let i = 0; i < gids.length; i += 100) {
        const chunk = gids.slice(i, i + 100);
        cmap += `${chunk.length} beginbfchar\n`;
        for (const g of chunk) {
          const ch = used.get(g);
          let u = '';
          for (let k = 0; k < ch.length; k++) u += ch.charCodeAt(k).toString(16).padStart(4, '0');
          cmap += `<${g.toString(16).padStart(4, '0').toUpperCase()}> <${u.toUpperCase()}>\n`;
        }
        cmap += 'endbfchar\n';
      }
      cmap += 'endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n';
      const toUnicode = ctx.register(ctx.flateStream(new TextEncoder().encode(cmap)));
      ctx.assign(ref, ctx.obj({
        Type: 'Font', Subtype: 'Type0', BaseFont: name, Encoding: 'Identity-H',
        DescendantFonts: [cid], ToUnicode: toUnicode,
      }));
    },
  };
}
