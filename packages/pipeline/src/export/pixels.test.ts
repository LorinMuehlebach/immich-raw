import { describe, expect, it } from 'vitest';
import { convertPixels, type Pixels } from './pixels.ts';
import { compositeOverlay } from './watermark.ts';
import { srgb8Converter } from '../color/output-spaces.ts';

const srgb8 = (rgba: number[]): Pixels => ({ data: Uint8ClampedArray.from(rgba), width: rgba.length / 4, height: 1, bits: 8, space: 'srgb' });

describe('convertPixels', () => {
  it('returns the input when nothing changes', () => {
    const p = srgb8([1, 2, 3, 255]);
    expect(convertPixels(p, { space: 'srgb', bits: 8 })).toBe(p);
  });

  it('widens 8-bit sRGB to 16 bits exactly', () => {
    const out = convertPixels(srgb8([0, 128, 255, 255]), { space: 'srgb', bits: 16 });
    expect([...out.data]).toEqual([0, 128 * 257, 65535, 65535]);
    expect(out.bits).toBe(16);
  });

  it('converts into another space: white and black stay, colours move inside it', () => {
    const out = convertPixels(srgb8([255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255]), { space: 'display-p3', bits: 8 });
    expect([...out.data.subarray(0, 8)]).toEqual([255, 255, 255, 255, 0, 0, 0, 255]);
    const [r, g, b] = srgb8Converter('display-p3')(255, 0, 0);
    expect([...out.data.subarray(8, 11)]).toEqual([Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)]);
    expect(out.space).toBe('display-p3');
  });

  it('only converts from 8-bit sRGB', () => {
    const p3: Pixels = { ...srgb8([1, 2, 3, 255]), space: 'display-p3' };
    expect(() => convertPixels(p3, { space: 'adobe-rgb', bits: 8 })).toThrow(/8-bit sRGB/);
  });
});

describe('compositeOverlay on 16-bit and converted images', () => {
  const overlay = (rgba: number[]) => ({ data: Uint8ClampedArray.from(rgba), width: rgba.length / 4, height: 1 });

  it('scales the overlay to 16 bits and blends with its alpha', () => {
    const dst = { data: Uint16Array.from([0, 0, 0, 65535, 65535, 65535, 65535, 65535]), width: 2, height: 1 };
    compositeOverlay(dst, overlay([255, 255, 255, 255, 0, 0, 0, 51]), 0, 0);
    expect([...dst.data.subarray(0, 4)]).toEqual([65535, 65535, 65535, 65535]);
    expect([...dst.data.subarray(4, 8)]).toEqual([52428, 52428, 52428, 65535]);
  });

  it('converts the overlay colours into the image space', () => {
    const dst = { data: Uint8ClampedArray.from([0, 0, 0, 255]), width: 1, height: 1 };
    const convert = srgb8Converter('adobe-rgb');
    compositeOverlay(dst, overlay([255, 0, 0, 255]), 0, 0, convert);
    const [r, g, b] = convert(255, 0, 0);
    expect([...dst.data]).toEqual([Math.round(r * 255), Math.round(g * 255), Math.round(b * 255), 255]);
  });
});
