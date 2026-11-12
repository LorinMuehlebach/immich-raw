import { describe, expect, it } from 'vitest';
import { decodeLosslessJpeg, encodeLosslessJpeg, optimalHuffman } from './ljpeg.ts';
import { cfaComponents, encodeCfaTile, tileLayout } from './tiles.ts';
import { rng } from './test-utils.ts';

function roundTrip(samples: Uint16Array, width: number, height: number, comps: number): void {
  const jpeg = encodeLosslessJpeg(samples, width, height, comps);
  const img = decodeLosslessJpeg(jpeg);
  expect([img.width, img.height, img.components, img.precision]).toEqual([width, height, comps, 16]);
  expect(img.data).toEqual(samples.subarray(0, width * height * comps));
}

describe('lossless JPEG', () => {
  it('round-trips random 16-bit data for 1..4 components and odd sizes', () => {
    const r = rng(7);
    for (const [w, h] of [
      [1, 1],
      [3, 5],
      [17, 9],
      [128, 64],
      [1, 40],
    ] as const) {
      for (let comps = 1; comps <= 4; comps++) {
        const s = new Uint16Array(w * h * comps);
        for (let i = 0; i < s.length; i++) s[i] = Math.floor(r() * 65536);
        roundTrip(s, w, h, comps);
      }
    }
  });

  it('round-trips extremes, jumps and the category-16 difference', () => {
    const w = 64;
    const h = 32;
    const s = new Uint16Array(w * h * 2);
    const vals = [0, 65535, 32768, 0, 32767, 65535, 1, 32768, 65534, 0];
    for (let i = 0; i < s.length; i++) s[i] = vals[(i * 7 + (i >> 5)) % vals.length]!;
    // 0 followed by 32768 in the same component: difference -32768 (category 16, no extra bits).
    s[0] = 0;
    s[2] = 32768;
    s[4] = 0;
    roundTrip(s, w, h, 2);
    roundTrip(s, w * 2, h, 1);
  });

  it('round-trips constant, smooth and 14-bit noisy data', () => {
    const r = rng(3);
    roundTrip(new Uint16Array(256 * 256).fill(512), 128, 256, 2);
    roundTrip(new Uint16Array(256 * 256).fill(65535), 256, 256, 1);
    const s = new Uint16Array(256 * 256);
    for (let i = 0; i < s.length; i++) s[i] = Math.min(16383, Math.max(0, Math.round(2000 + (i % 256) * 20 + (r() - 0.5) * 60)));
    roundTrip(s, 128, 256, 2);
  });

  it('builds length-limited Huffman codes without an all-ones code word', () => {
    // Fibonacci frequencies force a very deep unconstrained tree.
    const freq: number[] = [1, 1];
    while (freq.length < 17) freq.push(freq[freq.length - 1]! + freq[freq.length - 2]!);
    const { bits, values } = optimalHuffman(freq);
    expect(bits.length).toBe(17);
    expect(bits.slice(1).reduce((a, b) => a + b, 0)).toBe(17);
    expect(values.slice().sort((a, b) => a - b)).toEqual(Array.from({ length: 17 }, (_, i) => i));
    let kraft = 0;
    for (let l = 1; l <= 16; l++) kraft += bits[l]! / 2 ** l;
    expect(kraft).toBeLessThan(1); // the all-ones code of the longest length stays unused
    // A single symbol still gets a 1-bit code.
    const one = optimalHuffman([0, 0, 5, 0]);
    expect(one.bits[1]).toBe(1);
    expect(one.values).toEqual([2]);
  });
});

describe('encodeCfaTile', () => {
  const expectedTile = (data: Uint16Array, w: number, h: number, x0: number, y0: number, tw: number, th: number) => {
    const t = new Uint16Array(tw * th);
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) t[y * tw + x] = data[Math.min(h - 1, y0 + y) * w + Math.min(w - 1, x0 + x)]!;
    return t;
  };

  it('encodes every tile exactly, padding edge tiles by replicating the last column/row', () => {
    const r = rng(11);
    const w = 600;
    const h = 270;
    const data = new Uint16Array(w * h);
    for (let i = 0; i < data.length; i++) data[i] = r() < 0.01 ? (r() < 0.5 ? 0 : 65535) : Math.floor(r() * 16384);
    const layout = tileLayout(w, h);
    expect(layout).toMatchObject({ across: 3, down: 2, count: 6, tileWidth: 256, tileHeight: 256 });
    for (let i = 0; i < layout.count; i++) {
      const img = decodeLosslessJpeg(encodeCfaTile({ data, width: w, height: h, patternWidth: 2 }, i));
      expect(img.components).toBe(2);
      expect(img.width * img.components).toBe(256);
      expect(img.height).toBe(256);
      expect(img.data).toEqual(expectedTile(data, w, h, (i % 3) * 256, Math.floor(i / 3) * 256, 256, 256));
    }
  });

  it('never makes tiles wider than the image, and avoids LibRaw’s 2 x TileWidth special case', () => {
    expect(tileLayout(200, 900)).toMatchObject({ tileWidth: 200, tileHeight: 256, across: 1, down: 4 });
    expect(cfaComponents(6000, 256)).toBe(2);
    expect(cfaComponents(512, 256)).toBe(1);
    expect(cfaComponents(255, 255)).toBe(1);
    expect(cfaComponents(6000, 256, 6)).toBe(2);
    expect(cfaComponents(6000, 256, 1)).toBe(1);
    const r = rng(5);
    for (const [w, h] of [
      [512, 300],
      [255, 101],
    ] as const) {
      const data = new Uint16Array(w * h);
      for (let i = 0; i < data.length; i++) data[i] = Math.floor(r() * 4096);
      const layout = tileLayout(w, h);
      for (let i = 0; i < layout.count; i++) {
        const img = decodeLosslessJpeg(encodeCfaTile({ data, width: w, height: h, patternWidth: 2 }, i));
        expect(img.components).toBe(1);
        const x0 = (i % layout.across) * layout.tileWidth;
        const y0 = Math.floor(i / layout.across) * layout.tileHeight;
        expect(img.data).toEqual(expectedTile(data, w, h, x0, y0, layout.tileWidth, layout.tileHeight));
      }
    }
  });
});
