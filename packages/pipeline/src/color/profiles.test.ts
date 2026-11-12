import { FUJI_PROFILE_IDS, PROFILES, defaultRecipe, type ProfileId } from '@immich-raw/recipe';
import { describe, expect, it } from 'vitest';
import { cameraInfo, developUniforms } from '../uniforms.ts';
import { applyLookCpu, buildToneLut, dngRgbToHsv, hueSatAt, type HueSatTable } from './dcp.ts';
import { CAMERAS } from './fixtures.ts';
import { SRGB_TO_PROPHOTO, decodeSrgb } from './look.ts';
import { mulVec3, type Vec3 } from './matrices.ts';
import { FUJI_BASELINE_EV, LOOK_ANCHORS, inHouseLook, profileExposureEv, profileUniforms, profileWhitePoint, resolveProfile, type ProfileLooks } from './profiles.ts';

const fixture = CAMERAS[1]!;
const camera = cameraInfo({ flip: 0, width: 100, height: 100, camMul: fixture.camMul, camXyz: fixture.camXyz, rgbCam: fixture.rgbCam, baselineExposure: 0 });
const recipe = (profile: ProfileId, profileAmount = 100) => ({ ...defaultRecipe(), profile, profileAmount });

/** A small look table that shifts every colour's hue by 10° and saturates it. */
function fakeTable(): HueSatTable {
  const data = new Float32Array(6 * 3 * 2 * 3);
  for (let i = 0; i < data.length; i += 3) data.set([10, 1.2, 1], i);
  return { hueDivisions: 6, satDivisions: 3, valDivisions: 2, srgbValues: true, data };
}

const fujiLooks = (): ProfileLooks => ({
  'fuji-provia': { lookTable: fakeTable(), toneLut: buildToneLut(Float32Array.from([0, 0, 0.5, 0.45, 1, 1])) },
  'fuji-classic-neg': {
    lookTable: fakeTable(),
    toneLut: buildToneLut(Float32Array.from([0, 0, 1, 1])),
    filmLut: { size: 2, data: new Float32Array(24) },
  },
});

describe('the four tone-only profiles render as before', () => {
  // Constants that used to live in uniforms.ts (PROFILE_BASELINE, PROFILE_INDEX) and auto.ts.
  const before: Record<string, [number, number, number]> = { color: [0, 0.35, 1.5], neutral: [1, 0.35, 1.8], linear: [2, 0, 1], monochrome: [3, 0.35, 1.5] };

  for (const [id, [base, ev, white]] of Object.entries(before)) {
    it(id, () => {
      const p = resolveProfile(id as ProfileId);
      expect(p.base).toBe(base);
      expect(p.amount).toBe(false);
      expect(p.look).toBeNull();
      for (const amount of [0, 37, 100, 200]) {
        expect(profileExposureEv(p, amount)).toBe(ev);
        expect(profileWhitePoint(p, amount)).toBe(white);
        const u = profileUniforms(p, amount);
        expect(u).toMatchObject({ uProfile: base, uLook: 0, uProfileCurve: 0, uFilmLut: 0, uSCurveCustom: 0 });
        const r = recipe(id as ProfileId, amount);
        r.basic.exposure = 0.7;
        expect(developUniforms(r, camera).uExposure).toBe(2 ** (0.7 + 0 + ev));
        expect(developUniforms(r, camera).uProfile).toBe(base);
      }
      expect(profileWhitePoint(id as ProfileId)).toBe(white);
    });
  }
});

describe('resolveProfile', () => {
  it('knows every profile', () => {
    for (const p of PROFILES) expect(resolveProfile(p.id, fujiLooks()).requested).toBe(p.id);
  });

  it('renders Color when a Fujifilm look is not downloaded', () => {
    for (const id of FUJI_PROFILE_IDS) {
      const p = resolveProfile(id);
      expect(p).toMatchObject({ id: 'color', requested: id, missing: true, base: 0, amount: false, look: null });
      expect(profileUniforms(p, 150)).toEqual(profileUniforms(resolveProfile('color'), 100));
    }
  });

  it('uses the downloaded data', () => {
    const p = resolveProfile('fuji-provia', fujiLooks());
    expect(p).toMatchObject({ id: 'fuji-provia', missing: false, base: 0, baselineEv: FUJI_BASELINE_EV, amount: true });
    expect(p.whitePoint).toBe(fujiLooks()['fuji-provia']!.toneLut!.whitePoint);
    const u = profileUniforms(p, 100);
    expect(u).toMatchObject({ uLook: 1, uProfileCurve: 1, uFilmLut: 0, uSCurveCustom: 1, uSCurve: 0, uLookAmount: 1, uProfileCurveAmount: 1 });
    expect(profileUniforms(resolveProfile('fuji-classic-neg', fujiLooks()), 100).uFilmLut).toBe(1);
  });
});

