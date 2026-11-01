// Finding dates in plain text and writing a new date back in the same style.
// Pure functions, no DOM, so the tests run them in Node.

const GR_MONTHS = [
  { gen: 'Ιανουαρίου', nom: 'Ιανουάριος', abbr: 'Ιαν' },
  { gen: 'Φεβρουαρίου', nom: 'Φεβρουάριος', abbr: 'Φεβ' },
  { gen: 'Μαρτίου', nom: 'Μάρτιος', abbr: 'Μαρ' },
  { gen: 'Απριλίου', nom: 'Απρίλιος', abbr: 'Απρ' },
  { gen: 'Μαΐου', nom: 'Μάιος', abbr: 'Μαΐ' },
  { gen: 'Ιουνίου', nom: 'Ιούνιος', abbr: 'Ιουν' },
  { gen: 'Ιουλίου', nom: 'Ιούλιος', abbr: 'Ιουλ' },
  { gen: 'Αυγούστου', nom: 'Αύγουστος', abbr: 'Αυγ' },
  { gen: 'Σεπτεμβρίου', nom: 'Σεπτέμβριος', abbr: 'Σεπ' },
  { gen: 'Οκτωβρίου', nom: 'Οκτώβριος', abbr: 'Οκτ' },
  { gen: 'Νοεμβρίου', nom: 'Νοέμβριος', abbr: 'Νοε' },
  { gen: 'Δεκεμβρίου', nom: 'Δεκέμβριος', abbr: 'Δεκ' },
];
const GR_ABBR_EXTRA = [[], ['Φεβρ'], ['Μαρτ'], [], ['Μάι', 'Μαϊ'], [], [], [], ['Σεπτ'], [], ['Νοεμ'], []];
const EN_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
// JavaScript order: 0 is Sunday
const GR_DAYS = ['Κυριακή', 'Δευτέρα', 'Τρίτη', 'Τετάρτη', 'Πέμπτη', 'Παρασκευή', 'Σάββατο'];
const GR_DAYS_ABBR = ['Κυρ', 'Δευ', 'Τρι', 'Τετ', 'Πεμ', 'Παρ', 'Σαβ'];
const EN_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Lower case, no accents, one kind of sigma. Keeps the length the same as the
// input, so a match in the folded text has the same offsets in the original.
export function fold(text) {
  let out = '';
  for (const ch of text) {
    let f = ch.length === 1 ? ch.normalize('NFD')[0].toLowerCase() : ch;
    if (f === 'ς') f = 'σ';
    out += f.length === ch.length ? f : ch;
  }
  return out;
}

// word -> { kind, index, form, lang }
const WORDS = new Map();
function addWord(word, entry) {
  const key = fold(word);
  if (!WORDS.has(key)) WORDS.set(key, entry);
}
GR_MONTHS.forEach((m, i) => {
  addWord(m.gen, { kind: 'month', index: i, lang: 'el', form: 'gen' });
  addWord(m.nom, { kind: 'month', index: i, lang: 'el', form: 'nom' });
  addWord(m.abbr, { kind: 'month', index: i, lang: 'el', form: 'abbr' });
  GR_ABBR_EXTRA[i].forEach((a) => addWord(a, { kind: 'month', index: i, lang: 'el', form: 'abbr' }));
});
EN_MONTHS.forEach((m, i) => {
  addWord(m, { kind: 'month', index: i, lang: 'en', form: 'full' });
  addWord(m.slice(0, 3), { kind: 'month', index: i, lang: 'en', form: 'abbr' });
});
addWord('Sept', { kind: 'month', index: 8, lang: 'en', form: 'abbr' });
GR_DAYS.forEach((d, i) => addWord(d, { kind: 'day', index: i, lang: 'el', form: 'full' }));
GR_DAYS_ABBR.forEach((d, i) => addWord(d, { kind: 'day', index: i, lang: 'el', form: 'abbr' }));
EN_DAYS.forEach((d, i) => {
  addWord(d, { kind: 'day', index: i, lang: 'en', form: 'full' });
  addWord(d.slice(0, 3), { kind: 'day', index: i, lang: 'en', form: 'abbr' });
});

