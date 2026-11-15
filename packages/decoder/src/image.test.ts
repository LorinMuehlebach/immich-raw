import { describe, expect, it } from 'vitest';
import { ImageSession, SRGB_TO_LINEAR16, exposureSeconds, imageMeta, linearFromRgba } from './image.ts';

describe('SRGB_TO_LINEAR16', () => {
  it('maps black and white to the ends and mid grey to ~21.4 %', () => {
    expect(SRGB_TO_LINEAR16[0]).toBe(0);
    expect(SRGB_TO_LINEAR16[255]).toBe(65535);
    // sRGB 128 is 0.2158 linear.
    expect(SRGB_TO_LINEAR16[128]! / 65535).toBeCloseTo(0.2158, 3);
    // The linear toe: 10/255 / 12.92.
    expect(SRGB_TO_LINEAR16[10]! / 65535).toBeCloseTo(10 / 255 / 12.92, 5);
  });

  it('only rises', () => {
    for (let i = 1; i < 256; i++) expect(SRGB_TO_LINEAR16[i]!).toBeGreaterThan(SRGB_TO_LINEAR16[i - 1]!);
  });
});

describe('linearFromRgba', () => {
  it('drops alpha and writes at the pixel offset', () => {
    const out = new Uint16Array(9);
    linearFromRgba(new Uint8Array([255, 0, 128, 7, 0, 255, 0, 255]), out, 1);
    expect([...out]).toEqual([0, 0, 0, 65535, 0, SRGB_TO_LINEAR16[128], 0, 65535, 0]);
  });
});

describe('exposureSeconds', () => {
  it('reads fractions and decimals', () => {
    expect(exposureSeconds('1/250')).toBeCloseTo(0.004);
    expect(exposureSeconds('0.5')).toBe(0.5);
    expect(exposureSeconds('2')).toBe(2);
    expect(exposureSeconds('')).toBe(0);
    expect(exposureSeconds(null)).toBe(0);
    expect(exposureSeconds('abc')).toBe(0);
  });
});

describe('imageMeta', () => {
  it('is an upright sRGB "camera" with neutral multipliers', () => {
    const m = imageMeta(4000, 3000, { make: 'Apple ', model: 'iPhone 15', lensModel: 'main', iso: 50, exposureTime: '1/100', fNumber: 1.8, focalLength: 6.8 });
    expect(m).toMatchObject({ width: 4000, height: 3000, flip: 0, camMul: [1, 1, 1, 1], baselineExposure: 0, rendered: true });
    expect(m).toMatchObject({ make: 'Apple', model: 'iPhone 15', lens: 'main', iso: 50, aperture: 1.8, focalLength: 6.8 });
    expect(m.shutter).toBeCloseTo(0.01);
    expect(m.rgbCam.map((r) => r.slice(0, 3))).toEqual([
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]);
  });

  it('has XYZ -> sRGB as its camera matrix: D65 white comes out neutral', () => {
    const { camXyz } = imageMeta(1, 1);
    const d65 = [0.95047, 1, 1.08883];
    const rgb = camXyz.slice(0, 3).map((r) => r[0]! * d65[0]! + r[1]! * d65[1]! + r[2]! * d65[2]!);
    for (const v of rgb) expect(v).toBeCloseTo(1, 3);
  });

  it('works without EXIF', () => {
    expect(imageMeta(2, 2, null)).toMatchObject({ make: '', model: '', lens: '', iso: 0, shutter: 0, aperture: 0, focalLength: 0 });
  });
});

describe('ImageSession.fromLinear', () => {
  it('keeps the full image and edits a half-size copy', async () => {
    const data = new Uint16Array(4 * 2 * 3).fill(1000);
    const s = ImageSession.fromLinear({ width: 4, height: 2, data });
    expect(s.meta).toMatchObject({ width: 4, height: 2, rendered: true });
    expect(s.half).toMatchObject({ width: 2, height: 1, halfSize: true });
    expect(s.fullStarted).toBe(true);
    const full = await s.full();
    expect(full).toMatchObject({ width: 4, height: 2, halfSize: false });
    expect(full.data).toBe(data);
    s.close();
    expect(await s.full()).toBe(full);
  });
});
