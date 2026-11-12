import { describe, expect, it } from 'vitest';
import { outputSharpen, sharpenParams, type RgbaImage, type SharpenLevel, type SharpenMedia } from './sharpen.ts';

const MEDIA: SharpenMedia[] = ['screen', 'matte', 'glossy'];
const LEVELS: SharpenLevel[] = ['low', 'standard', 'high'];

function image(width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number]): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data.set(pixel(x, y), (y * width + x) * 4);
  }
  return { data, width, height };
}

const at = (img: RgbaImage, x: number, y: number) => Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));

/** Grey step edge between x = 9 and x = 10 (or y, when vertical). */
const greyEdge = (lo: number, hi: number, vertical = false) =>
  image(20, 20, (x, y) => {
    const v = (vertical ? y : x) < 10 ? lo : hi;
    return [v, v, v, 255];
  });

describe('sharpenParams', () => {
  it('grows the paper radius with the print resolution', () => {
    for (const media of ['matte', 'glossy'] as const) {
      const r = (ppi: number) => sharpenParams(media, 'standard', ppi).radius;
      expect(r(240)).toBeLessThan(r(300));
      expect(r(300)).toBeLessThan(r(600));
      expect(r(300)).toBeCloseTo(1);
    }
  });

  it('keeps the paper radius in a sane range', () => {
    expect(sharpenParams('matte', 'standard', 72).radius).toBe(0.5);
    expect(sharpenParams('glossy', 'standard', 2400).radius).toBe(3);
  });

  it('gives matte more amount than glossy', () => {
    for (const level of LEVELS) {
      expect(sharpenParams('matte', level, 300).amount).toBeGreaterThan(sharpenParams('glossy', level, 300).amount);
    }
  });

  it('orders the levels low < standard < high', () => {
    for (const media of MEDIA) {
      const a = (level: SharpenLevel) => sharpenParams(media, level, 300).amount;
      expect(a('low')).toBeLessThan(a('standard'));
      expect(a('standard')).toBeLessThan(a('high'));
      expect(a('high')).toBeLessThanOrEqual(1.5);
    }
  });

  it('ignores ppi on screen, with a sub-pixel radius', () => {
    const ref = sharpenParams('screen', 'standard', 300);
    for (const ppi of [72, 96, 240, 1200, 0, NaN]) expect(sharpenParams('screen', 'standard', ppi)).toEqual(ref);
    expect(ref.radius).toBeGreaterThanOrEqual(0.5);
    expect(ref.radius).toBeLessThanOrEqual(0.8);
  });

  it('treats a missing or invalid ppi as 300 for paper', () => {
    const ref = sharpenParams('matte', 'high', 300);
    for (const ppi of [0, -150, NaN, Infinity]) expect(sharpenParams('matte', 'high', ppi)).toEqual(ref);
  });
});

