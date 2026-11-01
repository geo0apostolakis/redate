// A small XML reader: enough for the parts of a .docx, no dependencies, and
// the same in the browser and in Node.
import { decodeXml } from './docx-dates.js';

export function parseXml(src) {
  const root = { name: '#root', attrs: {}, children: [] };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(src))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.children.push({ text: m[1] });
    else if (m[3]) {
      if (m[2]) { stack.pop(); continue; }
      const el = { name: m[3], attrs: {}, children: [] };
      for (const a of m[4].matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) el.attrs[a[1]] = decodeXml(a[2] ?? a[3]);
      top.children.push(el);
      if (!m[5]) stack.push(el);
    } else if (m[6] !== undefined && stack.length > 1) top.children.push({ text: decodeXml(m[6]) });
  }
  return root;
}

export const kids = (el, name) => (el?.children || []).filter((c) => c.name && (!name || c.name === name));
export const kid = (el, name) => kids(el, name)[0];

export function find(el, name, out = []) {
  for (const c of el?.children || []) {
    if (!c.name) continue;
    if (c.name === name) out.push(c);
    find(c, name, out);
  }
  return out;
}

// first descendant with this name, without going into `stop` elements
export function findFirst(el, name, stop = []) {
  for (const c of el?.children || []) {
    if (!c.name || stop.includes(c.name)) continue;
    if (c.name === name) return c;
    const f = findFirst(c, name, stop);
    if (f) return f;
  }
  return null;
}

export function textOf(el) {
  return (el?.children || []).map((c) => (c.name ? textOf(c) : c.text)).join('');
}
