# redate

Change the dates in a Word or PDF file and get **the same file back**: same
fonts, same layout, every other byte untouched.

Schools, clubs and offices reuse the same letter, newsletter or invoice every
month and only the dates change. Opening it, hunting for every date and
retyping it breaks layouts and misses one in a text box. redate finds every
date in the file, shows where each one is, and writes the new one in the
style the old one used (`15/10/2026`, `15.10.26`, `Thursday, 15 October 2026`,
Greek month names...).

**Live:** https://imerominies.vercel.app (Greek interface, `.docx`). Runs fully
in the browser; the file never leaves your device.

## How it works

**Word (.docx).** Word splits text into `<w:t>` runs that can cut one date in
half (`15 Οκτ` + `ωβρίου 2026`). Each paragraph's runs are joined, dates are
found in the joined text, and an edit changes only the characters inside those
runs. Every other byte of the XML stays as it was. Dates are found in the body,
tables, headers, footers, footnotes and text boxes, and each one is labelled
with where it lives.

**Picture-page files.** A deck exported to Word is pictures with text boxes on
top. Those pages are drawn exactly (picture, then each line in the font
embedded in the file) for the preview and for a PDF copy.

**PDF.** The hard one. Each page's drawing commands are run to find where
every character lands, characters are put back into lines, and dates are found
in the lines. Each date is then taken out of the commands that drew it and the
new text goes in its place:

- in the **same font** when that font already has every character needed;
- otherwise drawn in the font's own program, or in a **metric-compatible font**
  (Arimo for Arial, Tinos for Times, Carlito for Calibri) so widths match;
- the rest of the line **stays put, or moves the way Word would** move it:
  right aligned, centred or justified;
- the changes are **appended** to the end of the original file (an incremental
  update), so every original byte is still there.

Fonts are embedded with only the glyphs needed, with unused glyphs emptied
rather than removed so glyph numbers stay stable (`Identity-H`). pdf-lib's own
subsetting drew most letters blank in macOS Preview, which is why
`src/pdf/embed.js` exists.

## Run it

```bash
npm install
npm run dev        # web app
npm test           # 15 tests, node:test, no browser needed

node scripts/cli.mjs IN.docx                        # list the dates
node scripts/cli.mjs IN.docx 2026-11-05 OUT.docx    # set every date
node scripts/pdf-cli.mjs IN.pdf 2026-11-05 OUT.pdf  # same for a PDF
```

## Layout

```
src/dates.js          find dates in text, write a new one in the same style
src/docx-dates.js     .docx: find and replace inside <w:t> runs, nothing else
src/layout.js         picture-page layouts (decks exported to Word)
src/render.js         draw those pages to canvas and PDF
src/pdf/read.js       run PDF drawing commands, rebuild lines, find dates
src/pdf/write.js      replace the dates, keep alignment, append the update
src/pdf/fonts.js      PDF font encodings, widths and glyph lookup
src/pdf/embed.js      subset a TrueType font without breaking Preview
```

## License

MIT. Bundled fonts keep their own licenses: Commissioner and JetBrains Mono
(SIL OFL 1.1), Arimo, Tinos and Cousine (Apache 2.0), Carlito (SIL OFL 1.1).
pdf.js is Apache 2.0 (`public/pdfjs/LICENSE`).