describe('outputSharpen', () => {
  it('leaves a flat image unchanged', () => {
    for (const media of MEDIA) {
      for (const level of LEVELS) {
        const img = image(16, 12, () => [180, 90, 30, 255]);
        const before = img.data.slice();
        outputSharpen(img, media, level, 300);
        expect(img.data).toEqual(before);
      }
    }
  });

  it('adds overshoot on both sides of an edge', () => {
    for (const vertical of [false, true]) {
      for (const media of MEDIA) {
        const img = greyEdge(100, 150, vertical);
        outputSharpen(img, media, 'standard', 300);
        const px = (i: number) => (vertical ? at(img, 5, i) : at(img, i, 5))[0];
        expect(px(9)).toBeLessThan(100);
        expect(px(10)).toBeGreaterThan(150);
        // far from the edge nothing changes
        expect(px(0)).toBe(100);
        expect(px(19)).toBe(150);
      }
    }
  });

  it('clamps to 0..255 instead of wrapping', () => {
    const img = greyEdge(10, 245);
    outputSharpen(img, 'matte', 'high', 300);
    expect(at(img, 9, 5)).toEqual([0, 0, 0, 255]);
    expect(at(img, 10, 5)).toEqual([255, 255, 255, 255]);
    expect(at(img, 0, 5)).toEqual([10, 10, 10, 255]);
  });

  it('sharpens 16-bit images like 8-bit ones, clamped to 0..65535 instead of wrapping', () => {
    const wide = (lo: number, hi: number): RgbaImage => {
      const data = new Uint16Array(20 * 20 * 4);
      for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) data.set(x < 10 ? [lo, lo, lo, 65535] : [hi, hi, hi, 65535], (y * 20 + x) * 4);
      return { data, width: 20, height: 20 };
    };
    const eight = greyEdge(100, 150);
    const sixteen = wide(100 * 257, 150 * 257);
    outputSharpen(eight, 'screen', 'standard', 300);
    outputSharpen(sixteen, 'screen', 'standard', 300);
    for (const x of [8, 9, 10, 11]) expect(at(sixteen, x, 5)[0]! / 257).toBeCloseTo(at(eight, x, 5)[0]!, 0);
    const extreme = wide(2000, 63000);
    outputSharpen(extreme, 'matte', 'high', 300);
    expect(at(extreme, 9, 5)).toEqual([0, 0, 0, 65535]);
    expect(at(extreme, 10, 5)).toEqual([65535, 65535, 65535, 65535]);
  });

  it('weights R, G and B by the luma it is given', () => {
    const red = () => image(20, 20, (x) => (x < 10 ? [100, 120, 120, 255] : [200, 120, 120, 255]));
    const rec709 = red();
    const redHeavy = red();
    outputSharpen(rec709, 'screen', 'high', 300);
    outputSharpen(redHeavy, 'screen', 'high', 300, [0.6, 0.3, 0.1]);
    // An edge in red alone has more luma detail when red weighs more.
    expect(at(redHeavy, 10, 5)[1]! - 120).toBeGreaterThan(at(rec709, 10, 5)[1]! - 120);
  });

  it('reaches further from the edge with a larger radius', () => {
    const screen = greyEdge(100, 150);
    const print = greyEdge(100, 150);
    outputSharpen(screen, 'screen', 'standard', 300);
    outputSharpen(print, 'matte', 'standard', 600);
    expect(at(screen, 7, 5)[0]).toBe(100);
    expect(at(print, 7, 5)[0]).toBeLessThan(100);
  });

  it('leaves alpha untouched', () => {
    const img = image(20, 20, (x, y) => (x < 10 ? [40, 40, 40, (x * 13 + y * 7) % 256] : [220, 200, 180, (x * 5 + y * 11) % 256]));
    const before = img.data.slice();
    outputSharpen(img, 'matte', 'high', 300);
    let changed = 0;
    for (let i = 0; i < img.data.length; i += 4) {
      expect(img.data[i + 3]).toBe(before[i + 3]);
      if (img.data[i] !== before[i]) changed++;
    }
    expect(changed).toBeGreaterThan(0);
  });

  it('shifts R, G and B by the same amount', () => {
    const grey = greyEdge(60, 190);
    outputSharpen(grey, 'glossy', 'high', 300);
    for (let i = 0; i < grey.data.length; i += 4) {
      expect(grey.data[i + 1]).toBe(grey.data[i]);
      expect(grey.data[i + 2]).toBe(grey.data[i]);
    }

    const colour = image(20, 20, (x) => (x < 10 ? [100, 60, 40, 255] : [160, 120, 100, 255]));
    outputSharpen(colour, 'matte', 'standard', 300);
    for (let i = 0; i < colour.data.length; i += 4) {
      expect(colour.data[i] - colour.data[i + 1]).toBe(40);
      expect(colour.data[i + 1] - colour.data[i + 2]).toBe(20);
    }
    expect(at(colour, 10, 5)[0]).toBeGreaterThan(160);
  });

  it('ignores low-level noise below the threshold', () => {
    const img = image(24, 24, (x, y) => {
      const v = 128 + ((x + y) % 2);
      return [v, v, v, 255];
    });
    const before = img.data.slice();
    for (const media of MEDIA) outputSharpen(img, media, 'high', 300);
    expect(img.data).toEqual(before);
  });

  it('does nothing to images smaller than 3 px', () => {
    const img = image(2, 8, (x) => (x === 0 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    const before = img.data.slice();
    outputSharpen(img, 'matte', 'high', 300);
    expect(img.data).toEqual(before);
  });
});
