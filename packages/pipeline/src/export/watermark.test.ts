import { describe, expect, it } from 'vitest';
import { drawWatermark, watermarkLayout, type WatermarkOptions, type WatermarkPosition } from './watermark.ts';

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

describe('drawWatermark', () => {
  const img = { data: new Uint8ClampedArray(4 * 4 * 4), width: 4, height: 4, colorSpace: 'srgb' } as ImageData;
  const opts: WatermarkOptions = { text: '© Me', position: 'bottom-right', size: 5, opacity: 50, color: 'white' };

  it('returns the input when there is nothing to draw', () => {
    expect(drawWatermark(img, { ...opts, text: '' })).toBe(img);
    expect(drawWatermark(img, { ...opts, text: '   ' })).toBe(img);
    expect(drawWatermark(img, { ...opts, opacity: 0 })).toBe(img);
  });
});
