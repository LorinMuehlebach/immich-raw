import { describe, expect, it } from 'vitest';
import { compositeOverlay, drawLogoWatermark, drawWatermark, logoLayout, watermarkLayout, type WatermarkOptions, type WatermarkPosition } from './watermark.ts';

/** Roughly what a sans-serif font measures: 0.6 em per character. */
const fakeMeasure = (text: string) => (fontPx: number) => fontPx * text.length * 0.6;
const hello = fakeMeasure('Hello');

describe('watermarkLayout', () => {
  const landscape: [WatermarkPosition, number, number, string, string][] = [
    ['top-left', 120, 120, 'left', 'top'],
    ['top', 3000, 120, 'center', 'top'],
    ['top-right', 5880, 120, 'right', 'top'],
    ['left', 120, 2000, 'left', 'middle'],
    ['center', 3000, 2000, 'center', 'middle'],
    ['right', 5880, 2000, 'right', 'middle'],
    ['bottom-left', 120, 3880, 'left', 'bottom'],
    ['bottom', 3000, 3880, 'center', 'bottom'],
    ['bottom-right', 5880, 3880, 'right', 'bottom'],
  ];

  it.each(landscape)('anchors %s on a landscape image', (position, x, y, align, baseline) => {
    expect(watermarkLayout(6000, 4000, { position, size: 5 }, hello)).toEqual({ fontPx: 200, x, y, align, baseline });
  });

  it('anchors on a portrait image with the margin from the short edge', () => {
    expect(watermarkLayout(4000, 6000, { position: 'bottom-right', size: 5 }, hello)).toEqual({
      fontPx: 200,
      x: 3880,
      y: 5880,
      align: 'right',
      baseline: 'bottom',
    });
    expect(watermarkLayout(4000, 6000, { position: 'top', size: 5 }, hello)).toMatchObject({ x: 2000, y: 120 });
    expect(watermarkLayout(4000, 6000, { position: 'center', size: 5 }, hello)).toMatchObject({ x: 2000, y: 3000 });
  });

  it('sizes the text by the short edge', () => {
    expect(watermarkLayout(6000, 4000, { position: 'center', size: 10 }, hello).fontPx).toBe(400);
    expect(watermarkLayout(4000, 6000, { position: 'center', size: 10 }, hello).fontPx).toBe(400);
    expect(watermarkLayout(1200, 800, { position: 'top-left', size: 5 }, hello)).toMatchObject({ fontPx: 40, x: 24, y: 24 });
  });

  it('keeps a minimum font size and margin on small images', () => {
    expect(watermarkLayout(120, 80, { position: 'top-left', size: 1 }, hello)).toEqual({
      fontPx: 8,
      x: 4,
      y: 4,
      align: 'left',
      baseline: 'top',
    });
  });

  it('clamps the size to 1–20 %', () => {
    const fontPx = (size: number) => watermarkLayout(6000, 4000, { position: 'center', size }, hello).fontPx;
    expect(fontPx(50)).toBe(fontPx(20));
    expect(fontPx(20)).toBe(800);
    expect(fontPx(0)).toBe(40);
    expect(fontPx(NaN)).toBe(40);
  });

  it('shrinks text that is wider than the image between the margins', () => {
    const measure = fakeMeasure('A long copyright line © 2026');
    const layout = watermarkLayout(1000, 800, { position: 'bottom', size: 10 }, measure);
    expect(layout.fontPx).toBe(56);
    expect(measure(layout.fontPx)).toBeLessThanOrEqual(1000 - 2 * 24);
    expect(layout).toMatchObject({ x: 500, y: 776, align: 'center', baseline: 'bottom' });
  });

  it('re-measures when the width does not scale linearly', () => {
    const measure = (fontPx: number) => 50 + fontPx * 12;
    const room = 1000 - 2 * 24;
    const { fontPx } = watermarkLayout(1000, 800, { position: 'top-right', size: 20 }, measure);
    expect(measure(fontPx)).toBeLessThanOrEqual(room);
    expect(measure(fontPx + 1)).toBeGreaterThan(room);
  });

  it('returns whole pixel font sizes', () => {
    expect(Number.isInteger(watermarkLayout(3001, 2001, { position: 'center', size: 3.3 }, hello).fontPx)).toBe(true);
  });
});

