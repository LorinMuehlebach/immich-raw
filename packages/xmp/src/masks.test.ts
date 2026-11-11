import { applyPatch, defaultRecipe, type BrushComponent, type ColorComponent, type LinearComponent, type LuminanceComponent, type Mask, type RadialComponent } from '@immich-raw/recipe';
import { describe, expect, it } from 'vitest';
// Test-only cross-check against the renderer's mask maths.
import { componentWeight, maskWeight } from '../../pipeline/src/masks.ts';
import type { CropContext } from './crop.ts';
import {
  LEGACY_PV2012,
  LUMINANCE_PRESET,
  MASK_GROUP_SIDECAR,
  brushLi,
  colorLi,
  correction,
  linearLi,
  orientedSidecar,
  withCorrections,
} from './fixtures/masks.ts';
import { crsToPatch, importMasks, parseXmp, type XmpStruct } from './index.ts';
import { featherFromCenterWeight } from './masks.ts';

const LANDSCAPE: CropContext = { flip: 0, uprightWidth: 6000, uprightHeight: 4000 };

const masksOf = (xmp: string, ctx?: CropContext) => {
  const crs = parseXmp(xmp);
  expect(crs).not.toBeNull();
  const r = importMasks(crs!, ctx);
  expect(r).not.toBeNull();
  return r!;
};
const byName = (masks: Mask[], name: string) => {
  const m = masks.find((x) => x.name === name);
  expect(m, name).toBeDefined();
  return m!;
};

describe('parseXmp: nested structures', () => {
  it('keeps corrections, their components and nested lists in attribute form', () => {
    const crs = parseXmp(MASK_GROUP_SIDECAR)!;
    expect(crs.lists.MaskGroupBasedCorrections).toHaveLength(7);
    const list = crs.structs.MaskGroupBasedCorrections!;
    expect(list).toHaveLength(7);
    const face = list[1] as XmpStruct;
    expect(face.CorrectionName).toBe('Face');
    const [radial, range] = face.CorrectionMasks as XmpStruct[];
    expect(radial!.What).toBe('Mask/CircularGradient');
    expect((range!.CorrectionRangeMask as XmpStruct).LumRange).toBe('0.200000 0.400000 0.600000 0.800000');
    // A range mask whose fields sit in an rdf:Description child element.
    const leaves = (list[3] as XmpStruct).CorrectionMasks as XmpStruct[];
    expect((leaves[0]!.CorrectionRangeMask as XmpStruct).PointModels).toEqual([
      '0.025415 0.608701 0.151080 0.769070 0.935510 0',
      '0.371385 0.204889 0.674661 0.322933 0.653548 1',
    ]);
    const brush = ((list[2] as XmpStruct).CorrectionMasks as XmpStruct[])[0]!;
    expect(((brush.Masks as XmpStruct[])[0]!.Dabs as string[])[0]).toBe('h 0.1621');
  });

  it('reads element form (rdf:parseType="Resource") the same way', () => {
    const crs = parseXmp(LEGACY_PV2012)!;
    const grad = crs.structs.GradientBasedCorrections![0] as XmpStruct;
    expect(grad.LocalExposure2012).toBe('0.125000');
    expect((grad.CorrectionMasks as XmpStruct[]).map((m) => m.What)).toEqual(['Mask/Gradient', 'Mask/Paint', 'Mask/Paint']);
    expect((grad.CorrectionRangeMask as XmpStruct).LumMin).toBe('0.500000');
    expect(crs.values.Exposure2012).toBe('0');
  });
});

