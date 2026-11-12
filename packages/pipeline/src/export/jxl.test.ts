import { describe, expect, it } from 'vitest';
import { jxlContainer } from './jxl.ts';

const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const SIGNATURE = [0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a];

function boxesOf(file: Uint8Array): { type: string; payload: Uint8Array }[] {
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const out = [];
  let p = 0;
  while (p < file.length) {
    const size = dv.getUint32(p);
    out.push({ type: String.fromCharCode(...file.subarray(p + 4, p + 8)), payload: file.subarray(p + 8, p + size) });
    p += size;
  }
  expect(p).toBe(file.length);
  return out;
}

function box(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length);
  new DataView(out.buffer).setUint32(0, out.length);
  out.set(ascii(type), 4);
  out.set(payload, 8);
  return out;
}

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

describe('jxlContainer', () => {
  const codestream = Uint8Array.of(0xff, 0x0a, 1, 2, 3, 4, 5);
  const exif = ascii('II*\0exif');
  const xmp = '<x:xmpmeta/>';

  it('puts a bare codestream in a container with Exif and xml boxes before it', () => {
    const out = jxlContainer(codestream, { exif, xmp });
    expect([...out.subarray(0, 12)]).toEqual(SIGNATURE);
    const boxes = boxesOf(out);
    expect(boxes.map((b) => b.type)).toEqual(['JXL ', 'ftyp', 'Exif', 'xml ', 'jxlc']);
    expect(String.fromCharCode(...boxes[1]!.payload)).toBe('jxl \0\0\0\0jxl ');
    // Exif box: a 4-byte offset to the TIFF header, then the TIFF block.
    expect([...boxes[2]!.payload]).toEqual([0, 0, 0, 0, ...exif]);
    expect(new TextDecoder().decode(boxes[3]!.payload)).toBe(xmp);
    expect([...boxes[4]!.payload]).toEqual([...codestream]);
  });

  it('keeps the boxes of a container and replaces its metadata', () => {
    const container = concat(Uint8Array.from(SIGNATURE), box('ftyp', ascii('jxl \0\0\0\0jxl ')), box('jxll', Uint8Array.of(10)), box('Exif', ascii('\0\0\0\0old')), box('jxlc', codestream));
    const boxes = boxesOf(jxlContainer(container, { xmp }));
    expect(boxes.map((b) => b.type)).toEqual(['JXL ', 'ftyp', 'jxll', 'xml ', 'jxlc']);
  });

  it('returns the input without metadata, and rejects what is not JPEG XL', () => {
    expect(jxlContainer(codestream, {})).toBe(codestream);
    expect(() => jxlContainer(Uint8Array.of(0xff, 0xd8, 0), { exif })).toThrow(/Not a JPEG XL/);
    expect(() => jxlContainer(concat(Uint8Array.from(SIGNATURE), box('ftyp', ascii('jxl \0\0\0\0jxl '))), { exif })).toThrow(/no codestream/);
  });
});
