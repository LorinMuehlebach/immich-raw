import { describe, expect, it } from 'vitest';
import { crc32 } from './crc32.ts';
import { encodePng16 } from './png16.ts';

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
}

function chunks(png: Uint8Array): { type: string; data: Uint8Array }[] {
  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const out = [];
  for (let p = 8; p < png.length; ) {
    const len = dv.getUint32(p);
    const type = png.subarray(p + 4, p + 8);
    const data = png.subarray(p + 8, p + 8 + len);
    expect(dv.getUint32(p + 8 + len)).toBe(crc32(data, crc32(type)));
    out.push({ type: new TextDecoder().decode(type), data });
    p += 12 + len;
  }
  return out;
}

/** Undoes the PNG filters of 16-bit RGB rows (6 bytes per pixel) into samples. */
function unfilter(raw: Uint8Array, width: number, height: number): Uint16Array {
  const rowLen = width * 6;
  const out = new Uint16Array(width * height * 3);
  let prev = new Uint8Array(rowLen);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (rowLen + 1)]!;
    const line = raw.subarray(y * (rowLen + 1) + 1, (y + 1) * (rowLen + 1));
    const cur = new Uint8Array(rowLen);
    for (let i = 0; i < rowLen; i++) {
      const a = i >= 6 ? cur[i - 6]! : 0;
      const b = prev[i]!;
      const c = i >= 6 ? prev[i - 6]! : 0;
      let pred = 0;
      if (f === 1) pred = a;
      else if (f === 2) pred = b;
      else if (f === 3) pred = (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = (line[i]! + pred) & 0xff;
    }
    for (let i = 0; i < width * 3; i++) out[y * width * 3 + i] = (cur[i * 2]! << 8) | cur[i * 2 + 1]!;
    prev = cur;
  }
  return out;
}

describe('encodePng16', () => {
  it('writes 16-bit RGB that decodes back to the same samples, alpha dropped', async () => {
    const width = 37;
    const height = 23;
    const rgba = new Uint16Array(width * height * 4);
    for (let i = 0; i < rgba.length; i++) rgba[i] = (i * 2654435761) % 65536;
    const png = await encodePng16({ data: rgba, width, height });
    const cs = chunks(png);
    expect(cs[0]!.type).toBe('IHDR');
    const ihdr = new DataView(cs[0]!.data.buffer, cs[0]!.data.byteOffset, 13);
    expect([ihdr.getUint32(0), ihdr.getUint32(4), cs[0]!.data[8], cs[0]!.data[9]]).toEqual([width, height, 16, 2]);
    expect(cs.at(-1)!.type).toBe('IEND');
    const idat = cs.filter((c) => c.type === 'IDAT').map((c) => c.data);
    const joined = new Uint8Array(idat.reduce((s, d) => s + d.length, 0));
    let o = 0;
    for (const d of idat) {
      joined.set(d, o);
      o += d.length;
    }
    const samples = unfilter(await inflate(joined), width, height);
    const expected = new Uint16Array(width * height * 3);
    for (let p = 0; p < width * height; p++) expected.set(rgba.subarray(p * 4, p * 4 + 3), p * 3);
    expect(samples).toEqual(expected);
  });

  it('takes packed RGB too, and checks the size', async () => {
    const rgb = Uint16Array.from([65535, 0, 32768, 1, 2, 3]);
    const png = await encodePng16({ data: rgb, width: 2, height: 1 });
    const idat = chunks(png).find((c) => c.type === 'IDAT')!.data;
    expect([...unfilter(await inflate(idat), 2, 1)]).toEqual([...rgb]);
    await expect(encodePng16({ data: new Uint16Array(5), width: 2, height: 1 })).rejects.toThrow(/samples/);
  });
});
