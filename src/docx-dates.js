// Find dates inside a .docx and write new ones back, touching nothing else.
//
// Word stores text in <w:t> pieces that can split a single date over several
// pieces ("15 Οκτ" + "ωβρίου 2026"). Each paragraph's pieces are joined, dates
// are found in the joined text, and an edit is written back by changing only
// the characters inside those <w:t> elements. Every other byte of the XML
// stays as it was.
import { findDates, formatLike } from './dates.js';

export const TEXT_PARTS = /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/;

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export function decodeXml(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e) => {
    if (e[0] !== '#') return ENT[e];
    return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  });
}
export function encodeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? decodeXml(m[1]) : null;
}

function partLabel(part) {
  if (/header/.test(part)) return 'Κεφαλίδα';
  if (/footer/.test(part)) return 'Υποσέλιδο';
  if (/footnotes/.test(part)) return 'Υποσημείωση';
  if (/endnotes/.test(part)) return 'Σημείωση τέλους';
  return 'Κείμενο';
}

// Paragraphs of one XML part, each with its <w:t> pieces and where it sits.
export function scanPart(xml, part) {
  const paras = [];
  const pStack = [];
  const ctx = { tbl: 0, txbx: 0, ac: [], shape: [], skip: 0 };
  let acCount = 0;
  let pageNo = 1;
  let topCount = 0; // paragraphs directly in the body
  const tagRe = /<(\/?)([A-Za-z][\w.-]*:[\w.-]+|[A-Za-z][\w.-]*)([^>]*?)(\/?)>/g;
  let m;
  while ((m = tagRe.exec(xml))) {
    const [tag, close, name, , selfClose] = m;
    const at = m.index;
    if (name === 'w:p') {
      if (close) {
        const p = pStack.pop();
        if (p) p.end = at + tag.length;
      } else if (!selfClose) {
        const branch = ctx.ac.length ? ctx.ac[ctx.ac.length - 1] : null;
        const p = {
          index: paras.length, start: at, pieces: [], text: '',
          where: ctx.txbx ? 'textbox' : ctx.tbl ? 'table' : 'body',
          shape: ctx.shape.length ? ctx.shape[ctx.shape.length - 1] : null,
          ac: branch ? { id: branch.id, branch: branch.branch } : null,
          part, page: pageNo, depth: pStack.length,
          top: pStack.length ? pStack[0].top : ++topCount,
        };
        paras.push(p);
        pStack.push(p);
      }
      continue;
    }
    const cur = pStack[pStack.length - 1];
    switch (name) {
      case 'w:tbl': ctx.tbl += close ? -1 : selfClose ? 0 : 1; break;
      case 'w:txbxContent': ctx.txbx += close ? -1 : selfClose ? 0 : 1; break;
      case 'mc:AlternateContent':
        if (close) ctx.ac.pop();
        else if (!selfClose) ctx.ac.push({ id: acCount++, branch: null });
        break;
      case 'mc:Choice': case 'mc:Fallback':
        if (!close && !selfClose && ctx.ac.length) ctx.ac[ctx.ac.length - 1].branch = name === 'mc:Choice' ? 'choice' : 'fallback';
        break;
      case 'wp:anchor': case 'wp:inline': case 'v:shape': case 'v:rect': case 'v:textbox':
        if (close) ctx.shape.pop();
        else if (!selfClose) ctx.shape.push(null);
        break;
      case 'wp:docPr':
        if (!close && ctx.shape.length) ctx.shape[ctx.shape.length - 1] = attr(tag, 'name');
        break;
      case 'w:br':
        if (cur) cur.pieces.push({ sep: '\n' }), (cur.text += '\n');
        if (attr(tag, 'w:type') === 'page' && !ctx.txbx) pageNo++;
        break;
      case 'w:pageBreakBefore':
        if (cur && !ctx.txbx && cur.depth === 0 && paras.length > 1 && attr(tag, 'w:val') !== '0' && attr(tag, 'w:val') !== 'false') {
          if (!cur.pageCounted) { pageNo++; cur.page = pageNo; cur.pageCounted = true; }
        }
        break;
      case 'w:tab': case 'w:cr': case 'w:noBreakHyphen':
        if (cur && !close) cur.pieces.push({ sep: name === 'w:tab' ? '\t' : name === 'w:cr' ? '\n' : '-' }), (cur.text += name === 'w:tab' ? '\t' : name === 'w:cr' ? '\n' : '-');
        break;
      case 'w:t': {
        if (close || selfClose || !cur) break;
        const contentStart = at + tag.length;
        const endTag = xml.indexOf('</w:t>', contentStart);
        const raw = xml.slice(contentStart, endTag);
        const text = decodeXml(raw);
        cur.pieces.push({ tagStart: at, tagEnd: contentStart, contentStart, contentEnd: endTag, text, offset: cur.text.length, preserve: /xml:space="preserve"/.test(tag) });
        cur.text += text;
        tagRe.lastIndex = endTag + 6;
        break;
      }
      default:
    }
  }
  return paras;
}