describe('importMasks: Lightroom 11+ mask groups', () => {
  // 6000 x 4000 sensor: mask frame x in [0, 1], y in [0, 2/3].
  const { masks, warnings, unmapped, imported } = masksOf(MASK_GROUP_SIDECAR, LANDSCAPE);

  it('imports every mask it can, in order', () => {
    expect(masks.map((m) => m.name)).toEqual(['Sky', 'Face', 'Brush', 'Leaves', 'Vignette', 'Eyes']);
    expect(imported).toEqual({ MaskGroupBasedCorrections: 6 });
  });

  it('maps a linear gradient with a subtracted radial, and the slider scales', () => {
    const sky = byName(masks, 'Sky');
    expect(sky.components.map((c) => [c.kind, c.mode, c.invert])).toEqual([
      ['linear', 'add', false],
      ['radial', 'subtract', false],
    ]);
    const lin = sky.components[0] as LinearComponent;
    expect([lin.x0, lin.y0, lin.x1, lin.y1].map((v) => +v.toFixed(5))).toEqual([0.5, 0.06667, 0.5, 0.3]);
    const rad = sky.components[1] as RadialComponent;
    expect(rad.cx).toBeCloseTo(0.7, 6);
    expect(rad.cy).toBeCloseTo(0.25 * (2 / 3), 6);
    // 0.2 of the width and 0.3 of the height on a 3:2 sensor: a circle.
    expect(rad.rx).toBeCloseTo(0.1, 6);
    expect(rad.ry).toBeCloseTo(0.1, 6);
    expect(rad.feather).toBe(50);
    expect(sky.adjust).toMatchObject({ exposure: -1, dehaze: 20, temp: -10 });
    expect(sky.amount).toBe(100);
    expect(sky.visible).toBe(true);
    // The renderer: full effect at the gradient's start, none in the subtracted sun.
    expect(maskWeight(sky, [0.5, 0.0667])).toBeCloseTo(1, 3);
    expect(maskWeight(sky, [0.7, 0.25 * (2 / 3)])).toBe(0);
  });

  it('decodes a turned radial from its turned box corners (real Lightroom values)', () => {
    const face = byName(masks, 'Face');
    const rad = face.components[0] as RadialComponent;
    expect(rad.cx).toBeCloseTo(0.548387, 6);
    expect(rad.cy).toBeCloseTo(0.681925 * (2 / 3), 6);
    // About 1384 x 177 px on the 6000 px wide sensor, long axis turned 25.8° counter-clockwise.
    expect(rad.rx * 6000).toBeCloseTo(1384.3, 0);
    expect(rad.ry * 6000).toBeCloseTo(177.1, 0);
    expect(rad.angle).toBeCloseTo(360 - 25.7968, 4);
    expect(rad.feather).toBe(25);
    // (Left, Top) is the ellipse box corner (-rx, -ry) in the renderer's ellipse frame.
    const r = (rad.angle * Math.PI) / 180;
    const [qx, qy] = [0.32781 - rad.cx, 0.792661 * (2 / 3) - rad.cy];
    expect((qx * Math.cos(r) + qy * Math.sin(r)) / rad.rx).toBeCloseTo(-1, 4);
    expect((-qx * Math.sin(r) + qy * Math.cos(r)) / rad.ry).toBeCloseTo(-1, 4);
    // Along the long axis the effect is full; across it, at the same distance, none.
    const along: [number, number] = [rad.cx + 0.7 * rad.rx * Math.cos(r), rad.cy + 0.7 * rad.rx * Math.sin(r)];
    const across: [number, number] = [rad.cx - 0.7 * rad.rx * Math.sin(r), rad.cy + 0.7 * rad.rx * Math.cos(r)];
    expect(componentWeight(rad, along)).toBe(1);
    expect(componentWeight(rad, across)).toBe(0);
  });

  it('turns "subtract the inverted luminance range" into an intersect', () => {
    const face = byName(masks, 'Face');
    const lum = face.components[1] as LuminanceComponent;
    expect([lum.kind, lum.mode, lum.invert]).toEqual(['luminance', 'intersect', false]);
    expect(lum.lo).toBeCloseTo(40, 6);
    expect(lum.hi).toBeCloseTo(60, 6);
    expect(lum.smooth).toBeCloseTo(40, 6);
    expect(face.amount).toBe(80);
    expect(face.adjust.whites).toBe(15);
    expect(face.adjust.hue).toBeCloseTo(50, 3);
    expect(face.adjust.colorHue).toBe(40);
    expect(face.adjust.colorSat).toBe(30);
    // In the ellipse: mid-tones get the full effect, bright tones none.
    const rad = face.components[0] as RadialComponent;
    expect(maskWeight(face, [rad.cx, rad.cy], 0.5)).toBe(1);
    expect(maskWeight(face, [rad.cx, rad.cy], 0.9)).toBe(0);
  });

  it('maps a brush: strokes, radius changes, flow, density, feather and erasing', () => {
    const brush = byName(masks, 'Brush');
    expect(brush.components).toHaveLength(1);
    const c = brush.components[0] as BrushComponent;
    expect(c.kind).toBe('brush');
    expect(c.strokes).toHaveLength(3);
    const [a, b, e] = c.strokes as [BrushComponent['strokes'][0], BrushComponent['strokes'][0], BrushComponent['strokes'][0]];
    expect(a).toMatchObject({ erase: false, size: 0.02, feather: 50, flow: 30, density: 40 });
    expect(a.points).toEqual([0.2, 0.33333, 0.25, 0.33333]);
    // "r 0.03" (+50 %) starts a new stroke where the last one ended.
    expect(b).toMatchObject({ erase: false, size: 0.03 });
    expect(b.points).toEqual([0.25, 0.33333, 0.3, 0.33333]);
    expect(e).toMatchObject({ erase: true, size: 0.01, feather: 100, flow: 100, density: 100 });
    expect(e.points).toEqual([0.22, 0.33333, 0.24, 0.33333]);
    expect(brush.adjust).toMatchObject({ shadows: 35, clarity: -40 });
  });

  it('maps a colour range: sample positions and Refine', () => {
    const leaves = byName(masks, 'Leaves');
    const c = leaves.components[0] as ColorComponent;
    expect(c.kind).toBe('color');
    expect(c.refine).toBe(50);
    expect(c.samples).toHaveLength(2);
    expect(c.samples[0]!.x).toBeCloseTo(0.76907, 6);
    expect(c.samples[0]!.y).toBeCloseTo(0.93551 * (2 / 3), 6);
    expect(c.samples[1]!.x).toBeCloseTo(0.322933, 6);
    expect(c.samples[1]!.r).toBe(0);
    expect(leaves.adjust.saturation).toBe(-50);
  });

  it('maps an inverted radial (Flipped is only the complement of MaskInverted) and a hidden mask', () => {
    const v = byName(masks, 'Vignette');
    const rad = v.components[0] as RadialComponent;
    expect(rad.invert).toBe(true);
    expect(rad.cx).toBeCloseTo((0.080253 + 1.182154) / 2, 6);
    expect(rad.rx).toBeCloseTo((1.182154 - 0.080253) / 2, 6);
    expect(rad.ry).toBeCloseTo(((1.047745 + 0.456202) / 2) * (2 / 3), 6);
    expect(rad.feather).toBe(37);
    expect(v.visible).toBe(false);
    expect(v.adjust.exposure).toBe(-0.25);
    // Effect in the corners, not in the middle.
    expect(componentWeight(rad, [rad.cx, rad.cy])).toBe(0);
    expect(componentWeight(rad, [0.01, 0.66])).toBe(1);
  });

  it('skips AI selections with a warning, keeping the rest of a mask', () => {
    expect(masks.some((m) => m.name === 'Sky AI')).toBe(false);
    expect(warnings).toContain(`Mask "Sky AI" skipped: Select Sky (AI) can't be imported`);
    const eyes = byName(masks, 'Eyes');
    expect(eyes.components.map((c) => c.kind)).toEqual(['radial']);
    expect(eyes.adjust.sharpness).toBe(25);
    expect(warnings).toContain(`Mask "Eyes": Select People (AI) left out (can't be imported)`);
  });

  it('reports local sliders we have no counterpart for', () => {
    expect(unmapped).toEqual(['MaskGroupBasedCorrections.LocalMoire']);
    expect(warnings).toContain('Mask sliders not supported (ignored): Moiré');
  });
});

