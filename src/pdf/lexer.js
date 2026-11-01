// Reading a PDF content stream into operations, and writing operands back.
// The stream is handled as a "binary string": one JS char per byte.

const WS = '\0\t\n\f\r ';
const DELIM = '()<>[]{}/%';
const isWS = (c) => WS.includes(c);
const isRegular = (c) => c !== undefined && !isWS(c) && !DELIM.includes(c);

function readLiteral(s, i) {
  // s[i] === '('
  let depth = 1;
  let out = '';
  i++;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      const n = s[i + 1];
      const esc = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' }[n];
      if (esc !== undefined) { out += esc; i += 2; continue; }
      if (n >= '0' && n <= '7') {
        let j = i + 1, oct = '';
        while (j < s.length && oct.length < 3 && s[j] >= '0' && s[j] <= '7') oct += s[j++];
        out += String.fromCharCode(parseInt(oct, 8) & 0xff);
        i = j;
        continue;
      }
      if (n === '\r') { i += s[i + 2] === '\n' ? 3 : 2; continue; }
      if (n === '\n') { i += 2; continue; }
      i += 1; // a backslash before any other char is ignored
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return { bytes: out, end: i + 1 };
    if (c === '\r') { out += '\n'; i += s[i + 1] === '\n' ? 2 : 1; continue; }
    out += c;
    i++;
  }
  return { bytes: out, end: i };
}

function readHex(s, i) {
  // s[i] === '<'
  const close = s.indexOf('>', i);
  const end = close < 0 ? s.length : close;
  let hex = s.slice(i + 1, end).replace(/[^0-9a-fA-F]/g, '');
  if (hex.length % 2) hex += '0';
  let out = '';
  for (let k = 0; k < hex.length; k += 2) out += String.fromCharCode(parseInt(hex.substr(k, 2), 16));
  return { bytes: out, end: end + 1 };
}

// [{ op, args, start, end }] where start..end covers the operands and the operator
export function parseOps(s) {
  const ops = [];
  let stack = [];      // operands of the current operation
  const nest = [];     // open arrays / dicts
  let argStart = -1;
  let i = 0;
  const push = (v, start) => {
    if (nest.length) nest[nest.length - 1].v.push(v);
    else { if (argStart < 0) argStart = start; stack.push(v); }
  };
  while (i < s.length) {
    const c = s[i];
    if (isWS(c)) { i++; continue; }
    if (c === '%') { while (i < s.length && s[i] !== '\n' && s[i] !== '\r') i++; continue; }
    const start = i;
    if (c === '(') { const r = readLiteral(s, i); push({ t: 'str', bytes: r.bytes }, start); i = r.end; continue; }
    if (c === '<' && s[i + 1] === '<') { nest.push({ t: 'dict', v: [], start }); i += 2; continue; }
    if (c === '>' && s[i + 1] === '>') {
      const d = nest.pop();
      i += 2;
      if (d) push({ t: 'dict', raw: s.slice(d.start, i) }, d.start);
      continue;
    }
    if (c === '<') { const r = readHex(s, i); push({ t: 'hex', bytes: r.bytes }, start); i = r.end; continue; }
    if (c === '[') { nest.push({ t: 'arr', v: [], start }); i++; continue; }
    if (c === ']') { const a = nest.pop(); i++; if (a) push({ t: 'arr', v: a.v }, a.start); continue; }
    if (c === '/') {
      let j = i + 1;
      while (isRegular(s[j])) j++;
      const name = s.slice(i + 1, j).replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
      push({ t: 'name', v: name }, start);
      i = j;
      continue;
    }
    if (c === ')' || c === '>' || c === '{' || c === '}') { i++; continue; } // stray delimiter
    let j = i;
    while (isRegular(s[j])) j++;
    if (j === i) j = i + 1;
    const word = s.slice(i, j);
    i = j;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) { push({ t: 'num', v: Number(word) }, start); continue; }
    if (word === 'true' || word === 'false') { push({ t: 'bool', v: word === 'true' }, start); continue; }
    if (word === 'null') { push({ t: 'null' }, start); continue; }
    if (nest.length) continue; // an operator inside an array is malformed, skip it
    if (word === 'BI') {
      // inline image: skip to the EI that ends its data
      const id = s.indexOf('ID', i);
      let k = id + 3;
      let end = -1;
      while (k < s.length) {
        const e = s.indexOf('EI', k);
        if (e < 0) break;
        if (isWS(s[e - 1]) && (e + 2 >= s.length || isWS(s[e + 2]))) { end = e + 2; break; }
        k = e + 2;
      }
      if (end < 0) end = s.length;
      ops.push({ op: 'BI', args: [], start, end });
      i = end;
      stack = [];
      argStart = -1;
      continue;
    }
    ops.push({ op: word, args: stack, start: argStart < 0 ? start : argStart, end: i });
    stack = [];
    argStart = -1;
  }
  return ops;
}

export const toHex = (bytes) => {
  let h = '';
  for (let k = 0; k < bytes.length; k++) h += bytes.charCodeAt(k).toString(16).padStart(2, '0');
  return h.toUpperCase();
};

export function num(n) {
  if (Number.isInteger(n)) return String(n);
  const s = n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}

// a TJ array from [{ bytes } | number]
export function writeTJ(elems) {
  return '[' + elems.map((e) => (typeof e === 'number' ? num(e) : `<${toHex(e.bytes)}>`)).join(' ') + '] TJ';
}

// binary string <-> bytes
export function bytesToBinary(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return s;
}
export function binaryToBytes(s) {
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i) & 0xff;
  return u8;
}