describe('profile Amount', () => {
  it('is exactly Color at 0 %', () => {
    for (const id of ['vivid', 'portrait', 'landscape', 'fuji-provia', 'fuji-classic-neg'] as ProfileId[]) {
      const p = resolveProfile(id, fujiLooks());
      const u = profileUniforms(p, 0);
      expect(u).toMatchObject({ uProfile: 0, uLook: 0, uProfileCurve: 0, uFilmLut: 0, uSCurve: 0.25 });
      expect(profileExposureEv(p, 0)).toBe(0.35);
      expect(profileWhitePoint(p, 0)).toBe(1.5);
    }
  });

  it('extrapolates above 100 % and keeps the S-curve non-negative', () => {
    const vivid = resolveProfile('vivid');
    expect(profileUniforms(vivid, 100).uSCurve).toBeCloseTo(0.4, 9);
    expect(profileUniforms(vivid, 200).uSCurve).toBeCloseTo(0.55, 9);
    expect(profileUniforms(vivid, 200).uLookAmount).toBe(2);
    const provia = resolveProfile('fuji-provia', fujiLooks());
    expect(profileUniforms(provia, 50).uSCurve).toBeCloseTo(0.125, 9);
    expect(profileUniforms(provia, 200).uSCurve).toBe(0);
    // The colour look goes on growing; the tone curve stops at the profile's own.
    expect(profileUniforms(provia, 200)).toMatchObject({ uLookAmount: 2, uProfileCurveAmount: 1 });
    expect(profileUniforms(provia, 50).uProfileCurveAmount).toBe(0.5);
    // Exposure and white point move from Color's to the profile's, and stop there.
    expect(profileExposureEv(provia, 200)).toBe(profileExposureEv(provia, 100));
  });
});

describe('in-house looks', () => {
  const hsv = (srgb: Vec3) => dngRgbToHsv(mulVec3(SRGB_TO_PROPHOTO, srgb.map(decodeSrgb) as unknown as Vec3));
  const sat = (t: HueSatTable, srgb: Vec3) => {
    const [h, s, v] = hsv(srgb);
    return hueSatAt(t, h, s, v)[1];
  };

  it('has its anchors where skin, foliage and sky are', () => {
    expect(LOOK_ANCHORS.skin).toBeGreaterThan(5);
    expect(LOOK_ANCHORS.skin).toBeLessThan(45);
    expect(LOOK_ANCHORS.foliage).toBeGreaterThan(60);
    expect(LOOK_ANCHORS.foliage).toBeLessThan(140);
    expect(LOOK_ANCHORS.sky).toBeGreaterThan(190);
    expect(LOOK_ANCHORS.sky).toBeLessThan(250);
  });

  it('never touches greys', () => {
    for (const id of ['vivid', 'portrait', 'landscape'] as const) {
      const t = inHouseLook(id);
      for (let v = 0; v < t.valDivisions; v++) {
        for (let h = 0; h < t.hueDivisions; h++) {
          const i = ((v * t.hueDivisions + h) * t.satDivisions + 0) * 3;
          expect([t.data[i], t.data[i + 1], t.data[i + 2]]).toEqual([0, 1, 1]);
        }
      }
      for (const g of [0.05, 0.18, 0.6]) {
        const out = applyLookCpu(t, [g, g, g]);
        out.forEach((c) => expect(c).toBeCloseTo(g, 9));
      }
    }
  });

  const skin: Vec3 = [0.87, 0.65, 0.53];
  const leaf: Vec3 = [0.35, 0.55, 0.2];
  const sky: Vec3 = [0.35, 0.6, 0.9];
  const red: Vec3 = [0.7, 0.35, 0.3]; // mid-saturated: Vivid eases off near the gamut edge

  it('Vivid saturates, less on skin', () => {
    const t = inHouseLook('vivid');
    expect(sat(t, red)).toBeGreaterThan(1.15);
    expect(sat(t, skin)).toBeGreaterThan(1.05);
    expect(sat(t, skin)).toBeLessThan(sat(t, red));
  });

  it('Portrait calms skin and leaves other colours a little richer', () => {
    const t = inHouseLook('portrait');
    expect(sat(t, skin)).toBeLessThan(1);
    expect(sat(t, sky)).toBeGreaterThan(1);
  });

  it('Landscape boosts foliage and sky more than skin', () => {
    const t = inHouseLook('landscape');
    expect(sat(t, leaf)).toBeGreaterThan(1.2);
    expect(sat(t, sky)).toBeGreaterThan(1.2);
    expect(sat(t, skin)).toBeLessThan(sat(t, leaf));
  });
});
