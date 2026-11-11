import { describe, expect, it } from 'vitest';
import { CAMERAS } from './fixtures.ts';
import {
  BRADFORD_D50_TO_D65,
  BRADFORD_D65_TO_D50,
  IDENTITY3,
  OKLAB_M2,
  PROPHOTO_TO_XYZ_D50,
  SRGB_TO_XYZ_D65,
  WHITE_D50_XYZ,
  WHITE_D65_XYZ,
  XYZ_D65_TO_LMS_OKLAB,
  fromRows,
  inv3,
  mul3,
  mulVec3,
  toGlMat3,
  transpose3,
} from './matrices.ts';
import { LMS_TO_PROPHOTO, PROPHOTO_LUMA, PROPHOTO_TO_LMS, PROPHOTO_TO_SRGB, cameraToProPhoto } from './spaces.ts';
import { tempTintToXy, xyToTempTint } from './temperature.ts';
import {
  multipliersForTempTint,
  normalizeCamMul,
  sliderToTemp,
  tempTintForMultipliers,
  tempToSlider,
} from './wb.ts';

const close = (a: readonly number[], b: readonly number[], eps: number) =>
  a.forEach((v, i) => expect(Math.abs(v - b[i]!)).toBeLessThanOrEqual(eps));

describe('matrices', () => {
  it('inverts and multiplies', () => {
    const m = [2, 1, 0, 0.5, 3, 1, 1, 0, 4];
    close(mul3(m, inv3(m)), IDENTITY3, 1e-12);
    close(transpose3(transpose3(m)), m, 0);
    close(mulVec3(IDENTITY3, [1, 2, 3]), [1, 2, 3], 0);
  });

  it('fromRows takes the 3x3 block of LibRaw matrices', () => {
    expect(fromRows([[1, 2, 3, 9], [4, 5, 6, 9], [7, 8, 9, 9], [0, 0, 0]])).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('toGlMat3 is column-major', () => {
    expect([...toGlMat3([1, 2, 3, 4, 5, 6, 7, 8, 9])]).toEqual([1, 4, 7, 2, 5, 8, 3, 6, 9]);
  });

  it('sRGB and ProPhoto map RGB white to their white points', () => {
    close(mulVec3(SRGB_TO_XYZ_D65, [1, 1, 1]), WHITE_D65_XYZ, 1e-9);
    close(mulVec3(PROPHOTO_TO_XYZ_D50, [1, 1, 1]), WHITE_D50_XYZ, 1e-9);
    // Matches the published IEC 61966-2-1 matrix to 4 decimals.
    close(SRGB_TO_XYZ_D65, [0.4124, 0.3576, 0.1805, 0.2126, 0.7152, 0.0722, 0.0193, 0.1192, 0.9505], 2e-4);
  });

  it('Bradford maps D65 white to D50 white and back', () => {
    close(mulVec3(BRADFORD_D65_TO_D50, WHITE_D65_XYZ), WHITE_D50_XYZ, 1e-9);
    close(mul3(BRADFORD_D65_TO_D50, BRADFORD_D50_TO_D65), IDENTITY3, 1e-9);
  });

  it('OKLab of D65 white is L=1, a=b=0', () => {
    const lms = mulVec3(XYZ_D65_TO_LMS_OKLAB, WHITE_D65_XYZ).map(Math.cbrt) as unknown as [number, number, number];
    close(mulVec3(OKLAB_M2, lms), [1, 0, 0], 1e-3);
  });
});

describe('spaces', () => {
  it('cameraToProPhoto keeps white-balanced camera white neutral', () => {
    for (const cam of CAMERAS) close(mulVec3(cameraToProPhoto(cam.rgbCam), [1, 1, 1]), [1, 1, 1], 1e-3);
  });

  it('ProPhoto white goes to sRGB white; luma weights sum to 1', () => {
    close(mulVec3(PROPHOTO_TO_SRGB, [1, 1, 1]), [1, 1, 1], 1e-6);
    expect(PROPHOTO_LUMA[0] + PROPHOTO_LUMA[1] + PROPHOTO_LUMA[2]).toBeCloseTo(1, 9);
  });

  it('LMS conversion inverts', () => {
    close(mul3(PROPHOTO_TO_LMS, LMS_TO_PROPHOTO), IDENTITY3, 1e-9);
  });
});

describe('temperature (DNG SDK port)', () => {
  it('puts 6504 K on the Planckian locus near D65', () => {
    const xy = tempTintToXy(6504, 0);
    expect(xy.x).toBeCloseTo(0.3135, 3);
    expect(xy.y).toBeCloseTo(0.3236, 3);
  });

  it('reads D65 as ~6500 K with a positive (green-side) tint', () => {
    const { temp, tint } = xyToTempTint({ x: 0.3127, y: 0.329 });
    expect(temp).toBeGreaterThan(6400);
    expect(temp).toBeLessThan(6600);
    expect(tint).toBeGreaterThan(0);
  });

  it('round-trips Temp/Tint through xy', () => {
    for (let temp = 2500; temp <= 20000; temp += 250) {
      for (let tint = -100; tint <= 100; tint += 25) {
        const back = xyToTempTint(tempTintToXy(temp, tint));
        expect(Math.abs(back.temp - temp)).toBeLessThan(1);
        expect(Math.abs(back.tint - tint)).toBeLessThan(0.1);
      }
    }
  });

  it('gets warmer (lower x) as the temperature rises', () => {
    expect(tempTintToXy(3000, 0).x).toBeGreaterThan(tempTintToXy(6500, 0).x);
  });
});

describe('white balance', () => {
  it('round-trips Temp/Tint through camera multipliers', () => {
    for (const cam of CAMERAS) {
      const m = fromRows(cam.camXyz);
      for (const [temp, tint] of [[3200, 0], [5500, 10], [7500, -20]] as const) {
        const back = tempTintForMultipliers(m, multipliersForTempTint(m, temp, tint));
        expect(Math.abs(back.temp - temp)).toBeLessThan(2);
        expect(Math.abs(back.tint - tint)).toBeLessThan(0.2);
      }
    }
  });

  it('gives plausible as-shot Temp/Tint for the sample cameras', () => {
    for (const cam of CAMERAS) {
      const { temp, tint } = tempTintForMultipliers(fromRows(cam.camXyz), normalizeCamMul(cam.camMul));
      console.log(`${cam.camera}: ${Math.round(temp)} K, tint ${tint.toFixed(1)}`);
      expect(temp).toBeGreaterThan(2500);
      expect(temp).toBeLessThan(9000);
      expect(Math.abs(tint)).toBeLessThan(60);
    }
  });

  it('warmer light needs more blue gain', () => {
    const m = fromRows(CAMERAS[3]!.camXyz);
    expect(multipliersForTempTint(m, 3000, 0)[2]).toBeGreaterThan(multipliersForTempTint(m, 6500, 0)[2]);
  });

  it('normalizes LibRaw cam_mul', () => {
    close(normalizeCamMul([1659, 1024, 2315, 1024]), [1659 / 1024, 1, 2315 / 1024], 1e-12);
    close(normalizeCamMul([635, 302, 489, 0]), [635 / 302, 1, 489 / 302], 1e-12);
    close(normalizeCamMul([2, 0, 1.5, 1]), [2, 1, 1.5], 1e-12);
    close(normalizeCamMul([0, 0, 0, 0]), [1, 1, 1], 0);
  });
});

describe('temperature slider', () => {
  it('maps the ends and round-trips', () => {
    expect(tempToSlider(2000)).toBeCloseTo(0, 9);
    expect(tempToSlider(50000)).toBeCloseTo(1, 9);
    for (let s = 0; s <= 1; s += 0.05) expect(tempToSlider(sliderToTemp(s))).toBeCloseTo(s, 9);
  });

  it('is monotonic and puts the middle well below 26000 K', () => {
    let last = -1;
    for (let t = 2000; t <= 50000; t += 100) {
      const s = tempToSlider(t);
      expect(s).toBeGreaterThan(last);
      last = s;
    }
    expect(sliderToTemp(0.5)).toBeLessThan(5000);
  });
});