describe('importMasks: process version 2012 corrections', () => {
  const { masks, warnings, imported } = masksOf(LEGACY_PV2012, LANDSCAPE);

  it('names them by tool and reads all three containers', () => {
    expect(masks.map((m) => m.name)).toEqual(['Linear Gradient 1', 'Radial Gradient 1', 'Radial Gradient 2', 'Brush 1']);
    expect(imported).toEqual({ GradientBasedCorrections: 1, CircularGradientBasedCorrections: 2, PaintBasedCorrections: 1 });
    expect(warnings).toEqual([]);
  });

  it('refines a graduated filter with brush strokes and its range mask', () => {
    const m = byName(masks, 'Linear Gradient 1');
    expect(m.components.map((c) => [c.kind, c.mode, c.invert])).toEqual([
      ['linear', 'add', false],
      ['brush', 'subtract', false],
      ['brush', 'add', false],
      ['luminance', 'intersect', false],
    ]);
    const lin = m.components[0] as LinearComponent;
    expect([lin.x0, lin.y0, lin.x1, lin.y1].map((v) => +v.toFixed(5))).toEqual([0.5, 0.66667, 0.5, 0.46667]);
    // The erasing stroke removes from the whole mask, so it is a subtracted brush of its own.
    expect((m.components[1] as BrushComponent).strokes).toEqual([{ erase: false, size: 0.05, feather: 100, flow: 100, density: 100, points: [0.5, 0.6, 0.6, 0.6] }]);
    expect((m.components[2] as BrushComponent).strokes[0]!.points).toEqual([0.1, 0.2]);
    expect(m.components[3]).toMatchObject({ lo: 50, hi: 100, smooth: 30 });
    expect(m.adjust).toMatchObject({ exposure: 0.5, contrast: 20, colorHue: 240, colorSat: 0 });
  });

  it('reads Flipped on a Radial Filter: effect inside only when set', () => {
    const inside = byName(masks, 'Radial Gradient 1');
    const rad = inside.components[0] as RadialComponent;
    expect(rad.invert).toBe(false);
    expect(rad.cx).toBeCloseTo((0.491508 + 0.594848) / 2, 6);
    expect(rad.rx).toBeCloseTo((0.594848 - 0.491508) / 2, 6);
    expect(rad.ry).toBeCloseTo(((0.503248 - 0.32839) / 2) * (2 / 3), 6);
    expect(inside.components).toHaveLength(1);
    expect(inside.adjust.sharpness).toBeCloseTo(29.9758, 4);
    expect(inside.adjust.colorHue).toBe(341);
    const outside = byName(masks, 'Radial Gradient 2');
    expect((outside.components[0] as RadialComponent).invert).toBe(true);
    expect((outside.components[0] as RadialComponent).feather).toBe(100);
    expect(outside.adjust.exposure).toBeCloseTo(-0.4, 9);
  });

  it('keeps a brush correction as one brush with its erasing stroke in order', () => {
    const m = byName(masks, 'Brush 1');
    expect(m.components).toHaveLength(1);
    const strokes = (m.components[0] as BrushComponent).strokes;
    expect(strokes.map((s) => [s.erase, s.size, s.points.length / 2])).toEqual([
      [false, 0.135597, 3],
      [true, 0.05, 2],
    ]);
    // Flow 0.687 -> 69 (whole slider steps).
    expect(strokes[0]).toMatchObject({ feather: 100, flow: 69, density: 100 });
    expect(m.adjust.exposure).toBeCloseTo(-0.279, 9);
  });
});

