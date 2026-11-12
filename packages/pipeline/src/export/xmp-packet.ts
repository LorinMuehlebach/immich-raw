// Descriptive XMP (Dublin Core, xmp, photoshop, Lightroom keywords) for exported images, and
// its JPEG container: one APP1 "http://ns.adobe.com/xap/1.0/\0" segment (XMP spec part 3).

export interface XmpFields {
  /** dc:creator (rdf:Seq) */
  creator?: string;
  /** dc:rights (rdf:Alt, x-default); also sets xmpRights:Marked. */
  rights?: string;
  /** dc:description (rdf:Alt, x-default) */
  description?: string;
  /**
   * dc:subject (rdf:Bag) gets the leaf of each keyword. When any keyword is hierarchical
   * ('Places/Europe/Paris'), lr:hierarchicalSubject lists all keywords with '|' separators.
   */
  keywords?: string[];
  /** xmp:Rating: -1 (rejected) or 1..5; 0 and anything else is left out. */
  rating?: number;
  /** photoshop:City / photoshop:State / photoshop:Country */
  city?: string;
  state?: string;
  country?: string;
  /** xmp:CreateDate and photoshop:DateCreated, ISO 8601, e.g. '2022-12-17T16:03:36+08:00'. */
  createDate?: string;
  /** xmp:CreatorTool */
  creatorTool?: string;
}

const NS = {
  xmp: 'http://ns.adobe.com/xap/1.0/',
  dc: 'http://purl.org/dc/elements/1.1/',
  photoshop: 'http://ns.adobe.com/photoshop/1.0/',
  xmpRights: 'http://ns.adobe.com/xap/1.0/rights/',
  lr: 'http://ns.adobe.com/lightroom/1.0/',
} as const;

// Characters XML 1.0 doesn't allow at all (C0 controls other than tab/LF/CR, lone surrogates, U+FFFE/F).
const INVALID_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** Element content. CR is written as a reference so parsers don't fold it into LF. */
function escText(s: string): string {
  return s
    .replace(INVALID_XML, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/\r/g, '&#xD;');
}

/** Attribute values: also keep whitespace that attribute normalisation would turn into spaces. */
function escAttr(s: string): string {
  return escText(s).replace(/\n/g, '&#xA;').replace(/\t/g, '&#x9;');
}

const ISO_DATE = /^\d{4}(-\d\d(-\d\d(T\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:\d\d)?)?)?)?$/;

const present = (s: string | undefined): s is string => typeof s === 'string' && s.trim() !== '';

/** Keyword path components: 'Places / Europe/Paris' -> ['Places', 'Europe', 'Paris']. */
const keywordPath = (k: string) =>
  k
    .split('/')
    .map((p) => p.trim())
    .filter((p) => p !== '');

/** XMP packet (UTF-8 string with <?xpacket?> wrapper), or '' when no field is set. All text XML-escaped. */
export function buildXmp(f: XmpFields): string {
  const attrs: string[] = [];
  const blocks: string[] = [];
  const used = new Set<keyof typeof NS>();
  const attr = (ns: keyof typeof NS, name: string, value: string) => {
    used.add(ns);
    attrs.push(`${ns}:${name}="${escAttr(value)}"`);
  };
  const array = (ns: keyof typeof NS, name: string, kind: 'Seq' | 'Bag' | 'Alt', items: string[]) => {
    used.add(ns);
    const lang = kind === 'Alt' ? ' xml:lang="x-default"' : '';
    const li = items.map((v) => `     <rdf:li${lang}>${escText(v)}</rdf:li>`).join('\n');
    blocks.push(`   <${ns}:${name}>\n    <rdf:${kind}>\n${li}\n    </rdf:${kind}>\n   </${ns}:${name}>`);
  };

  if (present(f.creatorTool)) attr('xmp', 'CreatorTool', f.creatorTool);
  if (present(f.createDate)) {
    const date = f.createDate.trim();
    if (!ISO_DATE.test(date)) throw new Error(`createDate must be ISO 8601 like '2022-12-17T16:03:36+08:00', got '${f.createDate}'`);
    attr('xmp', 'CreateDate', date);
    attr('photoshop', 'DateCreated', date);
  }
  if (typeof f.rating === 'number' && Number.isInteger(f.rating) && (f.rating === -1 || (f.rating >= 1 && f.rating <= 5))) {
    attr('xmp', 'Rating', String(f.rating));
  }
  if (present(f.city)) attr('photoshop', 'City', f.city);
  if (present(f.state)) attr('photoshop', 'State', f.state);
  if (present(f.country)) attr('photoshop', 'Country', f.country);
  if (present(f.rights)) attr('xmpRights', 'Marked', 'True');

  if (present(f.creator)) array('dc', 'creator', 'Seq', [f.creator]);
  if (present(f.rights)) array('dc', 'rights', 'Alt', [f.rights]);
  if (present(f.description)) array('dc', 'description', 'Alt', [f.description]);

  const paths = (f.keywords ?? []).map(keywordPath).filter((p) => p.length > 0);
  if (paths.length) {
    array('dc', 'subject', 'Bag', [...new Set(paths.map((p) => p[p.length - 1]!))]);
    if (paths.some((p) => p.length > 1)) array('lr', 'hierarchicalSubject', 'Bag', [...new Set(paths.map((p) => p.join('|')))]);
  }

  if (!attrs.length && !blocks.length) return '';

  const xmlns = (Object.keys(NS) as (keyof typeof NS)[]).filter((ns) => used.has(ns)).map((ns) => `xmlns:${ns}="${NS[ns]}"`);
  const head = ['rdf:about=""', ...xmlns, ...attrs].join('\n    ');
  const description = blocks.length ? [`  <rdf:Description ${head}>`, ...blocks, '  </rdf:Description>'] : [`  <rdf:Description ${head}/>`];
  return [
    '<?xpacket begin="\ufeff" id="W5M0MpCehiHzreSzNTczkc9d"?>',
    '<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="immich-raw">',
    ' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    ...description,
    ' </rdf:RDF>',
    '</x:xmpmeta>',
    '<?xpacket end="w"?>',
  ].join('\n');
}

