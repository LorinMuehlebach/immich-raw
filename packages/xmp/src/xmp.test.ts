import { applyPatch, defaultRecipe, type CropParams, type Recipe } from '@immich-raw/recipe';
import { describe, expect, it } from 'vitest';
// Test-only cross-check against the renderer's crop maths.
import { applyAffine, editFrame } from '../../pipeline/src/geometry.ts';
import { cropToLrCrop, lrCropToCrop, type CropContext } from './crop.ts';
import { recipeToXmp, patchToXmp, formatNumber } from './export.ts';
import { IMMICH_SIDECAR } from './fixtures/immich.ts';
import { LR_PRESET } from './fixtures/preset.ts';
import { LR_SIDECAR } from './fixtures/sidecar.ts';
import { ELEMENT_FORM, LEGACY_PV2010 } from './fixtures/variants.ts';
import { crsToPatch, isLightroomSidecar, parseXmp } from './index.ts';

/**
 * Lightroom's (left, top) is the box corner at the SENSOR top-left. In our output frame
 * (upright, y down) that is corner (0,0) for 0 quarter turns, (1,0) for 1, (1,1) for 2,
 * (0,1) for 3; (right, bottom) is the opposite corner.
 */
function expectSameCorners(crop: CropParams, ctx: CropContext, lr: { left: number; top: number; right: number; bottom: number }) {
  const odd = ctx.flip === 5 || ctx.flip === 6;
  const [sw, sh] = odd ? [ctx.uprightHeight, ctx.uprightWidth] : [ctx.uprightWidth, ctx.uprightHeight];
  const frame = editFrame(crop, ctx.flip, sw, sh);
  const turns = (({ 0: 0, 3: 2, 6: 1, 5: 3 } as Record<number, number>)[ctx.flip]! + crop.rotate90) % 4;
  const tlOut = ([[0, 0], [1, 0], [1, 1], [0, 1]] as const)[turns]!;
  const tl = applyAffine(frame.tToS, tlOut[0], tlOut[1]);
  const br = applyAffine(frame.tToS, 1 - tlOut[0], 1 - tlOut[1]);
  expect(tl[0]).toBeCloseTo(lr.left, 6);
  expect(tl[1]).toBeCloseTo(lr.top, 6);
  expect(br[0]).toBeCloseTo(lr.right, 6);
  expect(br[1]).toBeCloseTo(lr.bottom, 6);
}

const imported = (xmp: string, ctx?: CropContext) => {
  const crs = parseXmp(xmp);
  expect(crs).not.toBeNull();
  const result = crsToPatch(crs!, ctx);
  return { crs: crs!, result, recipe: applyPatch(defaultRecipe(), result.patch) };
};

describe('parseXmp', () => {
  it('reads attributes, lists, language alternatives and structs', () => {
    const crs = parseXmp(LR_PRESET)!;
    expect(crs.name).toBe('Soft Matte & Warm');
    expect(crs.values.Exposure2012).toBe('+0.35');
    expect(crs.values['Look.Name']).toBe('Adobe Color');
    expect(crs.values['Look.Parameters.Exposure2012']).toBe('+9.99');
    expect(crs.lists.ToneCurvePV2012).toEqual(['0, 18', '64, 60', '128, 132', '192, 200', '255, 246']);
    expect(crs.lists['Look.Parameters.ToneCurvePV2012']).toHaveLength(3);
  });

  it('handles element form, entities, other prefixes and several descriptions', () => {
    const crs = parseXmp(ELEMENT_FORM)!;
    expect(crs.values.Exposure2012).toBe('+1.25');
    expect(crs.values.Treatment).toBe('Black & White');
    expect(crs.values.Vibrance).toBe('+22');
    expect(crs.values.Sharpness).toBe('70');
    expect(crs.name).toBe('Punchy');
    expect(crs.lists.ToneCurvePV2012Green).toEqual(['0, 0', '128, 140', '255, 255']);
  });

  it('reads tiff:Orientation and counts mask entries', () => {
    const crs = parseXmp(LR_SIDECAR)!;
    expect(crs.orientation).toBe(6);
    expect(crs.lists.MaskGroupBasedCorrections).toHaveLength(2);
  });

  it('returns null without crs settings', () => {
    expect(parseXmp(IMMICH_SIDECAR)).toBeNull();
    expect(parseXmp('not xml at all')).toBeNull();
    expect(parseXmp('')).toBeNull();
  });
});