describe('importMasks: orientation', () => {
  // The same sensor (6000 x 4000) whatever the camera or Lightroom said about rotating it.
  const sensorLandscape: CropContext[] = [
    { flip: 6, uprightWidth: 4000, uprightHeight: 6000 },
    { flip: 5, uprightWidth: 4000, uprightHeight: 6000 },
    { flip: 0, uprightWidth: 6000, uprightHeight: 4000 },
  ];

  it('puts positions in the sensor-orientation mask frame for flip 0, 5 and 6', () => {
    for (const ctx of sensorLandscape) {
      for (const orientation of [6, 8, 1]) {
        const [m] = masksOf(orientedSidecar(orientation), ctx).masks;
        const [lin, rad, brush] = m!.components as [LinearComponent, RadialComponent, BrushComponent];
        expect([lin.x0, lin.y0, lin.x1, lin.y1].map((v) => +v.toFixed(5))).toEqual([0.25, 0.33333, 0.75, 0.33333]);
        expect(rad.cx).toBeCloseTo(0.5, 6);
        expect(rad.cy).toBeCloseTo(1 / 3, 6);
        // Box half-diagonal (0.1, 0.1) turned back by 30°.
        expect(rad.rx).toBeCloseTo(0.1 * (Math.cos(Math.PI / 6) + 0.5), 6);
        expect(rad.ry).toBeCloseTo(0.1 * (Math.cos(Math.PI / 6) - 0.5), 6);
        expect(rad.angle).toBe(30);
        expect(brush.strokes[0]!.points).toEqual([0.5, 0.33333, 0.5, 0.4]);
        expect(brush.strokes[0]!.size).toBe(0.05);
      }
    }
  });

  it('uses the other aspect for a camera that stores portrait pixels', () => {
    const ctx: CropContext = { flip: 0, uprightWidth: 4000, uprightHeight: 6000 };
    const [m] = masksOf(orientedSidecar(1), ctx).masks;
    const [lin, rad] = m!.components as [LinearComponent, RadialComponent];
    expect([lin.x0, lin.y0, lin.x1, lin.y1].map((v) => +v.toFixed(5))).toEqual([0.16667, 0.5, 0.5, 0.5]);
    expect(rad.cx).toBeCloseTo(1 / 3, 6);
    expect(rad.cy).toBeCloseTo(0.5, 6);
    expect(rad.rx).toBeCloseTo(0.132735, 5);
    expect(rad.ry).toBeCloseTo(0.0965705, 5);
  });
});