describe('logoLayout', () => {
  const wide = { width: 400, height: 200 };
  const positions: [WatermarkPosition, number, number][] = [
    ['top-left', 120, 120],
    ['top', 2700, 120],
    ['top-right', 5280, 120],
    ['left', 120, 1850],
    ['center', 2700, 1850],
    ['right', 5280, 1850],
    ['bottom-left', 120, 3580],
    ['bottom', 2700, 3580],
    ['bottom-right', 5280, 3580],
  ];

  it.each(positions)('places a 2:1 logo %s inside the margins', (position, x, y) => {
    expect(logoLayout(6000, 4000, wide, { position, size: 15 })).toEqual({ x, y, width: 600, height: 300 });
  });

  it("sizes the logo's long side by the image's short edge, tall logos too", () => {
    expect(logoLayout(4000, 6000, wide, { position: 'top-left', size: 15 })).toMatchObject({ width: 600, height: 300 });
    expect(logoLayout(6000, 4000, { width: 100, height: 300 }, { position: 'top-left', size: 30 })).toMatchObject({ width: 400, height: 1200 });
  });

  it('keeps the largest logo inside the margins', () => {
    const box = logoLayout(1000, 800, { width: 1000, height: 100 }, { position: 'bottom-right', size: 50 });
    expect(box).toEqual({ x: 576, y: 736, width: 400, height: 40 });
    expect(box.x + box.width).toBe(1000 - 24);
    expect(box.y + box.height).toBe(800 - 24);
  });

  it('shrinks the minimum-size logo to fit a tiny image, keeping its shape', () => {
    expect(logoLayout(20, 12, { width: 10, height: 10 }, { position: 'top-left', size: 2 })).toEqual({ x: 4, y: 4, width: 4, height: 4 });
  });

  it('keeps a minimum size, and clamps the size to 1–50 %', () => {
    expect(logoLayout(100, 80, { width: 10, height: 10 }, { position: 'center', size: 1 })).toMatchObject({ width: 8, height: 8 });
    const at = (size: number) => logoLayout(6000, 4000, wide, { position: 'center', size }).width;
    expect(at(90)).toBe(at(50));
    expect(at(Number.NaN)).toBe(at(1));
  });
});

describe('compositeOverlay', () => {
  const image = (w: number, h: number, rgba: number[]) => ({ data: Uint8ClampedArray.from({ length: w * h * 4 }, (_, i) => rgba[i % 4]!), width: w, height: h });

  it('blends with straight alpha and keeps the photo opaque', () => {
    const dst = image(2, 1, [100, 100, 100, 255]);
    compositeOverlay(dst, image(2, 1, [200, 0, 255, 128]), 0, 0);
    expect([...dst.data.subarray(0, 4)]).toEqual([150, 50, 178, 255]);
    const full = image(1, 1, [9, 9, 9, 255]);
    compositeOverlay(full, image(1, 1, [1, 2, 3, 255]), 0, 0);
    expect([...full.data]).toEqual([1, 2, 3, 255]);
    const none = image(1, 1, [9, 9, 9, 255]);
    compositeOverlay(none, image(1, 1, [1, 2, 3, 0]), 0, 0);
    expect([...none.data]).toEqual([9, 9, 9, 255]);
  });

  it('places the overlay at its offset and clips it to the image', () => {
    const dst = image(3, 3, [0, 0, 0, 255]);
    compositeOverlay(dst, image(2, 2, [255, 255, 255, 255]), 2, -1);
    const white = [...Array(9).keys()].filter((i) => dst.data[i * 4] === 255);
    expect(white).toEqual([2]);
    compositeOverlay(dst, image(2, 2, [255, 255, 255, 255]), 5, 5);
    expect([...Array(9).keys()].filter((i) => dst.data[i * 4] === 255)).toEqual([2]);
  });
});

describe('drawWatermark', () => {
  const img = { data: new Uint8ClampedArray(4 * 4 * 4), width: 4, height: 4, colorSpace: 'srgb' } as ImageData;
  const opts: WatermarkOptions = { text: '© Me', position: 'bottom-right', size: 5, opacity: 50, color: 'white' };

  it('returns the input when there is nothing to draw', () => {
    expect(drawWatermark(img, { ...opts, text: '' })).toBe(img);
    expect(drawWatermark(img, { ...opts, text: '   ' })).toBe(img);
    expect(drawWatermark(img, { ...opts, opacity: 0 })).toBe(img);
    expect(drawLogoWatermark(img, { width: 10, height: 10 } as ImageBitmap, { position: 'center', size: 10, opacity: 0 })).toBe(img);
  });
});