describe('isLightroomSidecar', () => {
  it('tells Lightroom sidecars from Immich ones', () => {
    expect(isLightroomSidecar(LR_SIDECAR)).toBe(true);
    expect(isLightroomSidecar(LR_PRESET)).toBe(true);
    expect(isLightroomSidecar(IMMICH_SIDECAR)).toBe(false);
    const bookkeepingOnly = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Version="16.0" crs:RawFileName="a.ARW" crs:AlreadyApplied="False"/></rdf:RDF></x:xmpmeta>`;
    expect(isLightroomSidecar(bookkeepingOnly)).toBe(false);
  });
});

describe('crsToPatch: preset', () => {
  const { result, recipe } = imported(LR_PRESET);

  it('maps tone, presence, curve and detail values', () => {
    expect(recipe.basic).toMatchObject({ exposure: 0.35, contrast: 12, highlights: -45, shadows: 38, whites: 8, blacks: -14 });
    expect(recipe.basic).toMatchObject({ texture: 6, clarity: 10, dehaze: 4, vibrance: 18, saturation: -5 });
    expect(recipe.toneCurve.parametric).toEqual({ shadows: 5, darks: -8, lights: 6, highlights: -10, shadowSplit: 25, midtoneSplit: 50, highlightSplit: 75 });
    expect(recipe.toneCurve.point.master).toEqual([[0, 18], [64, 60], [128, 132], [192, 200], [255, 246]]);
    expect(recipe.toneCurve.point.blue).toEqual([[0, 10], [255, 240]]);
    expect(recipe.detail).toEqual({
      sharpenAmount: 55,
      sharpenRadius: 1.2,
      sharpenDetail: 30,
      sharpenMasking: 20,
      nrLuminance: 10,
      nrLuminanceDetail: 50,
      nrLuminanceContrast: 0,
      nrColor: 25,
      nrColorDetail: 50,
      nrColorSmoothness: 50,
    });
  });

  it('does not take values from the embedded profile look', () => {
    expect(recipe.basic.exposure).toBe(0.35);
  });

  it('approximates the profile and reports it', () => {
    expect(recipe.profile).toBe('color');
    expect(result.warnings).toContain('Profile "Adobe Color" approximated by Color');
  });

  it('maps the Effects panel (post-crop vignette, grain), leaving nothing unmapped', () => {
    expect(recipe.effects).toMatchObject({ vignetteAmount: -15, vignetteStyle: 'highlight', grainAmount: 0, grainSize: 25 });
    expect(result.groups).toContain('effects');
    expect(result.unmapped).toEqual([]);
    expect(result.warnings.some((w) => w.startsWith('Effects'))).toBe(false);
  });

  it('maps every vignette style and warns about unknown ones', () => {
    const style = (v: string) =>
      crsToPatch(
        parseXmp(
          `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
            `<rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:PostCropVignetteStyle="${v}"/></rdf:RDF></x:xmpmeta>`,
        )!,
      );
    expect(style('1').patch).toEqual({ effects: { vignetteStyle: 'highlight' } });
    expect(style('2').patch).toEqual({ effects: { vignetteStyle: 'color' } });
    expect(style('3').patch).toEqual({ effects: { vignetteStyle: 'paint' } });
    expect(style('7').warnings).toContain('Ignored PostCropVignetteStyle="7" (unknown value)');
  });

  it('maps the Color Mixer and Color Grading (including the ColorGradeShadow* spelling)', () => {
    expect(recipe.colorMixer.hue.orange).toBe(6);
    expect(recipe.colorMixer.saturation.orange).toBe(-12);
    expect(recipe.colorGrading.shadows).toEqual({ hue: 220, sat: 12, lum: 0 });
    expect(recipe.colorGrading.blending).toBe(50);
    expect(result.groups).toEqual(expect.arrayContaining(['colorMixer', 'colorGrading']));
  });

  it('lists the touched groups (no white balance or crop in this preset)', () => {
    expect(result.groups).toEqual(expect.arrayContaining(['profile', 'tone', 'presence', 'toneCurve', 'sharpening', 'noise']));
    expect(result.groups).not.toContain('wb');
    expect(result.groups).not.toContain('crop');
  });
});