const alt = (kind) => [...WORDS].filter(([, e]) => e.kind === kind).map(([w]) => w)
  .sort((a, b) => b.length - a.length).join('|');
const MONTH = `(?:${alt('month')})`;
const WDAY = `(?:${alt('day')})`;
const L = '(?<![\\p{L}\\p{N}])';
const R = '(?![\\p{L}\\p{N}])';
const NUMR = '(?![\\p{L}\\p{N}]|[./-]\\d)';

const PATTERNS = [
  // 15 Οκτωβρίου 2026, Δευτέρα 15 Οκτωβρίου, 5 Oct. 2026
  { kind: 'dmy', re: `${L}(?:(?<wd>${WDAY})\\.?,?\\s+)?(?<d>\\d{1,2})\\s+(?<m>${MONTH})${R}\\.?(?:,?\\s+(?<y>\\d{4})${R})?` },
  // October 15, 2026
  { kind: 'mdy', re: `${L}(?:(?<wd>${WDAY})\\.?,?\\s+)?(?<m>${MONTH})${R}\\.?\\s+(?<d>\\d{1,2})(?:st|nd|rd|th)?${R}(?:,?\\s+(?<y>\\d{4})${R})?` },
  // 2026-10-15
  { kind: 'iso', re: `(?<![\\p{L}\\p{N}.\\/-])(?<y>\\d{4})-(?<m>\\d{2})-(?<d>\\d{2})${NUMR}` },
  // 15.10.2026, 15/10/26, Τρίτη 5-3-2026
  { kind: 'num', re: `(?<![\\p{L}\\p{N}.\\/-])(?:(?<wd>${WDAY})\\.?,?\\s+)?(?<d>\\d{1,2})(?<sep>[./-])(?<m>\\d{1,2})\\k<sep>(?<y>\\d{4}|\\d{2})${NUMR}` },
  // Οκτώβριος 2026, October 2026
  { kind: 'my', re: `${L}(?<m>${MONTH})${R}\\.?\\s+(?<y>\\d{4})${R}` },
].map((p) => ({ ...p, re: new RegExp(p.re, 'gdu') }));

function validDate(y, m, d) {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

// Every date in `text`: [{ start, end, text, value: {y, m, d}, has: {...}, parts }]
export function findDates(text) {
  const folded = fold(text);
  const found = [];
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    for (const mt of folded.matchAll(p.re)) {
      const g = mt.groups;
      const ix = mt.indices.groups;
      const parts = {};
      for (const k of ['wd', 'd', 'm', 'y']) {
        if (g[k] !== undefined) parts[k] = { start: ix[k][0] - mt.index, end: ix[k][1] - mt.index, text: text.slice(ix[k][0], ix[k][1]) };
      }
      let month;
      if (p.kind === 'iso' || p.kind === 'num') month = Number(g.m);
      else {
        const w = WORDS.get(g.m);
        // English month names are written with a capital: "2 may seem" is not a date
        if (w.lang === 'en' && parts.m.text[0] !== parts.m.text[0].toUpperCase()) continue;
        month = w.index + 1;
      }
      let year = g.y === undefined ? null : Number(g.y);
      if (year !== null && g.y.length === 2) year += 2000;
      const day = g.d === undefined ? null : Number(g.d);
      if (month < 1 || month > 12) continue;
      if (day !== null && !validDate(year ?? 2000, month, day)) continue;
      if (year !== null && (year < 1900 || year > 2200)) continue;
      // a weekday that does not match the date is probably not part of it
      if (parts.wd && day !== null && year !== null) {
        const want = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
        if (WORDS.get(fold(parts.wd.text)).index !== want) {
          const cut = parts.d.start;
          const shift = (k) => ({ ...parts[k], start: parts[k].start - cut, end: parts[k].end - cut });
          const kept = {};
          for (const k of ['d', 'm', 'y']) if (parts[k]) kept[k] = shift(k);
          found.push(makeMatch(p.kind, text, mt.index + cut, mt.index + mt[0].length, kept, { y: year, m: month, d: day }, g));
          continue;
        }
      }
      found.push(makeMatch(p.kind, text, mt.index, mt.index + mt[0].length, parts, { y: year, m: month, d: day }, g));
    }
  }
  // keep the earliest, then the longest, and drop overlaps
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const out = [];
  let lastEnd = -1;
  for (const f of found) {
    if (f.start >= lastEnd) {
      out.push(f);
      lastEnd = f.end;
    }
  }
  return out;
}

