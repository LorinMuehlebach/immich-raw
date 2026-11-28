import { describe, expect, it } from 'vitest';
import { insertExif } from './jpeg-segments.ts';
import { MAX_XMP_PACKET, buildXmp, insertXmp, type XmpFields } from './xmp-packet.ts';

// --- XML helpers -------------------------------------------------------------------------------

const unescape = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#xA;/g, '\n')
    .replace(/&#xD;/g, '\r')
    .replace(/&#x9;/g, '\t')
    .replace(/&amp;/g, '&');

/** Value of an attribute on rdf:Description, unescaped. */
function attr(xml: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(xml);
  return m ? unescape(m[1]!) : undefined;
}

/** The rdf:li items of a property, with the container kind. */
function items(xml: string, name: string): { kind: string; lang: (string | null)[]; values: string[] } | undefined {
  const m = new RegExp(`<${name}>\\s*<rdf:(Seq|Bag|Alt)>([\\s\\S]*?)</rdf:\\1>\\s*</${name}>`).exec(xml);
  if (!m) return undefined;
  const li = [...m[2]!.matchAll(/<rdf:li( xml:lang="([^"]*)")?>([^<]*)<\/rdf:li>/g)];
  return { kind: m[1]!, lang: li.map((l) => l[2] ?? null), values: li.map((l) => unescape(l[3]!)) };
}

/** Elements properly nested, no raw '<' or '&' in text, attribute values quoted. */
function expectWellFormed(xml: string): void {
  const stack: string[] = [];
  const body = xml.replace(/<\?[\s\S]*?\?>/g, '');
  const tags = /<(\/?)([A-Za-z][\w:.-]*)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>/g;
  let last = 0;
  for (const m of body.matchAll(tags)) {
    const text = body.slice(last, m.index);
    expect(text).not.toMatch(/[<>]|&(?!(amp|lt|gt|quot|apos|#x[0-9A-F]+);)/);
    last = m.index + m[0].length;
    if (m[1]) expect(stack.pop()).toBe(m[2]);
    else if (!m[4]) stack.push(m[2]!);
  }
  expect(body.slice(last).trim()).toBe('');
  expect(stack).toEqual([]);
}

const ALL: XmpFields = {
  creator: 'Jane Doe',
  rights: '© 2024 Jane Doe',
  description: 'Lake at dusk',
  keywords: ['Sunset', 'Places/Europe/Paris'],
  rating: 4,
  city: 'Zürich',
  state: 'ZH',
  country: 'Switzerland',
  createDate: '2022-12-17T16:03:36+08:00',
  creatorTool: 'immich-raw 1.0',
};

describe('buildXmp', () => {
  it('returns an empty string when nothing is set', () => {
    expect(buildXmp({})).toBe('');
    expect(buildXmp({ creator: '', rights: '  ', keywords: [], rating: 0 })).toBe('');
    expect(buildXmp({ keywords: ['', ' / '] })).toBe('');
  });

  it('writes every field in its RDF form inside an xpacket wrapper', () => {
    const xml = buildXmp(ALL);
    expect(xml.startsWith('<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>\n')).toBe(true);
    expect(xml.endsWith('\n<?xpacket end="w"?>')).toBe(true);
    expect(xml).toContain('<x:xmpmeta xmlns:x="adobe:ns:meta/"');
    expectWellFormed(xml);

    for (const [ns, uri] of [
      ['xmp', 'http://ns.adobe.com/xap/1.0/'],
      ['dc', 'http://purl.org/dc/elements/1.1/'],
      ['photoshop', 'http://ns.adobe.com/photoshop/1.0/'],
      ['xmpRights', 'http://ns.adobe.com/xap/1.0/rights/'],
      ['lr', 'http://ns.adobe.com/lightroom/1.0/'],
    ]) {
      expect(attr(xml, `xmlns:${ns}`)).toBe(uri);
    }

    expect(attr(xml, 'xmp:CreatorTool')).toBe('immich-raw 1.0');
    expect(attr(xml, 'xmp:CreateDate')).toBe('2022-12-17T16:03:36+08:00');
    expect(attr(xml, 'photoshop:DateCreated')).toBe('2022-12-17T16:03:36+08:00');
    expect(attr(xml, 'xmp:Rating')).toBe('4');
    expect(attr(xml, 'photoshop:City')).toBe('Zürich');
    expect(attr(xml, 'photoshop:State')).toBe('ZH');
    expect(attr(xml, 'photoshop:Country')).toBe('Switzerland');
    expect(attr(xml, 'xmpRights:Marked')).toBe('True');

    expect(items(xml, 'dc:creator')).toEqual({ kind: 'Seq', lang: [null], values: ['Jane Doe'] });
    expect(items(xml, 'dc:rights')).toEqual({ kind: 'Alt', lang: ['x-default'], values: ['© 2024 Jane Doe'] });
    expect(items(xml, 'dc:description')).toEqual({ kind: 'Alt', lang: ['x-default'], values: ['Lake at dusk'] });
    expect(items(xml, 'dc:subject')).toEqual({ kind: 'Bag', lang: [null, null], values: ['Sunset', 'Paris'] });
    expect(items(xml, 'lr:hierarchicalSubject')).toEqual({ kind: 'Bag', lang: [null, null], values: ['Sunset', 'Places|Europe|Paris'] });
  });

  it('declares only the namespaces it uses', () => {
    const xml = buildXmp({ rights: '© me' });
    expect(attr(xml, 'xmlns:dc')).toBeDefined();
    expect(attr(xml, 'xmlns:xmpRights')).toBeDefined();
    expect(xml).not.toContain('xmlns:xmp=');
    expect(xml).not.toContain('xmlns:photoshop');
    expect(xml).not.toContain('xmlns:lr');
    expectWellFormed(xml);
  });

  it('writes an empty rdf:Description element when there are only simple properties', () => {
    const xml = buildXmp({ rating: 5 });
    expect(xml).toMatch(/<rdf:Description [^>]*xmp:Rating="5"\/>/);
    expectWellFormed(xml);
  });

  it('escapes markup characters and keeps unicode', () => {
    const nasty = `Tom & "Jerry" <b>'s</b> — 東京 🌸`;
    const xml = buildXmp({ creator: nasty, rights: nasty, description: `line 1\nline 2\r\n${nasty}`, city: nasty, keywords: [nasty, `a<b/c&d`] });
    expectWellFormed(xml);
    expect(xml).not.toContain('<b>');
    expect(xml).toContain('東京 🌸');
    expect(xml).toContain('Tom &amp; &quot;Jerry&quot; &lt;b&gt;&apos;s&lt;');
    expect(items(xml, 'dc:creator')!.values).toEqual([nasty]);
    expect(items(xml, 'dc:rights')!.values).toEqual([nasty]);
    expect(items(xml, 'dc:description')!.values).toEqual([`line 1\nline 2\r\n${nasty}`]);
    expect(attr(xml, 'photoshop:City')).toBe(nasty);
    // The keyword with a '/' in its <b> tag splits there, like any hierarchical keyword.
    expect(items(xml, 'dc:subject')!.values).toEqual(['b> — 東京 🌸', 'c&d']);
    expect(items(xml, 'lr:hierarchicalSubject')!.values).toEqual([`Tom & "Jerry" <b>'s<|b> — 東京 🌸`, 'a<b|c&d']);
  });

  it('keeps newlines in attribute values and drops characters XML cannot hold', () => {
    const xml = buildXmp({ city: 'a\nb\tc', country: 'x\u0001y\u001fz\ud800' });
    expect(xml).toContain('photoshop:City="a&#xA;b&#x9;c"');
    expect(attr(xml, 'photoshop:Country')).toBe('xyz');
  });

  it('writes hierarchical keywords as paths and their leaves as subjects, deduplicated', () => {
    const xml = buildXmp({ keywords: ['Places/Europe/Paris', 'Places / Asia/ Tokyo ', 'Paris', 'People//Anna', 'Places/Europe/Paris'] });
    expect(items(xml, 'dc:subject')!.values).toEqual(['Paris', 'Tokyo', 'Anna']);
    expect(items(xml, 'lr:hierarchicalSubject')!.values).toEqual(['Places|Europe|Paris', 'Places|Asia|Tokyo', 'Paris', 'People|Anna']);
  });

  it('leaves out lr:hierarchicalSubject when no keyword is hierarchical', () => {
    const xml = buildXmp({ keywords: ['Sunset', 'Lake'] });
    expect(items(xml, 'dc:subject')!.values).toEqual(['Sunset', 'Lake']);
    expect(xml).not.toContain('lr:');
  });

  it("writes tag paths as digiKam:TagsList, the list Immich reads a file's tags from", () => {
    const xml = buildXmp({ tagsList: ['Travel', 'Places / Asia/Shanghai', 'Culling/Rejected/Blur', 'Travel', '  '] });
    expectWellFormed(xml);
    expect(attr(xml, 'xmlns:digiKam')).toBe('http://www.digikam.org/ns/1.0/');
    expect(items(xml, 'digiKam:TagsList')).toMatchObject({ values: ['Travel', 'Places/Asia/Shanghai', 'Culling/Rejected/Blur'] });
    expect(xml).toContain('<rdf:Seq>');
    expect(xml).not.toContain('dc:subject');
    expect(buildXmp({ tagsList: [] })).toBe('');
  });

  it('writes ratings -1 and 1..5 only', () => {
    expect(attr(buildXmp({ rating: -1 }), 'xmp:Rating')).toBe('-1');
    expect(attr(buildXmp({ rating: 1 }), 'xmp:Rating')).toBe('1');
    for (const rating of [0, 6, -2, 2.5, Number.NaN]) expect(buildXmp({ rating })).toBe('');
  });

  it('checks the date format', () => {
    for (const d of ['2022-12-17T16:03:36', '2022-12-17T16:03:36Z', '2022-12-17T16:03:36.25-05:00', '2022-12-17', '2022']) {
      expect(attr(buildXmp({ createDate: d }), 'xmp:CreateDate')).toBe(d);
    }
    expect(() => buildXmp({ createDate: '2022:12:17 16:03:36' })).toThrow(/ISO 8601/);
  });
});

// --- JPEG ----------------------------------------------------------------------------------------

const seg = (marker: number, payload: number[]) => [0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff, ...payload];
const text = (s: string) => [...new TextEncoder().encode(s)];

const APP0_JFIF = seg(0xe0, [...text('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
const APP1_EXIF = seg(0xe1, [...text('Exif'), 0, 0, 0x49, 0x49, 42, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const APP1_OLD_XMP = seg(0xe1, [...text('http://ns.adobe.com/xap/1.0/\0'), ...text('<x:xmpmeta>old</x:xmpmeta>')]);
const APP1_EXT_XMP = seg(0xe1, [...text('http://ns.adobe.com/xmp/extension/\0'), ...new Array<number>(40).fill(0x41)]);
const APP2_ICC = seg(0xe2, [...text('ICC_PROFILE'), 0, 1, 1, 9, 9, 9]);
const DQT = seg(0xdb, [0, ...Array.from({ length: 64 }, (_, i) => i + 1)]);
const SOF0 = seg(0xc0, [8, 0, 16, 0, 16, 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1]);
const SOS_AND_SCAN = [...seg(0xda, [3, 1, 0, 2, 0x11, 3, 0x11, 0, 63, 0]), 0x12, 0xff, 0x00, 0x34, 0x56, 0xff, 0xd9];

function makeJpeg(...segments: number[][]): Uint8Array {
  return Uint8Array.from([0xff, 0xd8, ...segments.flat(), ...SOS_AND_SCAN]);
}

/** Header segments as [marker, start, end] plus the offset of SOS. */
function segments(jpeg: Uint8Array) {
  const list: { marker: number; start: number; end: number }[] = [];
  let p = 2;
  while (jpeg[p + 1] !== 0xda) {
    const len = (jpeg[p + 2]! << 8) | jpeg[p + 3]!;
    list.push({ marker: jpeg[p + 1]!, start: p, end: p + 2 + len });
    p += 2 + len;
  }
  return { list, sos: p };
}

const startsWithText = (buf: Uint8Array, at: number, s: string) => text(s).every((c, i) => buf[at + i] === c);
const isXmpSeg = (jpeg: Uint8Array, s: { marker: number; start: number }) => s.marker === 0xe1 && startsWithText(jpeg, s.start + 4, 'http://ns.adobe.com/xap/1.0/\0');
const isExtSeg = (jpeg: Uint8Array, s: { marker: number; start: number }) => s.marker === 0xe1 && startsWithText(jpeg, s.start + 4, 'http://ns.adobe.com/xmp/extension/\0');

/** The packet in the (single) XMP segment. */
function packetOf(jpeg: Uint8Array): string {
  const xmp = segments(jpeg).list.filter((s) => isXmpSeg(jpeg, s));
  expect(xmp).toHaveLength(1);
  return new TextDecoder().decode(jpeg.subarray(xmp[0]!.start + 4 + 29, xmp[0]!.end));
}

/** Every non-XMP header segment of `input` appears in `out` byte for byte, in the same order, and so does the scan. */
function expectPreserved(input: Uint8Array, out: Uint8Array): void {
  const a = segments(input);
  const b = segments(out);
  const bytesOf = (buf: Uint8Array, s: { start: number; end: number }) => Array.from(buf.subarray(s.start, s.end));
  const keep = (buf: Uint8Array, l: typeof a.list) => l.filter((s) => !isXmpSeg(buf, s) && !isExtSeg(buf, s)).map((s) => bytesOf(buf, s));
  expect(keep(out, b.list)).toEqual(keep(input, a.list));
  expect(Array.from(out.subarray(b.sos))).toEqual(Array.from(input.subarray(a.sos)));
}

describe('insertXmp', () => {
  const xmp = buildXmp(ALL);

  it('puts the segment right after the Exif APP1 with a correct length', () => {
    const input = makeJpeg(APP1_EXIF, APP2_ICC, DQT, SOF0);
    const out = insertXmp(input, xmp);
    const { list } = segments(out);
    expect(list.map((s) => s.marker)).toEqual([0xe1, 0xe1, 0xe2, 0xdb, 0xc0]);
    expect(startsWithText(out, list[0]!.start + 4, 'Exif\0\0')).toBe(true);
    expect(isXmpSeg(out, list[1]!)).toBe(true);
    const len = (out[list[1]!.start + 2]! << 8) | out[list[1]!.start + 3]!;
    const packet = new TextEncoder().encode(xmp);
    expect(len).toBe(2 + 29 + packet.length);
    expect(list[1]!.end - list[1]!.start).toBe(len + 2);
    expect(Array.from(out.subarray(list[1]!.start + 4 + 29, list[1]!.end))).toEqual(Array.from(packet));
    expect(packetOf(out)).toBe(xmp);
    expect(out.length).toBe(input.length + 4 + 29 + packet.length);
    expectPreserved(input, out);
  });

  it('goes after JFIF APP0 when there is no Exif, else right after SOI', () => {
    const jfif = insertXmp(makeJpeg(APP0_JFIF, DQT, SOF0), xmp);
    const a = segments(jfif).list;
    expect(a.map((s) => s.marker)).toEqual([0xe0, 0xe1, 0xdb, 0xc0]);
    expect(isXmpSeg(jfif, a[1]!)).toBe(true);
    expectPreserved(makeJpeg(APP0_JFIF, DQT, SOF0), jfif);

    const bare = insertXmp(makeJpeg(DQT, SOF0), xmp);
    const b = segments(bare).list;
    expect(b.map((s) => s.marker)).toEqual([0xe1, 0xdb, 0xc0]);
    expect(isXmpSeg(bare, b[0]!)).toBe(true);
    expectPreserved(makeJpeg(DQT, SOF0), bare);
  });

  it('follows an Exif APP1 that comes after JFIF', () => {
    const out = insertXmp(makeJpeg(APP0_JFIF, APP1_EXIF, DQT), xmp);
    const { list } = segments(out);
    expect(list.map((s) => s.marker)).toEqual([0xe0, 0xe1, 0xe1, 0xdb]);
    expect(isXmpSeg(out, list[2]!)).toBe(true);
  });

  it('replaces existing standard and extended XMP', () => {
    const input = makeJpeg(APP1_EXIF, APP1_OLD_XMP, APP2_ICC, APP1_EXT_XMP, DQT, SOF0);
    const out = insertXmp(input, xmp);
    const { list } = segments(out);
    expect(list.filter((s) => isExtSeg(out, s))).toHaveLength(0);
    expect(packetOf(out)).toBe(xmp);
    expect(list.map((s) => s.marker)).toEqual([0xe1, 0xe1, 0xe2, 0xdb, 0xc0]);
    expectPreserved(input, out);
    // Inserting again replaces rather than adds.
    const again = insertXmp(out, buildXmp({ rating: 2 }));
    expect(packetOf(again)).toBe(buildXmp({ rating: 2 }));
    expect(segments(again).list).toHaveLength(5);
  });

  it('works on the output of insertExif, in either order', () => {
    const base = makeJpeg(APP0_JFIF, DQT, SOF0);
    const exifFirst = insertXmp(insertExif(base, { make: 'X', copyright: 'me' }), xmp);
    const xmpFirst = insertExif(insertXmp(base, xmp), { make: 'X', copyright: 'me' });
    expect(Array.from(exifFirst)).toEqual(Array.from(xmpFirst));
    const { list } = segments(exifFirst);
    expect(startsWithText(exifFirst, list[0]!.start + 4, 'Exif\0\0')).toBe(true);
    expect(isXmpSeg(exifFirst, list[1]!)).toBe(true);
  });

  it('returns the input for an empty packet', () => {
    const input = makeJpeg(APP1_EXIF, APP1_OLD_XMP, DQT);
    expect(insertXmp(input, '')).toBe(input);
  });

  it('accepts a packet up to the single-segment limit and rejects larger ones', () => {
    const fits = 'x'.repeat(MAX_XMP_PACKET);
    const out = insertXmp(makeJpeg(DQT), fits);
    expect(MAX_XMP_PACKET).toBe(65502);
    expect((out[4]! << 8) | out[5]!).toBe(2 + 29 + MAX_XMP_PACKET);
    expect(packetOf(out)).toBe(fits);
    expect(() => insertXmp(makeJpeg(DQT), fits + 'x')).toThrow(/too large/);
    // The limit is in UTF-8 bytes, not characters.
    expect(() => insertXmp(makeJpeg(DQT), 'é'.repeat(MAX_XMP_PACKET / 2 + 1))).toThrow(/too large/);
  });

  it('rejects non-JPEG input and truncated segments', () => {
    expect(() => insertXmp(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]), xmp)).toThrow(/SOI/);
    expect(() => insertXmp(Uint8Array.from([0xff, 0xd8, 0xff, 0xe2, 0x10, 0x00, 1, 2, 3]), xmp)).toThrow(/segment length/);
  });
});
