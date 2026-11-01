// PDF fonts: how a string's bytes split into character codes, how wide each
// code is, which text it stands for, and which code writes a given character.
import { PDFName, PDFDict, PDFArray, PDFNumber, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { Font, Encodings } from '@pdf-lib/standard-fonts';
import fontkit from '@pdf-lib/fontkit';
import { parseOps, bytesToBinary } from './lexer.js';
import { outlineSizes } from './embed.js';

const N = (k) => PDFName.of(k);
const nameOf = (v) => (v instanceof PDFName ? v.decodeText() : null);
const numOf = (v, d = 0) => (v instanceof PDFNumber ? v.asNumber() : d);

export function streamBinary(stream) {
  if (!(stream instanceof PDFRawStream)) return '';
  return bytesToBinary(decodePDFRawStream(stream).decode());
}

// glyph names -> text. The first name wins: WinAnsi lists both U+0020 and
// U+00A0 as "space", and its Latin names win over Symbol's.
const GLYPH_UNI = new Map();
for (const enc of [Encodings.WinAnsi, Encodings.Symbol, Encodings.ZapfDingbats]) {
  for (const [cp, [, name]] of Object.entries(enc.unicodeMappings)) if (!GLYPH_UNI.has(name)) GLYPH_UNI.set(name, String.fromCodePoint(Number(cp)));
}
Object.entries({
  Alphatonos: 0x386, Epsilontonos: 0x388, Etatonos: 0x389, Iotatonos: 0x38a, Omicrontonos: 0x38c,
  Upsilontonos: 0x38e, Omegatonos: 0x38f, iotadieresistonos: 0x390, Iotadieresis: 0x3aa,
  Upsilondieresis: 0x3ab, alphatonos: 0x3ac, epsilontonos: 0x3ad, etatonos: 0x3ae, iotatonos: 0x3af,
  upsilondieresistonos: 0x3b0, iotadieresis: 0x3ca, upsilondieresis: 0x3cb, omicrontonos: 0x3cc,
  upsilontonos: 0x3cd, omegatonos: 0x3ce, tonos: 0x384, dieresistonos: 0x385, anoteleia: 0x387,
  sigma1: 0x3c2, sigmafinal: 0x3c2, mu: 0x3bc, Omega: 0x3a9, Delta: 0x394,
}).forEach(([n, cp]) => GLYPH_UNI.set(n, String.fromCodePoint(cp)));

export function glyphText(name) {
  if (!name) return '';
  if (GLYPH_UNI.has(name)) return GLYPH_UNI.get(name);
  const base = name.split('.')[0].split('_');
  let out = '';
  for (const part of base) {
    let m;
    if ((m = part.match(/^uni((?:[0-9A-F]{4})+)$/))) {
      for (let i = 0; i < m[1].length; i += 4) out += String.fromCharCode(parseInt(m[1].substr(i, 4), 16));
    } else if ((m = part.match(/^u([0-9A-F]{4,6})$/))) out += String.fromCodePoint(parseInt(m[1], 16));
    else if (GLYPH_UNI.has(part)) out += GLYPH_UNI.get(part);
    else return '';
  }
  return out;
}

// base encodings as code -> glyph name
const WIN_NAMES = new Array(256);
for (const [, [code, name]] of Object.entries(Encodings.WinAnsi.unicodeMappings)) WIN_NAMES[code] = name;
const SYMBOL_NAMES = new Array(256);
for (const [, [code, name]] of Object.entries(Encodings.Symbol.unicodeMappings)) SYMBOL_NAMES[code] = name;
const STD_NAMES = new Array(256);
for (let c = 32; c < 127; c++) STD_NAMES[c] = WIN_NAMES[c];
STD_NAMES[39] = 'quoteright';
STD_NAMES[96] = 'quoteleft';
const WIN_UNI_NAME = new Map(Object.entries(Encodings.WinAnsi.unicodeMappings).map(([cp, [, n]]) => [Number(cp), n]));
const MAC_NAMES = new Array(256);
{
  const dec = new TextDecoder('macintosh');
  for (let c = 32; c < 256; c++) {
    const ch = dec.decode(new Uint8Array([c]));
    MAC_NAMES[c] = WIN_UNI_NAME.get(ch.codePointAt(0)) || [...GLYPH_UNI].find(([, u]) => u === ch)?.[0];
  }
}
const BASE = { WinAnsiEncoding: WIN_NAMES, MacRomanEncoding: MAC_NAMES, StandardEncoding: STD_NAMES };

// the 14 fonts every PDF reader has, by the names files use for them
function standardName(base) {
  const n = base.replace(/[\s,_-]/g, '').toLowerCase();
  const bold = /bold|black|heavy/.test(n);
  const italic = /italic|oblique/.test(n);
  const style = (b, i, bi, r) => (bold && italic ? bi : bold ? b : italic ? i : r);
  if (/^(helvetica|arial)/.test(n)) return style('Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique', 'Helvetica');
  if (/^times/.test(n)) return style('Times-Bold', 'Times-Italic', 'Times-BoldItalic', 'Times-Roman');
  if (/^courier/.test(n)) return style('Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique', 'Courier');
  if (/^symbol/.test(n)) return 'Symbol';
  if (/^zapfdingbats/.test(n)) return 'ZapfDingbats';
  return null;
}
const stdCache = new Map();
function standardFont(name) {
  if (!stdCache.has(name)) stdCache.set(name, Font.load(name));
  return stdCache.get(name);
}

// A CMap stream (ToUnicode or an embedded CID encoding)
function parseCMap(src) {
  const ops = parseOps(src);
  const toNum = (b) => { let n = 0; for (let i = 0; i < b.length; i++) n = n * 256 + b.charCodeAt(i); return n; };
  const utf16 = (b) => {
    let s = '';
    if (b.length === 1) return String.fromCharCode(b.charCodeAt(0));
    for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode((b.charCodeAt(i) << 8) | b.charCodeAt(i + 1));
    return s;
  };
  const out = { spaces: [], uni: new Map(), uniRanges: [], cid: new Map(), cidRanges: [], usecmap: null };
  for (let i = 0; i < ops.length; i++) {
    const { op, args } = ops[i];
    const vals = args;
    if (op === 'usecmap' && vals[0]?.t === 'name') out.usecmap = vals[0].v;
    if (op === 'endcodespacerange') {
      for (let k = 0; k + 1 < vals.length; k += 2) {
        const lo = vals[k].bytes, hi = vals[k + 1].bytes;
        if (lo === undefined || hi === undefined) continue;
        out.spaces.push({ len: lo.length, lo: [...lo].map((c) => c.charCodeAt(0)), hi: [...hi].map((c) => c.charCodeAt(0)) });
      }
    } else if (op === 'endbfchar') {
      for (let k = 0; k + 1 < vals.length; k += 2) {
        if (vals[k].bytes === undefined) continue;
        const dst = vals[k + 1];
        out.uni.set(toNum(vals[k].bytes), dst.bytes !== undefined ? utf16(dst.bytes) : dst.t === 'name' ? glyphText(dst.v) : '');
      }
    } else if (op === 'endbfrange') {
      for (let k = 0; k + 2 < vals.length; k += 3) {
        const lo = vals[k].bytes, hi = vals[k + 1].bytes, dst = vals[k + 2];
        if (lo === undefined || hi === undefined) continue;
        out.uniRanges.push({ lo: toNum(lo), hi: toNum(hi), dst: dst.t === 'arr' ? dst.v.map((d) => utf16(d.bytes ?? '')) : utf16(dst.bytes ?? '') });
      }
    } else if (op === 'endcidchar') {
      for (let k = 0; k + 1 < vals.length; k += 2) if (vals[k].bytes !== undefined) out.cid.set(toNum(vals[k].bytes), vals[k + 1].v);
    } else if (op === 'endcidrange') {
      for (let k = 0; k + 2 < vals.length; k += 3) {
        if (vals[k].bytes === undefined) continue;
        out.cidRanges.push({ lo: toNum(vals[k].bytes), hi: toNum(vals[k + 1].bytes), cid: vals[k + 2].v });
      }
    }
  }
  return out;
}

function lookupRangeUni(ranges, code) {
  for (const r of ranges) {
    if (code < r.lo || code > r.hi) continue;
    if (Array.isArray(r.dst)) return r.dst[code - r.lo] ?? '';
    if (!r.dst) return '';
    const last = r.dst.charCodeAt(r.dst.length - 1) + (code - r.lo);
    return r.dst.slice(0, -1) + String.fromCharCode(last);
  }
  return undefined;
}

const clean = (s) => (s || '').replace(/[\0-\x1f\x7f�]/g, '').normalize('NFC');

// Everything the rest of the code needs from one font dictionary.
export function loadFont(ctx, dict, key) {
  const get = (d, k) => d && d.lookup(N(k));
  const subtype = nameOf(get(dict, 'Subtype')) || 'Type1';
  const baseFont = nameOf(get(dict, 'BaseFont')) || '';
  const base = baseFont.replace(/^[A-Z]{6}\+/, '');
  const f = {
    key, dict, subtype, baseFont, base, supported: true, vertical: false, oneByte: true,
    used: new Map(), // text -> { code, bytes } for codes this file already draws
    embedded: false, program: null,
  };
  let desc = null;
  let fd;
  if (subtype === 'Type0') {
    const dfs = get(dict, 'DescendantFonts');
    desc = dfs instanceof PDFArray ? ctx.lookup(dfs.get(0)) : null;
    if (!(desc instanceof PDFDict)) desc = null;
    fd = desc && get(desc, 'FontDescriptor');
  } else {
    fd = get(dict, 'FontDescriptor');
  }
  if (!(fd instanceof PDFDict)) fd = null;
  f.descriptor = fd;
  const flags = fd ? numOf(get(fd, 'Flags')) : 0;
  const weight = fd ? numOf(get(fd, 'FontWeight')) : 0;
  const italicAngle = fd ? numOf(get(fd, 'ItalicAngle')) : 0;
  f.bold = /bold|black|heavy|semibold|demi/i.test(base) || weight >= 600 || !!(flags & (1 << 18));
  f.italic = /italic|oblique/i.test(base) || italicAngle !== 0 || !!(flags & 64);
  f.mono = /mono|courier|consol|menlo|monaco|cousine/i.test(base) || !!(flags & 1);
  f.serif = !/sans/i.test(base) && (/times|tinos|cambria|georgia|garamond|serif|minion|palatino|antiqua|century|baskerville|didot|bodoni|liberationserif|noto ?serif/i.test(base) || !!(flags & 2));
  for (const k of ['FontFile2', 'FontFile3', 'FontFile']) {
    const s = fd && get(fd, k);
    if (s instanceof PDFRawStream) {
      f.embedded = true;
      const sub = nameOf(s.dict.lookup(N('Subtype')));
      f.programKind = k === 'FontFile2' ? 'truetype' : k === 'FontFile' ? 'type1' : sub === 'OpenType' ? 'opentype' : 'cff';
      f.programStream = s;
      break;
    }
  }

  // text for each code
  const tu = get(dict, 'ToUnicode');
  const cmapU = tu instanceof PDFRawStream ? parseCMap(streamBinary(tu)) : null;

  if (subtype === 'Type0') {
    f.oneByte = false;
    const enc = get(dict, 'Encoding');
    let spaces = [{ len: 2, lo: [0, 0], hi: [255, 255] }];
    let toCid = (code) => code;
    if (enc instanceof PDFName) {
      const n = enc.decodeText();
      if (n === 'Identity-V') f.vertical = true;
      else if (n !== 'Identity-H') f.supported = false;
    } else if (enc instanceof PDFRawStream) {
      const cm = parseCMap(streamBinary(enc));
      if (numOf(enc.dict.lookup(N('WMode'))) === 1) f.vertical = true;
      if (cm.spaces.length) spaces = cm.spaces;
      if (cm.usecmap && cm.usecmap !== 'Identity-H' && cm.usecmap !== 'Identity-V') f.supported = false;
      if (!cm.usecmap && (cm.cid.size || cm.cidRanges.length)) {
        toCid = (code) => {
          if (cm.cid.has(code)) return cm.cid.get(code);
          for (const r of cm.cidRanges) if (code >= r.lo && code <= r.hi) return r.cid + code - r.lo;
          return 0;
        };
      }
    } else f.supported = false;
    f.spaces = spaces;
    // widths by CID
    const W = new Map();
    const dw = desc ? numOf(get(desc, 'DW'), 1000) : 1000;
    const w = desc && get(desc, 'W');
    if (w instanceof PDFArray) {
      const a = w.asArray().map((x) => ctx.lookup(x));
      for (let i = 0; i < a.length;) {
        const first = numOf(a[i]);
        if (a[i + 1] instanceof PDFArray) {
          a[i + 1].asArray().forEach((x, j) => W.set(first + j, numOf(ctx.lookup(x))));
          i += 2;
        } else {
          const last = numOf(a[i + 1]);
          const v = numOf(a[i + 2]);
          for (let c = first; c <= last && c - first < 65536; c++) W.set(c, v);
          i += 3;
        }
      }
    }
    f.width = (code) => { const cid = toCid(code); return W.has(cid) ? W.get(cid) : dw; };
    f.text = (code) => {
      if (cmapU) {
        if (cmapU.uni.has(code)) return clean(cmapU.uni.get(code));
        const r = lookupRangeUni(cmapU.uniRanges, code);
        if (r !== undefined) return clean(r);
      }
      return '';
    };
  } else {
    f.spaces = null;
    // widths
    const first = numOf(get(dict, 'FirstChar'));
    const widths = get(dict, 'Widths');
    const missing = fd ? numOf(get(fd, 'MissingWidth')) : 0;
    let scale = 1;
    if (subtype === 'Type3') {
      const fm = get(dict, 'FontMatrix');
      scale = fm instanceof PDFArray ? numOf(ctx.lookup(fm.get(0)), 0.001) * 1000 : 1;
    }
    const wa = widths instanceof PDFArray ? widths.asArray().map((x) => numOf(ctx.lookup(x))) : null;
    // glyph name for each code
    const names = new Array(256);
    const enc = get(dict, 'Encoding');
    const std = !f.embedded && subtype !== 'Type3' ? standardName(base) : null;
    let baseNames = std === 'Symbol' ? SYMBOL_NAMES : STD_NAMES;
    if (subtype === 'TrueType' && !(flags & 4)) baseNames = WIN_NAMES;
    let diffs = null;
    if (enc instanceof PDFName) baseNames = BASE[enc.decodeText()] || baseNames;
    else if (enc instanceof PDFDict) {
      const be = nameOf(get(enc, 'BaseEncoding'));
      if (be && BASE[be]) baseNames = BASE[be];
      diffs = get(enc, 'Differences');
    }
    for (let c = 0; c < 256; c++) names[c] = baseNames[c];
    if (diffs instanceof PDFArray) {
      let c = 0;
      for (const x of diffs.asArray().map((v) => ctx.lookup(v))) {
        if (x instanceof PDFNumber) c = x.asNumber();
        else if (x instanceof PDFName) names[c++ & 255] = x.decodeText();
      }
    }
    f.names = names;
    const stdFont = std && !wa ? standardFont(std) : null;
    f.width = (code) => {
      if (wa && code >= first && code < first + wa.length) return wa[code - first] * scale;
      if (stdFont) { const n = names[code]; return n ? stdFont.getWidthOfGlyph(n) || 0 : 0; }
      return missing * scale;
    };
    f.text = (code) => {
      if (cmapU) {
        if (cmapU.uni.has(code)) return clean(cmapU.uni.get(code));
        const r = lookupRangeUni(cmapU.uniRanges, code);
        if (r !== undefined) return clean(r);
      }
      return clean(glyphText(names[code]));
    };
    // a font the reader supplies can draw any code of its encoding
    if (!f.embedded && subtype !== 'Type3') {
      f.anyCode = new Map();
      for (let c = 255; c >= 32; c--) {
        const t = f.text(c);
        if (t.length === 1 && f.width(c) > 0) f.anyCode.set(t, { code: c, bytes: String.fromCharCode(c) });
      }
    }
  }

  // bytes -> [{ code, bytes }]
  f.split = (bytes) => {
    const out = [];
    if (f.oneByte) {
      for (let i = 0; i < bytes.length; i++) out.push({ code: bytes.charCodeAt(i), bytes: bytes[i] });
      return out;
    }
    for (let i = 0; i < bytes.length;) {
      let len = 0;
      for (let n = 1; n <= 4 && !len; n++) {
        if (i + n > bytes.length) break;
        for (const sp of f.spaces) {
          if (sp.len !== n) continue;
          let ok = true;
          for (let j = 0; j < n; j++) {
            const b = bytes.charCodeAt(i + j);
            if (b < sp.lo[j] || b > sp.hi[j]) { ok = false; break; }
          }
          if (ok) { len = n; break; }
        }
      }
      if (!len) len = Math.min(f.spaces[0]?.len || 2, bytes.length - i);
      let code = 0;
      for (let j = 0; j < len; j++) code = code * 256 + bytes.charCodeAt(i + j);
      out.push({ code, bytes: bytes.slice(i, i + len) });
      i += len;
    }
    return out;
  };

  f.use = (code, bytes, text) => {
    if (text.length === 1 && !f.used.has(text)) f.used.set(text, { code, bytes });
  };
  // the code for one character, if this font can draw it as it is
  f.encode = (ch) => f.used.get(ch) || f.anyCode?.get(ch) || null;

  // the embedded font program, as a fontkit font, if it can draw text itself
  let parsed;
  f.programFont = () => {
    if (parsed !== undefined) return parsed;
    parsed = null;
    if (f.programStream && (f.programKind === 'truetype' || f.programKind === 'opentype')) {
      try {
        const bytes = decodePDFRawStream(f.programStream).decode();
        const font = fontkit.create(bytes);
        let size = () => 1;
        try { size = outlineSizes(bytes); } catch {}
        if (font && font.characterSet?.length) parsed = { font, bytes, size };
      } catch {
        parsed = null;
      }
    }
    return parsed;
  };
  // Can the embedded program draw `text`? Subsets often keep a character
  // table that no longer matches their glyphs, so it has to agree with how
  // this file already uses the font: each character its own glyph, and for
  // fonts whose codes are glyph numbers, the same glyph the file draws.
  const cidToGid = desc && get(desc, 'CIDToGIDMap');
  const identity = subtype === 'Type0' && nameOf(get(desc, 'Subtype')) === 'CIDFontType2' && (!cidToGid || nameOf(cidToGid) === 'Identity');
  f.programHas = (text) => {
    const p = f.programFont();
    if (!p) return false;
    const gid = (ch) => p.font.glyphForCodePoint(ch.codePointAt(0)).id;
    const want = [...new Set(text)].filter((c) => !/\s/.test(c));
    const seen = new Map();
    for (const ch of want) {
      const g = gid(ch);
      if (g <= 0 || g >= p.font.numGlyphs || !p.size(g) || seen.has(g)) return false;
      seen.set(g, ch);
    }
    for (const [ch, { code }] of f.used) {
      if (/\s/.test(ch)) continue;
      const g = gid(ch);
      if (identity && g !== code) return false;
      if (seen.has(g) && seen.get(g) !== ch) return false;
      seen.set(g, ch);
    }
    return true;
  };
  return f;
}
