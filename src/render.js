// Drawing a picture-page layout (see layout.js): on a canvas for the preview,
// and into a PDF. Loaded only when a file has such pages.
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, rgb } from 'pdf-lib';

const EMU_PER_PT = 12700;

const fontCache = new WeakMap();
function fk(bytes) {
  if (!fontCache.has(bytes)) fontCache.set(bytes, fontkit.create(bytes));
  return fontCache.get(bytes);
}

function metrics(font) {
  const os2 = font['OS/2'];
  const upm = font.unitsPerEm;
  // Word lays out lines with the Windows metrics
  const asc = (os2?.winAscent || font.ascent) / upm;
  const desc = (os2?.winDescent || -font.descent) / upm;
  return { asc, desc };
}

// Glyph positions for one text box, in points from the page's top left.
export function layoutBox(box, fonts) {
  const pt = (emu) => emu / EMU_PER_PT;
  const left = pt(box.x + box.inset.l);
  const width = pt(box.w - box.inset.l - box.inset.r);
  const lines = [];
  let y = 0;
  for (const para of box.paras) {
    y += para.before;
    const runs = para.runs.length ? para.runs : [{ ...para.empty, text: '' }];
    let asc = 0, desc = 0;
    for (const r of runs) {
      if (!fonts[r.font]) continue;
      const m = metrics(fk(fonts[r.font]));
      asc = Math.max(asc, m.asc * r.size);
      desc = Math.max(desc, m.desc * r.size);
    }
    let height;
    if (para.line.rule === 'exact') height = para.line.pt;
    else if (para.line.rule === 'atLeast') height = Math.max(para.line.pt, asc + desc);
    else height = (asc + desc) * para.line.mult;
    const glyphs = [];
    let pen = 0;
    for (const r of runs) {
      if (!r.text || !fonts[r.font]) continue;
      const font = fk(fonts[r.font]);
      const scale = r.size / font.unitsPerEm;
      const run = font.layout(r.text, ['kern', 'liga']);
      run.glyphs.forEach((g, i) => {
        const pos = run.positions[i];
        glyphs.push({ glyph: g, font: r.font, size: r.size, color: r.color, x: pen + pos.xOffset * scale, dy: pos.yOffset * scale, chars: String.fromCodePoint(...g.codePoints) });
        pen += pos.xAdvance * scale + r.spacing;
      });
    }
    const shift = para.align === 'center' ? (width - pen) / 2 : para.align === 'right' ? width - pen : 0;
    const baseline = y + (para.line.rule === 'exact' ? height - desc : asc);
    lines.push({ baseline, glyphs: glyphs.map((g) => ({ ...g, x: left + shift + g.x })) });
    y += height + para.after;
  }
  const inner = pt(box.h - box.inset.t - box.inset.b);
  const top = pt(box.y + box.inset.t) + (box.anchor === 'ctr' ? (inner - y) / 2 : box.anchor === 'b' ? inner - y : 0);
  return lines.map((l) => ({ ...l, baseline: top + l.baseline }));
}

const hexColor = (h) => [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);

// Draw one page into a canvas 2D context of width `pxWidth`.
export function drawPage(ctx, img, layout, page, fonts, pxWidth) {
  const s = pxWidth / (layout.W / EMU_PER_PT);
  ctx.drawImage(img, 0, 0, pxWidth, (layout.H / layout.W) * pxWidth);
  for (const box of page.boxes) {
    for (const line of layoutBox(box, fonts)) {
      for (const g of line.glyphs) {
        const font = fk(fonts[g.font]);
        const k = g.size / font.unitsPerEm;
        ctx.save();
        ctx.translate(g.x * s, (line.baseline - g.dy) * s);
        ctx.scale(k * s, -k * s);
        ctx.fillStyle = '#' + g.color;
        ctx.fill(new Path2D(g.glyph.path.toSVG()));
        ctx.restore();
      }
    }
  }
}

// The whole file as a PDF (Uint8Array)
export async function buildPdf(src, layout, fonts, title) {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  if (title) pdf.setTitle(title);
  pdf.setCreator('Αλλαγή ημερομηνιών');
  const embedded = {};
  const wPt = layout.W / EMU_PER_PT, hPt = layout.H / EMU_PER_PT;
  for (const page of layout.pages) {
    const bytes = await src.bytes(page.image);
    const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
    const img = isPng ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
    const p = pdf.addPage([wPt, hPt]);
    p.drawImage(img, { x: 0, y: 0, width: wPt, height: hPt });
    for (const box of page.boxes) {
      for (const line of layoutBox(box, fonts)) {
        for (const g of line.glyphs) {
          if (!g.chars.trim()) continue;
          if (!embedded[g.font]) embedded[g.font] = await pdf.embedFont(fonts[g.font], { subset: false });
          p.drawText(g.chars, { x: g.x, y: hPt - line.baseline + g.dy, size: g.size, font: embedded[g.font], color: rgb(...hexColor(g.color)) });
        }
      }
    }
  }
  return pdf.save();
}
