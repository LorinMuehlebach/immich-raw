import { defaultRecipe, type Recipe } from '@immich-raw/recipe';
import { describe, expect, it } from 'vitest';
import { CAMERAS } from './color/fixtures.ts';
import { SRGB_TO_PROPHOTO } from './color/look.ts';
import { XYZ_D65_TO_SRGB } from './color/matrices.ts';
import { cameraInfo, developUniforms } from './uniforms.ts';

const rows = (m: readonly number[]) => [0, 1, 2].map((i) => [m[3 * i]!, m[3 * i + 1]!, m[3 * i + 2]!]);

/** A developed photo as the decoder describes it (decoder/src/image.ts imageMeta). */
const developed = cameraInfo({
  flip: 0,
  width: 400,
  height: 300,
  camMul: [1, 1, 1, 1],
  camXyz: [...rows(XYZ_D65_TO_SRGB), [0, 0, 0]],
  rgbCam: [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
  ],
  baselineExposure: 0,
  rendered: true,
});

const fixture = CAMERAS[1]!;
const raw = cameraInfo({ flip: 0, width: 100, height: 100, camMul: fixture.camMul, camXyz: fixture.camXyz, rgbCam: fixture.rgbCam, baselineExposure: 0 });

const withWb = (wb: Recipe['wb']): Recipe => ({ ...defaultRecipe(), profile: 'linear', wb });

describe('developUniforms for a developed photo', () => {
  it('leaves it as it is at As Shot: no white balance change, sRGB into the working space', () => {
    const u = developUniforms(withWb({ mode: 'asShot', temp: 5500, tint: 0 }), developed);
    expect(u.uWb).toEqual([1, 1, 1]);
    u.uCamToWork.forEach((v, i) => expect(v).toBeCloseTo(SRGB_TO_PROPHOTO[i]!, 6));
    expect(u.uExposure).toBe(1);
  });

  it('never reconstructs highlights', () => {
    expect(developed.reconstructHighlights).toBe(false);
    const u = developUniforms(defaultRecipe(), developed);
    for (const c of u.uClip) expect(c).toBeGreaterThan(1e6);
  });

  it('reads As Shot as D65, so custom white balance starts from there', () => {
    expect(developed.asShot.temp).toBeGreaterThan(6300);
    expect(developed.asShot.temp).toBeLessThan(6700);
    const u = developUniforms(withWb({ mode: 'custom', ...developed.asShot }), developed);
    for (const c of u.uWb) expect(c).toBeCloseTo(1, 3);
    // Lower Kelvin: the photo was lit warmer, so blue goes up against red.
    const warm = developUniforms(withWb({ mode: 'custom', temp: 4000, tint: developed.asShot.tint }), developed);
    expect(warm.uWb[2]! / warm.uWb[0]!).toBeGreaterThan(1.2);
  });
});

describe('developUniforms for a RAW', () => {
  it('still reconstructs highlights', () => {
    expect(raw.reconstructHighlights).toBe(true);
    const u = developUniforms(defaultRecipe(), raw);
    for (const c of u.uClip) expect(c).toBeLessThan(10);
  });
});