describe('crsToPatch: sidecar', () => {
  // Portrait shot: LibRaw flip 6, upright 6374 x 9566 (sensor 9566 x 6374).
  const ctx: CropContext = { flip: 6, uprightWidth: 6374, uprightHeight: 9566 };
  const { result, recipe, crs } = imported(LR_SIDECAR, ctx);

  it('maps custom white balance and tone', () => {
    expect(recipe.wb).toEqual({ mode: 'custom', temp: 4850, tint: 7 });
    expect(recipe.basic).toMatchObject({ exposure: -0.4, highlights: -62, shadows: 41, clarity: 15, vibrance: 10 });
  });

  it('maps the straightened crop so our renderer selects the same corners', () => {
    const c = recipe.crop;
    expect(c.angle).toBeCloseTo(2.35, 9);
    expect(c.rotate90).toBe(0);
    expect(c.aspect).toBe('free');
    const v = crs.values;
    // Our edit frame maps output corners to sensor coordinates; they must be Lightroom's corners.
    expectSameCorners(c, ctx, { left: Number(v.CropLeft), top: Number(v.CropTop), right: Number(v.CropRight), bottom: Number(v.CropBottom) });
  });

  it('maps lens corrections and summarises masks and other skipped settings', () => {
    expect(result.unmapped).toEqual(expect.arrayContaining(['MaskGroupBasedCorrections']));
    expect(recipe.effects.vignetteAmount).toBe(-12);
    for (const k of ['AutoLateralCA', 'LensProfileEnable', 'LensProfileName', 'LensProfileSetup', 'LensProfileDistortionScale', 'RawFileName', 'PostCropVignetteAmount']) {
      expect(result.unmapped).not.toContain(k);
    }
    expect(recipe.lens.profile).toBe(true);
    expect(recipe.lens.removeCA).toBe(true);
    expect(recipe.lens.profileDistortion).toBe(100);
    // Neither mask can be imported: one is an AI selection, the other has no shapes.
    expect(result.warnings).toEqual(
      expect.arrayContaining([`Mask "Sky" skipped: Select Sky (AI) can't be imported`, 'Mask "Subject" skipped: nothing to import']),
    );
    expect(result.groups).not.toContain('masks');
    expect(result.warnings.some((w) => w.startsWith('Lens Corrections'))).toBe(false);
    expect(result.unmapped).not.toContain('HueAdjustmentRed');
    expect(recipe.colorMixer.hue.red).toBe(10);
  });

  it('skips the crop with a warning when the photo size is unknown', () => {
    const r = crsToPatch(parseXmp(LR_SIDECAR)!);
    expect(r.groups).not.toContain('crop');
    expect(r.warnings).toContain('Crop needs the photo size; crop skipped');
  });

  it('turns a Lightroom rotation into rotate90', () => {
    // The camera wrote orientation 1, Lightroom rotated it to 6.
    const landscapeCtx: CropContext = { flip: 0, uprightWidth: 9566, uprightHeight: 6374 };
    const r = crsToPatch(parseXmp(LR_SIDECAR)!, landscapeCtx);
    expect((r.patch.crop as CropParams).rotate90).toBe(1);
  });
});

describe('crsToPatch: other inputs', () => {
  it('maps element-form XMP', () => {
    const { recipe } = imported(ELEMENT_FORM);
    expect(recipe.basic.exposure).toBe(1.25);
    expect(recipe.basic.contrast).toBe(-30);
    expect(recipe.basic.vibrance).toBe(22);
    expect(recipe.detail.sharpenAmount).toBe(70);
    expect(recipe.wb.mode).toBe('asShot');
    expect(recipe.profile).toBe('monochrome');
    expect(recipe.toneCurve.point.green).toEqual([[0, 0], [128, 140], [255, 255]]);
  });

  it('warns about pre-2012 process versions and applies nothing', () => {
    const crs = parseXmp(LEGACY_PV2010)!;
    const r = crsToPatch(crs);
    expect(r.applied).toEqual([]);
    expect(r.unmapped).toEqual([]);
    expect(r.warnings).toContain('Settings from an old Lightroom process version (before 2012) are not supported');
  });

  it('clamps out-of-range values and approximates white balance presets', () => {
    const xmp = `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Exposure2012="+7.00" crs:WhiteBalance="Tungsten"/></rdf:RDF>`;
    const r = crsToPatch(parseXmp(xmp)!);
    const rec = applyPatch(defaultRecipe(), r.patch);
    expect(rec.basic.exposure).toBe(5);
    expect(rec.wb).toEqual({ mode: 'custom', temp: 2850, tint: 0 });
    expect(r.warnings[0]).toMatch(/Tungsten/);
  });
});