describe('importMasks: without the photo size', () => {
  it('imports luminance ranges and skips masks that need positions', () => {
    const { masks, warnings } = masksOf(LUMINANCE_PRESET);
    expect(masks.map((m) => m.name)).toEqual(['5 - Light', '1 - Dark']);
    const light = masks[0]!.components[0] as LuminanceComponent;
    // One fall-off side: the full-strength handle stays where it was.
    expect(light.lo).toBeCloseTo(80.1473, 3);
    expect(light.hi).toBe(100);
    expect(light.smooth).toBeCloseTo(2 * (80.1473 - 60.2343), 3);
    const dark = masks[1]!.components[0] as LuminanceComponent;
    expect(dark.lo).toBe(0);
    expect(dark.hi).toBeCloseTo(19.8525, 3);
    expect(masks[0]!.adjust.exposure).toBeCloseTo(-0.4, 9);
    expect(warnings).toEqual(['1 mask skipped (mask positions need the photo size)']);
  });

  it('imports them all with the photo size', () => {
    const { masks } = masksOf(LUMINANCE_PRESET, { flip: 6, uprightWidth: 4000, uprightHeight: 6000 });
    expect(masks.map((m) => m.name)).toEqual(['5 - Light', '1 - Dark', 'Corners']);
    expect((masks[2]!.components[0] as RadialComponent).invert).toBe(true);
  });
});

