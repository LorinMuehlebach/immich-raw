import { describe, expect, it } from 'vitest';
import { autoScale, evalRadial, sourcePoint, vignetteGain } from './apply.ts';
import { fitRadialPoly } from './fit.ts';
import { IDENTITY_POLY, type LensCorrection, type RadialPoly } from './types.ts';

const W = 6000;
const H = 4000;
const N = Math.hypot(W, H) / 2;

function geometry(poly: RadialPoly, red = poly, blue = poly): LensCorrection {
  return { source: 'test', geometry: { center: [0.5, 0.5], scale: [W / N, H / N], poly: [red, poly, blue] }, vignetting: null };
}

/** Is every border point of the frame, zoomed by `zoom`, inside the image in all channels? */
function filled(corr: LensCorrection, zoom: number): boolean {
  for (let i = 0; i <= 400; i++) {
    const u = i / 400;
    for (const [x, y] of [[u, 0], [u, 1], [0, u], [1, u]] as const) {
      for (const c of [0, 1, 2] as const) {
        const [sx, sy] = sourcePoint(corr, 0.5 + (x - 0.5) / zoom, 0.5 + (y - 0.5) / zoom, c);
        if (sx < 0 || sx > 1 || sy < 0 || sy > 1) return false;
      }
    }
  }
  return true;
}

describe('sourcePoint', () => {
  it('follows r_src = r · Σ poly[i] rⁱ around the centre', () => {
    const poly: RadialPoly = [1, 0.02, -0.05, 0, 0.01, 0, 0];
    const corr = geometry(poly);
    const [x, y] = [0.8, 0.3];
    const r = Math.hypot((x - 0.5) * (W / N), (y - 0.5) * (H / N));
    const [sx, sy] = sourcePoint(corr, x, y, 1);
    expect(Math.hypot((sx - 0.5) * (W / N), (sy - 0.5) * (H / N))).toBeCloseTo(r * evalRadial(poly, r), 12);
    // Radial: the direction is kept.
    expect((sy - 0.5) / (sx - 0.5)).toBeCloseTo((y - 0.5) / (x - 0.5), 12);
    expect(sourcePoint(corr, 0.5, 0.5, 0)).toEqual([0.5, 0.5]);
    expect(sourcePoint({ ...corr, geometry: null }, 0.2, 0.7, 2)).toEqual([0.2, 0.7]);
  });

  it('r = 1 is the image corner in the Lensfun frame', () => {
    const corr = geometry([1, 0, 0.1, 0, 0, 0, 0]);
    const [sx, sy] = sourcePoint(corr, 1, 1, 1);
    expect(sx).toBeCloseTo(0.5 + 0.5 * 1.1, 12);
    expect(sy).toBeCloseTo(0.5 + 0.5 * 1.1, 12);
  });
});

describe('vignetteGain', () => {
  const v = (mode: 'multiply' | 'divide'): LensCorrection => ({
    source: 'test',
    geometry: null,
    vignetting: { center: [0.5, 0.5], scale: [W / N, H / N], mode, k: [-0.5, 0.1, 0, 0, 0.01] },
  });
  it('multiplies by g (DNG) or divides by it (Lensfun pa)', () => {
    const g = 1 - 0.5 + 0.1 + 0.01;
    expect(vignetteGain(v('multiply'), 0, 0)).toBeCloseTo(g, 12);
    expect(vignetteGain(v('divide'), 1, 1)).toBeCloseTo(1 / g, 12);
    expect(vignetteGain(v('divide'), 0.5, 0.5)).toBe(1);
    expect(vignetteGain({ ...v('divide'), vignetting: null }, 0, 0)).toBe(1);
  });
});

describe('autoScale', () => {
  it('is 1 without geometry or distortion', () => {
    expect(autoScale({ source: 't', geometry: null, vignetting: null })).toBe(1);
    expect(autoScale(geometry([...IDENTITY_POLY] as RadialPoly))).toBeCloseTo(1, 6);
  });

  it('crops in for pincushion sources and zooms out for barrel sources, just enough', () => {
    for (const poly of [
      [1, 0, 0.08, 0, 0, 0, 0],
      [1, 0, -0.06, 0, 0, 0, 0],
      [1, 0.1078, -0.2945, 0.1039, 0, 0, 0],
    ] as RadialPoly[]) {
      const corr = geometry(poly);
      const zoom = autoScale(corr);
      expect(zoom > 1).toBe(evalRadial(poly, 1) > 1);
      expect(filled(corr, zoom)).toBe(true);
      expect(filled(corr, zoom * 0.999)).toBe(false);
    }
  });

  it('accounts for every colour channel', () => {
    const g: RadialPoly = [1, 0, 0.05, 0, 0, 0, 0];
    const red = g.map((c) => c * 1.002) as RadialPoly;
    const corr = geometry(g, red, g);
    expect(autoScale(corr)).toBeGreaterThan(autoScale(geometry(g)) * 1.0015);
    expect(filled(corr, autoScale(corr))).toBe(true);
  });

  it('stops where a strong barrel model folds back', () => {
    // Square frame, r_src = r - 0.3 r³: r_src peaks (0.70) at r = 1/√0.9 before reaching
    // any border, so every ray ends at the fold and the corner ray decides.
    const corr: LensCorrection = {
      source: 'test',
      geometry: { center: [0.5, 0.5], scale: [Math.SQRT2, Math.SQRT2], poly: Array(3).fill([1, 0, -0.3, 0, 0, 0, 0]) as [RadialPoly, RadialPoly, RadialPoly] },
      vignetting: null,
    };
    expect(autoScale(corr)).toBeCloseTo(Math.sqrt(0.9), 4);
  });
});

describe('fitRadialPoly', () => {
  it('reproduces representable functions and approximates others closely', () => {
    const exact: RadialPoly = [1.001, 0.01, -0.02, 0.003, 0, 0.0001, 0];
    const fit = fitRadialPoly((r) => r * evalRadial(exact, r), 1.2);
    fit.forEach((c, i) => expect(c).toBeCloseTo(exact[i]!, 9));
    // A composed model like Lensfun's poly3 TCA after distortion.
    const d = (r: number) => r * (1 + 0.1 * r - 0.3 * r * r + 0.1 * r ** 3);
    const target = (r: number) => d(r) * (1.0002 - 0.0005 * d(r) + 0.0003 * d(r) ** 2);
    const p = fitRadialPoly(target, 1.1);
    let worst = 0;
    for (let i = 0; i <= 1000; i++) {
      const r = (i / 1000) * 1.1;
      worst = Math.max(worst, Math.abs(r * evalRadial(p, r) - target(r)));
    }
    expect(worst).toBeLessThan(1e-7);
  });
});