describe('crop conversion', () => {
  const ctxs: CropContext[] = [
    { flip: 0, uprightWidth: 6000, uprightHeight: 4000 },
    { flip: 6, uprightWidth: 4000, uprightHeight: 6000 },
    { flip: 5, uprightWidth: 4000, uprightHeight: 6000 },
    { flip: 3, uprightWidth: 6000, uprightHeight: 4000 },
  ];
  const crops: Pick<CropParams, 'cx' | 'cy' | 'w' | 'h' | 'angle' | 'rotate90'>[] = [
    { cx: 0.5, cy: 0.5, w: 1, h: 1, angle: 0, rotate90: 0 },
    { cx: 0.4, cy: 0.6, w: 0.5, h: 0.3, angle: 7.5, rotate90: 0 },
    { cx: 0.55, cy: 0.45, w: 0.6, h: 0.7, angle: -12, rotate90: 1 },
    { cx: 0.5, cy: 0.52, w: 0.8, h: 0.4, angle: 3, rotate90: 3 },
  ];

  it('round-trips ours -> Lightroom -> ours for every orientation', () => {
    for (const ctx of ctxs) {
      for (const c of crops) {
        const lr = cropToLrCrop(c, ctx);
        const turns = ({ 1: 0, 6: 1, 3: 2, 8: 3 } as const)[lr.orientation as 1 | 6 | 3 | 8];
        const back = lrCropToCrop(lr, ctx, turns);
        expect(back.cx).toBeCloseTo(c.cx, 9);
        expect(back.cy).toBeCloseTo(c.cy, 9);
        expect(back.w).toBeCloseTo(c.w, 9);
        expect(back.h).toBeCloseTo(c.h, 9);
        expect(back.angle).toBeCloseTo(c.angle, 9);
        expect(back.rotate90).toBe(c.rotate90);
      }
    }
  });

  it('matches the renderer: our crop corners land on the Lightroom corners', () => {
    for (const ctx of ctxs) {
      for (const c of crops) {
        expectSameCorners({ ...defaultRecipe().crop, ...c }, ctx, cropToLrCrop(c, ctx));
      }
    }
  });
});

