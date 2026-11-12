// Small, tolerant XML parser for XMP packets. No DOM needed, so it runs in Node and
// in the browser. Keeps namespace scopes so prefixes can be resolved to URIs.

export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  parent: XmlElement | null;
  /** prefix -> namespace URI in scope for this element ('' = default namespace). */
  ns: Record<string, string>;
}

export type XmlNode = XmlElement | string;

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, ent: string) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[ent] ?? m;
  });
}

const ATTR_RE = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;

/** Parses XML into a tree under a synthetic '#document' root. Never throws on bad markup. */
export function parseXml(text: string): XmlElement {
  const root: XmlElement = { name: '#document', attrs: {}, children: [], parent: null, ns: { xml: 'http://www.w3.org/XML/1998/namespace' } };
  let cur = root;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt < 0) {
      pushText(cur, text.slice(i));
      break;
    }
    if (lt > i) pushText(cur, text.slice(i, lt));
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      i = end < 0 ? n : end + 3;
    } else if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9);
      cur.children.push(text.slice(lt + 9, end < 0 ? n : end));
      i = end < 0 ? n : end + 3;
    } else if (text.startsWith('<?', lt)) {
      const end = text.indexOf('?>', lt + 2);
      i = end < 0 ? n : end + 2;
    } else if (text.startsWith('<!', lt)) {
      const end = text.indexOf('>', lt + 2);
      i = end < 0 ? n : end + 1;
    } else if (text[lt + 1] === '/') {
      const end = text.indexOf('>', lt + 2);
      const name = text.slice(lt + 2, end < 0 ? n : end).trim();
      // Close up to the matching element; ignore stray closing tags.
      let e: XmlElement | null = cur;
      while (e && e !== root && e.name !== name) e = e.parent;
      if (e && e !== root) cur = e.parent ?? root;
      i = end < 0 ? n : end + 1;
    } else {
      const end = findTagEnd(text, lt + 1);
      const raw = text.slice(lt + 1, end);
      const selfClosing = raw.endsWith('/');
      const body = selfClosing ? raw.slice(0, -1) : raw;
      const m = /^[^\s/>]+/.exec(body);
      if (!m) {
        i = end + 1;
        continue;
      }
      const name = m[0];
      const attrs: Record<string, string> = {};
      let ns = cur.ns;
      let copied = false;
      ATTR_RE.lastIndex = name.length;
      for (let a = ATTR_RE.exec(body); a; a = ATTR_RE.exec(body)) {
        const key = a[1]!;
        const value = decodeEntities(a[3] ?? a[4] ?? '');
        if (key === 'xmlns' || key.startsWith('xmlns:')) {
          if (!copied) {
            ns = { ...ns };
            copied = true;
          }
          ns[key === 'xmlns' ? '' : key.slice(6)] = value;
        } else {
          attrs[key] = value;
        }
      }
      const el: XmlElement = { name, attrs, children: [], parent: cur, ns };
      cur.children.push(el);
      if (!selfClosing) cur = el;
      i = end + 1;
    }
  }
  return root;
}

function pushText(el: XmlElement, s: string) {
  if (s) el.children.push(decodeEntities(s));
}

/** Index of the '>' ending a start tag, skipping '>' inside quoted attribute values. */
function findTagEnd(text: string, from: number): number {
  let quote: string | null = null;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '>') return i;
  }
  return text.length;
}

export interface QName {
  uri: string;
  local: string;
}

/** Resolves an element or attribute name to (namespace URI, local name). */
export function resolveName(el: XmlElement, qname: string, isAttribute = false): QName {
  const colon = qname.indexOf(':');
  if (colon < 0) return { uri: isAttribute ? '' : (el.ns[''] ?? ''), local: qname };
  const prefix = qname.slice(0, colon);
  return { uri: el.ns[prefix] ?? '', local: qname.slice(colon + 1) };
}

export const elements = (el: XmlElement): XmlElement[] => el.children.filter((c): c is XmlElement => typeof c !== 'string');

export const textOf = (el: XmlElement): string =>
  el.children.map((c) => (typeof c === 'string' ? c : textOf(c))).join('');