function where(p) {
  if (p.where === 'textbox') return p.shape ? `Πλαίσιο κειμένου «${p.shape}»` : 'Πλαίσιο κειμένου';
  if (p.where === 'table') return 'Πίνακας';
  return partLabel(p.part);
}

// All dates in the file. `parts` is { 'word/document.xml': xmlString, ... }.
// Each Word text box saved by Word has a second, older copy (mc:Fallback) of
// the same text. Those copies are linked to the first one as `mirrors` and are
// changed with it, but not listed twice.
export function findDocxDates(parts) {
  const items = [];
  for (const [part, xml] of Object.entries(parts)) {
    if (!TEXT_PARTS.test(part)) continue;
    const paras = scanPart(xml, part);
    const byAc = new Map(); // ac id -> { choice: [], fallback: [] }
    for (const p of paras) {
      for (const d of findDates(p.text)) {
        const item = {
          id: `${part}#${p.index}@${d.start}`, part, para: p.index, start: d.start, end: d.end,
          match: d, text: d.text, where: where(p), page: part === 'word/document.xml' ? p.page : null,
          top: part === 'word/document.xml' ? p.top : null,
          before: p.text.slice(Math.max(0, d.start - 40), d.start), after: p.text.slice(d.end, d.end + 40),
          mirrors: [],
        };
        if (p.ac && p.ac.branch) {
          if (!byAc.has(p.ac.id)) byAc.set(p.ac.id, { choice: [], fallback: [] });
          byAc.get(p.ac.id)[p.ac.branch].push(item);
        }
        items.push(item);
      }
    }
    for (const { choice, fallback } of byAc.values()) {
      fallback.forEach((f, i) => {
        const c = choice[i];
        if (c && c.text === f.text) { c.mirrors.push(f); f.mirrorOf = c; }
      });
    }
  }
  return items.filter((i) => !i.mirrorOf);
}

// Apply edits: [{ item, text }] -> new XML for each part that changed.
export function applyEdits(parts, edits) {
  const byPart = new Map();
  for (const e of edits) {
    for (const it of [e.item, ...e.item.mirrors]) {
      if (it.text === e.text) continue;
      if (!byPart.has(it.part)) byPart.set(it.part, []);
      byPart.get(it.part).push({ para: it.para, start: it.start, end: it.end, text: e.text, expect: it.text });
    }
  }
  const out = {};
  for (const [part, list] of byPart) {
    const xml = parts[part];
    const paras = scanPart(xml, part);
    const changed = new Map(); // piece -> new text
    // right to left inside each paragraph, so earlier offsets stay valid
    list.sort((a, b) => a.para - b.para || b.start - a.start);
    for (const ed of list) {
      const p = paras[ed.para];
      if (p.text.slice(ed.start, ed.end) !== ed.expect) throw new Error(`Το κείμενο άλλαξε στο ${part}`);
      const pieces = p.pieces.filter((x) => x.text !== undefined);
      let inserted = false;
      for (const pc of pieces) {
        const t = changed.has(pc) ? changed.get(pc) : pc.text;
        const a = pc.offset, b = pc.offset + pc.text.length;
        if (b <= ed.start || a >= ed.end) continue;
        // offsets inside this piece. Edits to the right of this one are already
        // in `t`, and everything left of `e` is still the original text.
        const s = Math.max(ed.start, a) - a;
        const e = Math.min(ed.end, b) - a;
        const head = t.slice(0, s);
        const rest = t.slice(e);
        changed.set(pc, head + (inserted ? '' : ed.text) + rest);
        inserted = true;
      }
    }
    // splice the changed pieces into the XML, last first
    const edits2 = [...changed].sort((a, b) => b[0].contentStart - a[0].contentStart);
    let s = xml;
    for (const [pc, text] of edits2) {
      let open = s.slice(pc.tagStart, pc.tagEnd);
      if (!pc.preserve && /^\s|\s$/.test(text)) open = open.replace(/^<w:t/, '<w:t xml:space="preserve"');
      s = s.slice(0, pc.tagStart) + open + encodeXml(text) + s.slice(pc.contentEnd);
    }
    out[part] = s;
  }
  return out;
}

export { formatLike };