describe('export', () => {
  const ctx: CropContext = { flip: 0, uprightWidth: 6000, uprightHeight: 4000 };

  const sample = (): Recipe => {
    const r = defaultRecipe();
    r.profile = 'neutral';
    r.wb = { mode: 'custom', temp: 4300, tint: -12 };
    Object.assign(r.basic, { exposure: 0.75, contrast: 15, highlights: -40, shadows: 30, whites: 5, blacks: -10, texture: 8, clarity: 12, dehaze: 6, vibrance: 20, saturation: -8 });
    Object.assign(r.toneCurve.parametric, { highlights: -20, lights: 10, darks: -5, shadows: 15, shadowSplit: 20, midtoneSplit: 45, highlightSplit: 80 });
    r.toneCurve.point.master = [[0, 10], [100, 90], [255, 250]];
    r.toneCurve.point.red = [[0, 0], [128, 135], [255, 255]];
    Object.assign(r.detail, { sharpenAmount: 70, sharpenRadius: 1.4, sharpenDetail: 35, sharpenMasking: 40, nrLuminance: 15, nrLuminanceDetail: 60, nrLuminanceContrast: 10, nrColor: 30, nrColorDetail: 40, nrColorSmoothness: 70 });
    r.effects = {
      vignetteStyle: 'color',
      vignetteAmount: -35,
      vignetteMidpoint: 40,
      vignetteRoundness: 20,
      vignetteFeather: 70,
      vignetteHighlights: 15,
      grainAmount: 30,
      grainSize: 40,
      grainRoughness: 60,
    };
    r.colorMixer.hue.red = 12;
    r.colorMixer.saturation.blue = -30;
    r.colorMixer.luminance.aqua = 25;
    r.bwMix.yellow = 40;
    r.colorGrading.shadows = { hue: 210, sat: 18, lum: -6 };
    r.colorGrading.midtones = { hue: 35, sat: 8, lum: 4 };
    r.colorGrading.highlights = { hue: 48, sat: 22, lum: 10 };
    r.colorGrading.global = { hue: 300, sat: 5, lum: -3 };
    Object.assign(r.colorGrading, { blending: 65, balance: -20 });
    Object.assign(r.calibration, { shadowTint: -8, redHue: 5, redSaturation: 10, greenHue: -15, greenSaturation: 0, blueHue: -20, blueSaturation: 35 });
    r.crop = { cx: 0.45, cy: 0.55, w: 0.6, h: 0.5, angle: 3.5, rotate90: 1, aspect: 'free', portrait: false };
    return r;
  };

  it('round-trips every mapped field through XMP', () => {
    const r = sample();
    const xmp = recipeToXmp(r, { crop: ctx });
    const { recipe, result } = imported(xmp, ctx);
    expect(result.unmapped).toEqual([]);
    expect(recipe.profile).toBe('neutral');
    expect(recipe.wb).toEqual(r.wb);
    expect(recipe.basic).toEqual(r.basic);
    expect(recipe.toneCurve).toEqual(r.toneCurve);
    expect(recipe.detail).toEqual(r.detail);
    expect(recipe.effects).toEqual(r.effects);
    expect(xmp).toContain('crs:PostCropVignetteStyle="2"');
    expect(xmp).toContain('crs:PostCropVignetteAmount="-35"');
    expect(xmp).toContain('crs:GrainFrequency="60"');
    expect(recipe.colorMixer).toEqual(r.colorMixer);
    expect(recipe.bwMix).toEqual(r.bwMix);
    expect(recipe.colorGrading).toEqual(r.colorGrading);
    expect(recipe.calibration).toEqual(r.calibration);
    expect(xmp).toContain('crs:SplitToningShadowHue="210"');
    expect(xmp).toContain('crs:ColorGradeMidtoneSat="8"');
    expect(xmp).toContain('crs:GrayMixerYellow="+40"');
    for (const k of ['cx', 'cy', 'w', 'h', 'angle'] as const) expect(recipe.crop[k]).toBeCloseTo(r.crop[k], 5);
    expect(recipe.crop.rotate90).toBe(1);
  });

  it('round-trips as-shot white balance and leaves the crop out without a context', () => {
    const r = sample();
    r.wb = { mode: 'asShot', temp: 5500, tint: 0 };
    const xmp = recipeToXmp(r);
    expect(xmp).not.toContain('CropTop');
    const { recipe } = imported(xmp);
    expect(recipe.wb.mode).toBe('asShot');
  });

  it('writes a Lightroom preset with a name and preset fields', () => {
    const xmp = patchToXmp({ basic: { exposure: 0.5, vibrance: 10 } }, { asPreset: true, name: 'Bright <&> Clean' });
    expect(xmp).toContain('crs:PresetType="Normal"');
    expect(xmp).toMatch(/crs:UUID="[0-9A-F]{32}"/);
    expect(xmp).toContain('crs:Exposure2012="+0.50"');
    expect(xmp).not.toContain('crs:Contrast2012');
    const crs = parseXmp(xmp)!;
    expect(crs.name).toBe('Bright <&> Clean');
    expect(crs.values.Group).toBe('immich-raw');
    expect(crsToPatch(crs).groups).toEqual(['tone', 'presence']);
  });

  it('formats numbers the way Lightroom does', () => {
    expect(formatNumber(0.5, 2, true)).toBe('+0.50');
    expect(formatNumber(-0.001, 2, true)).toBe('0.00');
    expect(formatNumber(0, 0, true)).toBe('0');
    expect(formatNumber(-20, 0, true)).toBe('-20');
    expect(formatNumber(40, 0, false)).toBe('40');
  });
});
