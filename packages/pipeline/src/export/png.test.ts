import { describe, expect, it } from 'vitest';
import { crc32 } from './crc32.ts';
import { buildTiff } from './jpeg-segments.ts';
import { addPngMetadata } from './png.ts';
import { buildXmp } from './xmp-packet.ts';

/** zlib (de)compression through the web streams API. */
async function zlib(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([new Uint8Array(bytes)]).stream().pipeThrough(stream)).arrayBuffer());
}
const deflate = (bytes: Uint8Array) => zlib(bytes, new CompressionStream('deflate'));
const inflate = (bytes: Uint8Array) => zlib(bytes, new DecompressionStream('deflate'));

// --- a minimal valid PNG -------------------------------------------------------------------------

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const ascii = (s: string) => new TextEncoder().encode(s);

function chunk(type: string, data: ArrayLike<number>): Uint8Array {
  const body = Uint8Array.from(data);
  const out = new Uint8Array(12 + body.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, body.length);
  out.set(ascii(type), 4);
  out.set(body, 8);
  dv.setUint32(8 + body.length, crc32(body, crc32(ascii(type))));
  return out;
}

const concat = (...parts: ArrayLike<number>[]) => {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

const W = 5;
const H = 3;

/** Filter type 0 scanlines of a small RGB gradient. */
const RAW = (() => {
  const raw = new Uint8Array(H * (1 + W * 3));
  for (let y = 0; y < H; y++) for (let x = 0; x < W * 3; x++) raw[y * (1 + W * 3) + 1 + x] = (x * 17 + y * 40) & 255;
  return raw;
})();

function ihdr(): Uint8Array {
  const d = new Uint8Array(13);
  const dv = new DataView(d.buffer);
  dv.setUint32(0, W);
  dv.setUint32(4, H);
  d.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  return chunk('IHDR', d);
}

/** The compressed image split over two IDAT chunks. */
const IDATS = await (async () => {
  const z = await deflate(RAW);
  const half = z.length >> 1;
  return [chunk('IDAT', z.subarray(0, half)), chunk('IDAT', z.subarray(half))];
})();
const IEND = chunk('IEND', []);

function makePng(...extra: { beforeIdat?: Uint8Array[]; afterIdat?: Uint8Array[] }[]): Uint8Array {
  const before = extra.flatMap((e) => e.beforeIdat ?? []);
  const after = extra.flatMap((e) => e.afterIdat ?? []);
  return concat(SIGNATURE, ihdr(), ...before, ...IDATS, ...after, IEND);
}

const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const itxt = (keyword: string, text: string) => chunk('iTXt', concat(ascii(keyword), [0, 0, 0, 0, 0], ascii(text)));

const GAMA = chunk('gAMA', u32(45455));
const CHRM = chunk('cHRM', [...u32(31270), ...u32(32900), ...u32(64000), ...u32(33000), ...u32(30000), ...u32(60000), ...u32(15000), ...u32(6000)]);
const ICCP = chunk('iCCP', concat(ascii('icc'), [0, 0], await deflate(new Uint8Array(32))));
const OLD_SRGB = chunk('sRGB', [3]);
const OLD_PHYS = chunk('pHYs', [...u32(2835), ...u32(2835), 1]);
const OLD_EXIF = chunk('eXIf', [0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0]);
const OLD_XMP = itxt('XML:com.adobe.xmp', '<x:xmpmeta>old</x:xmpmeta>');
const OTHER_ITXT = itxt('Description', 'kept');
const TEXT = chunk('tEXt', concat(ascii('Comment'), [0], ascii('hello')));
const TIME = chunk('tIME', [0x07, 0xe8, 7, 1, 12, 0, 0]);

// --- reading back ---------------------------------------------------------------------------------

interface ReadChunk {
  type: string;
  data: Uint8Array;
  /** The whole chunk. */
  bytes: Uint8Array;
}

function parsePng(png: Uint8Array): ReadChunk[] {
  expect(Array.from(png.subarray(0, 8))).toEqual(SIGNATURE);
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const out: ReadChunk[] = [];
  let p = 8;
  while (p < png.length) {
    const len = dv.getUint32(p);
    const typeBytes = png.subarray(p + 4, p + 8);
    const data = png.subarray(p + 8, p + 8 + len);
    expect(dv.getUint32(p + 8 + len)).toBe(crc32(data, crc32(typeBytes))); // CRC valid
    out.push({ type: new TextDecoder().decode(typeBytes), data, bytes: png.subarray(p, p + 12 + len) });
    p += 12 + len;
  }
  expect(p).toBe(png.length);
  return out;
}

const types = (png: Uint8Array) => parsePng(png).map((c) => c.type);
const find = (png: Uint8Array, type: string) => parsePng(png).filter((c) => c.type === type);

function xmpOf(png: Uint8Array): string[] {
  const key = 'XML:com.adobe.xmp';
  return find(png, 'iTXt')
    .filter((c) => new TextDecoder().decode(c.data.subarray(0, key.length + 1)) === `${key}\0`)
    .map((c) => {
      // keyword \0, compression flag, method, language \0, translated keyword \0, text
      const d = c.data.subarray(key.length + 1);
      expect(Array.from(d.subarray(0, 4))).toEqual([0, 0, 0, 0]);
      return new TextDecoder().decode(d.subarray(4));
    });
}

const xmp = buildXmp({ creator: 'Zoë', rights: '© 2024 Zoë', keywords: ['Places/Europe/Zürich'] });
const tiff = buildTiff({ make: 'SONY', copyright: '© 2024 Zoë', resolution: 300 });

describe('addPngMetadata', () => {
  it('writes sRGB and pHYs after IHDR, eXIf and XMP before IDAT, with valid CRCs', async () => {
    const input = makePng();
    const out = addPngMetadata(input, { exif: tiff, xmp, ppi: 300, srgb: true });
    expect(types(out)).toEqual(['IHDR', 'sRGB', 'pHYs', 'eXIf', 'iTXt', 'IDAT', 'IDAT', 'IEND']);

    expect(Array.from(find(out, 'sRGB')[0]!.data)).toEqual([0]);
    const phys = find(out, 'pHYs')[0]!.data;
    const dv = new DataView(phys.buffer, phys.byteOffset, phys.byteLength);
    expect(phys.length).toBe(9);
    expect([dv.getUint32(0), dv.getUint32(4), phys[8]]).toEqual([11811, 11811, 1]);
    expect(Array.from(find(out, 'eXIf')[0]!.data)).toEqual(Array.from(tiff));
    expect(xmpOf(out)).toEqual([xmp]);

    // Image data untouched.
    const idat = concat(...find(out, 'IDAT').map((c) => c.data));
    expect(Array.from(await inflate(idat))).toEqual(Array.from(RAW));
    expect(out.length).toBe(input.length + 13 + 21 + 12 + tiff.length + 12 + 22 + new TextEncoder().encode(xmp).length);
  });

  it('removes duplicates and chunks that conflict with sRGB, keeps the rest byte for byte', () => {
    const input = makePng({ beforeIdat: [GAMA, CHRM, ICCP, OLD_SRGB, OLD_PHYS, TEXT, OLD_XMP, OTHER_ITXT, OLD_EXIF], afterIdat: [TIME] });
    const out = addPngMetadata(input, { exif: tiff, xmp, ppi: 300, srgb: true });
    expect(types(out)).toEqual(['IHDR', 'sRGB', 'pHYs', 'tEXt', 'iTXt', 'eXIf', 'iTXt', 'IDAT', 'IDAT', 'tIME', 'IEND']);
    const chunks = parsePng(out);
    expect(chunks[3]!.bytes).toEqual(TEXT);
    expect(chunks[4]!.bytes).toEqual(OTHER_ITXT);
    expect(chunks[7]!.bytes).toEqual(IDATS[0]);
    expect(chunks[8]!.bytes).toEqual(IDATS[1]);
    expect(chunks[9]!.bytes).toEqual(TIME);
    expect(chunks[10]!.bytes).toEqual(IEND);
    expect(Array.from(chunks[1]!.data)).toEqual([0]);
    expect(xmpOf(out)).toEqual([xmp]);
    expect(find(out, 'eXIf')).toHaveLength(1);
  });

  it('only replaces the kinds it writes', () => {
    const input = makePng({ beforeIdat: [GAMA, ICCP, OLD_PHYS, OLD_XMP, OLD_EXIF] });
    const out = addPngMetadata(input, { ppi: 72 });
    expect(types(out)).toEqual(['IHDR', 'pHYs', 'gAMA', 'iCCP', 'iTXt', 'eXIf', 'IDAT', 'IDAT', 'IEND']);
    const phys = find(out, 'pHYs')[0]!.data;
    expect(new DataView(phys.buffer, phys.byteOffset).getUint32(0)).toBe(2835); // 72 ppi
    expect(xmpOf(out)).toEqual(['<x:xmpmeta>old</x:xmpmeta>']);

    const exifOnly = addPngMetadata(input, { exif: tiff });
    expect(types(exifOnly)).toEqual(['IHDR', 'gAMA', 'iCCP', 'pHYs', 'iTXt', 'eXIf', 'IDAT', 'IDAT', 'IEND']);
    expect(Array.from(find(exifOnly, 'eXIf')[0]!.data)).toEqual(Array.from(tiff));
  });

  it('treats a bad ppi and an empty XMP packet as not given', () => {
    const input = makePng({ beforeIdat: [OLD_PHYS, OLD_XMP] });
    for (const ppi of [0, -10, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(Array.from(addPngMetadata(input, { ppi, xmp: '' }))).toEqual(Array.from(input));
    }
    expect(Array.from(addPngMetadata(input, {}))).toEqual(Array.from(input));
  });

  it('keeps bytes after IEND', () => {
    const input = concat(makePng(), [1, 2, 3]);
    const out = addPngMetadata(input, { srgb: true });
    expect(Array.from(out.subarray(out.length - 3))).toEqual([1, 2, 3]);
  });

  it('rejects broken input', () => {
    expect(() => addPngMetadata(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]), { srgb: true })).toThrow(/signature/);
    expect(() => addPngMetadata(concat(SIGNATURE, ihdr(), IEND), { srgb: true })).toThrow(/IDAT/);
    expect(() => addPngMetadata(concat(SIGNATURE, IDATS[0]!, ihdr(), IEND), { srgb: true })).toThrow(/IHDR/);
    const truncated = makePng().subarray(0, 8 + 25 + 10);
    expect(() => addPngMetadata(truncated, { srgb: true })).toThrow(/Corrupt PNG/);
    expect(() => addPngMetadata(makePng(), { exif: Uint8Array.from([1, 2, 3, 4]) })).toThrow(/TIFF/);
  });
});