describe('importMasks: limits', () => {
  it('keeps the first 8 masks', () => {
    const xmp = withCorrections(Array.from({ length: 10 }, (_, i) => correction(`M${i + 1}`, [linearLi()])));
    const { masks, warnings } = masksOf(xmp, LANDSCAPE);
    expect(masks).toHaveLength(8);
    expect(warnings).toEqual(['2 masks over the limit of 8 skipped: "M9", "M10"']);
  });

  it('skips a mask that would go over 24 parts in total', () => {
    const xmp = withCorrections(Array.from({ length: 5 }, (_, i) => correction(`C${i + 1}`, Array.from({ length: 5 }, () => linearLi()))));
    const { masks, warnings } = masksOf(xmp, LANDSCAPE);
    expect(masks.map((m) => m.name)).toEqual(['C1', 'C2', 'C3', 'C4']);
    expect(warnings).toEqual(['Mask "C5" skipped: more than 24 mask parts in total']);
  });

  it('skips a mask that would go over 8 brushes in total', () => {
    const two = [brushLi(['d 0.1 0.1', 'd 0.2 0.1']), brushLi(['d 0.3 0.3'], 1)];
    const xmp = withCorrections(Array.from({ length: 5 }, (_, i) => correction(`B${i + 1}`, two)));
    const { masks, warnings } = masksOf(xmp, LANDSCAPE);
    expect(masks).toHaveLength(4);
    expect(masks[0]!.components.map((c) => [c.kind, c.mode])).toEqual([
      ['brush', 'add'],
      ['brush', 'subtract'],
    ]);
    expect(warnings).toEqual(['Mask "B5" skipped: more than 8 brushes in total']);
  });

  it('keeps 5 colour samples and shortens very long brush strokes', () => {
    const points: [number, number][] = Array.from({ length: 7 }, (_, i) => [0.1 * (i + 1), 0.5]);
    const dabs = Array.from({ length: 20005 }, (_, i) => `d ${(i / 30000).toFixed(6)} 0.5`);
    const xmp = withCorrections([correction('Colors', [colorLi(points)]), correction('Long', [brushLi(dabs)])]);
    const { masks, warnings } = masksOf(xmp, LANDSCAPE);
    const color = masks[0]!.components[0] as ColorComponent;
    expect(color.samples.map((s) => +s.x.toFixed(5))).toEqual([0.1, 0.2, 0.3, 0.4, 0.5]);
    expect(color.refine).toBe(80);
    expect((masks[1]!.components[0] as BrushComponent).strokes[0]!.points).toHaveLength(2 * 20000);
    expect(warnings).toEqual(['Mask "Colors": only the first 5 colour samples kept', 'Mask "Long": brush strokes shortened to 20000 points']);
  });

  it('drops a subtraction with nothing to subtract from', () => {
    const xmp = withCorrections([correction('Nothing', [linearLi(1)]), correction('Fine', [linearLi(), linearLi(1)])]);
    const { masks, warnings } = masksOf(xmp, LANDSCAPE);
    expect(masks.map((m) => m.name)).toEqual(['Fine']);
    expect(masks[0]!.components.map((c) => c.mode)).toEqual(['add', 'subtract']);
    expect(warnings).toEqual(['Mask "Nothing" skipped: nothing to import']);
  });
});

describe('crsToPatch: masks', () => {
  it('puts the masks in the patch, replacing ours', () => {
    const r = crsToPatch(parseXmp(MASK_GROUP_SIDECAR)!, LANDSCAPE);
    expect(r.groups).toContain('masks');
    expect(r.applied).toContainEqual({ key: 'MaskGroupBasedCorrections', value: '6 masks', path: 'masks' });
    expect(r.unmapped).toContain('MaskGroupBasedCorrections.LocalMoire');
    expect(r.unmapped).not.toContain('MaskGroupBasedCorrections');
    const before = defaultRecipe();
    before.masks = [{ ...byName(masksOf(LEGACY_PV2012, LANDSCAPE).masks, 'Brush 1'), name: 'Mine' }];
    const recipe = applyPatch(before, r.patch);
    expect(recipe.masks.map((m) => m.name)).toEqual(['Sky', 'Face', 'Brush', 'Leaves', 'Vignette', 'Eyes']);
  });

  it('lists each process 2012 container it took masks from', () => {
    const r = crsToPatch(parseXmp(LEGACY_PV2012)!, LANDSCAPE);
    expect(r.applied.filter((a) => a.path === 'masks')).toEqual([
      { key: 'GradientBasedCorrections', value: '1 mask', path: 'masks' },
      { key: 'CircularGradientBasedCorrections', value: '2 masks', path: 'masks' },
      { key: 'PaintBasedCorrections', value: '1 mask', path: 'masks' },
    ]);
  });

  it('leaves masks out of the patch when none can be imported', () => {
    const r = crsToPatch(parseXmp(withCorrections([correction('Nothing', [linearLi(1)])]))!, LANDSCAPE);
    expect(r.groups).not.toContain('masks');
    expect(r.unmapped).toContain('MaskGroupBasedCorrections');
  });
});

describe('featherFromCenterWeight', () => {
  it('hits the values Lightroom wrote and interpolates in between', () => {
    expect(featherFromCenterWeight(0.035858)).toBeCloseTo(80, 9);
    expect(featherFromCenterWeight(0.16214)).toBeCloseTo(50, 9);
    expect(featherFromCenterWeight(0.501304)).toBeCloseTo(20, 9);
    expect(featherFromCenterWeight(0)).toBe(100);
    expect(featherFromCenterWeight(1)).toBeCloseTo(0, 9);
    expect(featherFromCenterWeight(0.1)).toBeCloseTo(80 - (30 * (0.1 - 0.035858)) / (0.16214 - 0.035858), 9);
  });
});