// --- JPEG -----------------------------------------------------------------------------------

const XMP_ID = new TextEncoder().encode('http://ns.adobe.com/xap/1.0/\0');
const XMP_EXT_ID = new TextEncoder().encode('http://ns.adobe.com/xmp/extension/\0');
const EXIF_ID = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"
const JFIF_ID = [0x4a, 0x46, 0x49, 0x46, 0x00]; // "JFIF\0"

/** Largest packet a single standard-XMP APP1 segment may carry (XMP spec part 3). */
export const MAX_XMP_PACKET = 65502;

function startsWith(buf: Uint8Array, at: number, end: number, id: ArrayLike<number>): boolean {
  if (at + id.length > end) return false;
  for (let i = 0; i < id.length; i++) if (buf[at + i] !== id[i]) return false;
  return true;
}

/**
 * Returns a new JPEG with the XMP packet in an APP1 "http://ns.adobe.com/xap/1.0/\0" segment
 * right after the Exif APP1 (else after a JFIF APP0, else after SOI). Existing XMP APP1
 * segments, standard and extended, are removed; everything else is kept byte for byte.
 * An empty packet returns the input unchanged.
 */
export function insertXmp(jpeg: Uint8Array, xmp: string): Uint8Array {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('Not a JPEG (missing SOI).');
  if (!xmp) return jpeg;

  const packet = new TextEncoder().encode(xmp);
  if (packet.length > MAX_XMP_PACKET) throw new Error(`XMP packet too large for one APP1 segment (${packet.length} > ${MAX_XMP_PACKET} bytes).`);
  const segLength = 2 + XMP_ID.length + packet.length;

  // Header segments up to SOS, minus old XMP; remember where Exif / JFIF end.
  const kept: [number, number][] = [];
  let afterExif = -1;
  let afterJfif = -1;
  let p = 2;
  while (p + 4 <= jpeg.length) {
    if (jpeg[p] !== 0xff) throw new Error(`Corrupt JPEG: no marker at ${p}.`);
    const marker = jpeg[p + 1]!;
    if (marker === 0xff) {
      p++; // fill byte
      continue;
    }
    if (marker === 0xda || marker === 0xd9) break; // SOS / EOI: rest is copied as-is
    const len = (jpeg[p + 2]! << 8) | jpeg[p + 3]!;
    const end = p + 2 + len;
    if (len < 2 || end > jpeg.length) throw new Error(`Corrupt JPEG: bad segment length at ${p}.`);
    const isXmp = marker === 0xe1 && (startsWith(jpeg, p + 4, end, XMP_ID) || startsWith(jpeg, p + 4, end, XMP_EXT_ID));
    if (!isXmp) {
      kept.push([p, end]);
      if (afterExif < 0 && marker === 0xe1 && startsWith(jpeg, p + 4, end, EXIF_ID)) afterExif = kept.length;
      if (afterJfif < 0 && marker === 0xe0 && startsWith(jpeg, p + 4, end, JFIF_ID)) afterJfif = kept.length;
    }
    p = end;
  }
  // Index into `kept` before which the XMP segment goes.
  const at = afterExif >= 0 ? afterExif : afterJfif >= 0 ? afterJfif : 0;

  const keptBytes = kept.reduce((s, [a, b]) => s + (b - a), 0);
  const out = new Uint8Array(2 + 2 + segLength + keptBytes + (jpeg.length - p));
  out[0] = 0xff;
  out[1] = 0xd8;
  let o = 2;
  const copy = ([a, b]: [number, number]) => {
    out.set(jpeg.subarray(a, b), o);
    o += b - a;
  };
  kept.slice(0, at).forEach(copy);
  out[o++] = 0xff;
  out[o++] = 0xe1;
  out[o++] = segLength >> 8;
  out[o++] = segLength & 0xff;
  out.set(XMP_ID, o);
  o += XMP_ID.length;
  out.set(packet, o);
  o += packet.length;
  kept.slice(at).forEach(copy);
  out.set(jpeg.subarray(p), o);
  return out;
}