function makeMatch(kind, text, start, end, parts, value, groups) {
  let e = end;
  // a trailing dot after an abbreviated month belongs to the date, a full stop does not
  if (text[e - 1] === '.' && !(parts.m && kind !== 'num' && kind !== 'iso' && WORDS.get(fold(parts.m.text))?.form === 'abbr' && parts.m.end === e - 1 - start)) e -= 1;
  return {
    start, end: e, kind, text: text.slice(start, e), parts, value,
    has: { day: value.d !== null, year: value.y !== null, weekday: !!parts.wd },
    sep: groups.sep,
  };
}

function caseOf(s) {
  const letters = s.replace(/[^\p{L}]/gu, '');
  if (letters && letters === letters.toUpperCase() && letters !== letters.toLowerCase()) return 'upper';
  if (letters && letters[0] === letters[0].toUpperCase()) return 'title';
  return 'lower';
}

// Greek capitals drop the accent (ΟΚΤΩΒΡΙΟΥ) but keep the dialytika (ΜΑΪΟΥ)
function upper(s) {
  return s.normalize('NFD').replace(/́/g, '').toUpperCase().normalize('NFC');
}

function withCase(word, c) {
  if (c === 'upper') return upper(word);
  if (c === 'lower') return word.toLowerCase();
  return word;
}

function pad2(n, padded) {
  return padded ? String(n).padStart(2, '0') : String(n);
}

// The match rewritten for a new date ({y, m, d}), keeping its words, case,
// spacing and punctuation. Parts the original did not have stay out.
export function formatLike(match, date) {
  const { parts } = match;
  const rep = {};
  if (parts.d) {
    const numeric = match.kind === 'num' || match.kind === 'iso';
    const padded = numeric ? parts.d.text.length === 2 : parts.d.text.startsWith('0');
    rep.d = pad2(date.d, padded);
  }
  if (parts.m) {
    if (match.kind === 'num' || match.kind === 'iso') {
      rep.m = pad2(date.m, parts.m.text.length === 2);
    } else {
      const w = WORDS.get(fold(parts.m.text));
      let word;
      if (w.lang === 'el') word = GR_MONTHS[date.m - 1][w.form];
      else word = w.form === 'full' ? EN_MONTHS[date.m - 1] : EN_MONTHS[date.m - 1].slice(0, parts.m.text.length === 4 && date.m === 9 ? 4 : 3);
      rep.m = withCase(word, caseOf(parts.m.text));
    }
  }
  if (parts.y) rep.y = parts.y.text.length === 2 ? String(date.y).slice(-2) : String(date.y);
  if (parts.wd) {
    const w = WORDS.get(fold(parts.wd.text));
    const wd = new Date(Date.UTC(date.y, date.m - 1, date.d)).getUTCDay();
    let word;
    if (w.lang === 'el') word = (w.form === 'full' ? GR_DAYS : GR_DAYS_ABBR)[wd];
    else word = w.form === 'full' ? EN_DAYS[wd] : EN_DAYS[wd].slice(0, 3);
    rep.wd = withCase(word, caseOf(parts.wd.text));
  }
  let out = match.text;
  const order = Object.keys(rep).sort((a, b) => parts[b].start - parts[a].start);
  for (const k of order) out = out.slice(0, parts[k].start) + rep[k] + out.slice(parts[k].end);
  return out;
}

export function toISO({ y, m, d }) {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function fromISO(s) {
  const [y, m, d] = s.split('-').map(Number);
  return { y, m, d };
}
