import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { autoScale, sourcePoint, vignetteGain } from './apply.ts';
import {
  findCamera,
  findLens,
  fuzzyCompare,
  fuzzyWords,
  hermite,
  interpolateDistortion,
  interpolateTca,
  interpolateVignetting,
  lensfunCorrection,
  lensfunToCorrection,
  loadLensfun,
  searchLenses,
  lensDisplayName,
  type LensfunJson,
  type LensfunJsonLens,
  type LfLens,
} from './lensfun.ts';

const DB_URL = new URL('../../../apps/editor/public/lensfun/lensfun.json', import.meta.url);
const db = loadLensfun(JSON.parse(readFileSync(DB_URL, 'utf8')) as LensfunJson);

/** A one-lens database, to exercise loading as well. */
function lensOf(l: Partial<LensfunJsonLens>): LfLens {
  const json: LensfunJson = {
    format: 1,
    source: { repo: '', commit: '', date: '', license: '' },
    mounts: ['Test'],
    compat: {},
    cameras: [],
    lenses: [{ m: 'Test', n: 'Test lens', mt: [0], c: 1, ...l }],
  };
  return loadLensfun(json).lenses[0]!;
}

describe('fuzzy name matching (lfFuzzyStrCmp)', () => {
  it('splits like Lensfun', () => {
    expect(fuzzyWords('XF18mmF2 R')).toEqual(['18', '2', 'mmf', 'r', 'xf']);
    // Lone "f" and punctuation go, "28.0" becomes "28", "+" stays.
    expect(fuzzyWords('28.0mm f/1.7 +')).toEqual(['+', '1.7', '28', 'mm']);
    expect(fuzzyWords('Sigma 50mm f/1.4 DG HSM [A]')).toEqual(['1.4', '50', 'a', 'dg', 'hsm', 'mm', 'sigma']);
  });

  it('scores 200 · matched / (pattern + match words)', () => {
    const p = fuzzyWords('FE 50mm F1.2 GM');
    expect(fuzzyCompare(p, fuzzyWords('FE 50mm f/1.2 GM'), true)).toBe(100);
    expect(fuzzyCompare(p, fuzzyWords('Sony FE 50mm f/1.2 GM'), true)).toBe(Math.trunc((5 * 200) / 11));
    // Strict: every pattern word must be present; loose counts what matches.
    expect(fuzzyCompare(fuzzyWords('Sony FE 50mm F1.2 GM'), fuzzyWords('FE 50mm f/1.2 GM'), true)).toBe(0);
    expect(fuzzyCompare(fuzzyWords('Sony FE 50mm F1.2 GM'), fuzzyWords('FE 50mm f/1.2 GM'), false)).toBe(Math.trunc((5 * 200) / 11));
  });
});

describe('interpolation (lfLens::Interpolate*)', () => {
  it('Hermite spline with one-sided tangents is linear between two points', () => {
    expect(hermite(null, 2, 4, null, 0.25)).toBeCloseTo(2.5, 12);
  });

  it('distortion: exact focal, spline in terms·focal, nearest outside the range', () => {
    // terms·f = f² on a uniform grid: the Catmull-Rom spline reproduces quadratics exactly.
    const lens = lensOf({ dm: 'poly5', d: [10, 20, 30, 40].map((f) => [f, f, 1 / f]) });
    expect(interpolateDistortion(lens, 1, 20)!.terms).toEqual([20, 1 / 20]);
    const mid = interpolateDistortion(lens, 1, 25)!;
    expect(mid.terms[0]).toBeCloseTo(25, 10);
    // terms·f = 1 is constant, so the term is 1/f.
    expect(mid.terms[1]).toBeCloseTo(1 / 25, 12);
    expect(interpolateDistortion(lens, 1, 55)!.terms).toEqual([40, 1 / 40]);
    expect(interpolateDistortion(lens, 1, 5)!.terms).toEqual([10, 1 / 10]);
  });

  it('distortion: picks the right neighbours (Nikkor Z 24-70 f/4 at 56 mm)', () => {
    const lens = db.lensById.get('Nikon/Nikkor Z 24-70mm f/4 S')!;
    const at = (f: number) => lens.distortion.find((d) => d.focal === f)!;
    // Above 56: 70 (no further point), below: 50 then 35. The spline runs from 70 to 50.
    const t = (56 - 70) / (50 - 70);
    const expected = [0, 1, 2].map((i) => hermite(null, at(70).terms[i]! * 70, at(50).terms[i]! * 50, at(35).terms[i]! * 35, t) / 56);
    const got = interpolateDistortion(lens, 1, 56)!;
    got.terms.forEach((v, i) => expect(v).toBeCloseTo(expected[i]!, 12));
    expect(got.model).toBe('ptlens');
  });

  it('TCA: v terms unscaled, c and b terms scaled by focal length', () => {
    const lens = lensOf({ tm: 'poly3', tc: [[20, 1.001, 0.999, 0.002], [40, 1.003, 0.997, 0.001]] });
    const r = interpolateTca(lens, 1, 30)!;
    expect(r.terms[0]).toBeCloseTo(1.002, 12);
    expect(r.terms[1]).toBeCloseTo(0.998, 12);
    expect(r.terms[2]).toBeCloseTo((0.5 * (0.002 * 20) + 0.5 * (0.001 * 40)) / 30, 12);
  });

  it('vignetting: inverse distance weighting over focal, 4/aperture, 0.1/distance', () => {
    const lens = lensOf({
      f: [24, 70],
      v: [
        [24, 4, 1000, -0.4, 0.1, 0],
        [24, 8, 1000, -0.2, 0.05, 0],
        [70, 4, 1000, -0.6, 0.2, 0.1],
      ],
    });
    expect(interpolateVignetting(lens, 1, 24, 8, 1000)!.k).toEqual([-0.2, 0.05, 0]);
    const d = (f: number, a: number) => Math.hypot((f - 24) / 46, 4 / a - 4 / 5.6);
    const w = [d(24, 4), d(24, 8), d(70, 4)].map((x) => x ** -3.5);
    const k1 = (w[0]! * -0.4 + w[1]! * -0.2 + w[2]! * -0.6) / (w[0]! + w[1]! + w[2]!);
    expect(interpolateVignetting(lens, 1, 24, 5.6, 1000)!.k[0]).toBeCloseTo(k1, 12);
    // Nearest calibration further than 1 away: no correction (f/1.4 is 4/1.4 - 1 > 1 away).
    expect(interpolateVignetting(lens, 1, 24, 1.4, 1000)).toBeNull();
  });

  it('refuses calibrations from a sensor more than 4 % larger than the camera', () => {
    const lens = lensOf({ c: 1.5, dm: 'poly3', d: [[50, 0.01]] });
    expect(interpolateDistortion(lens, 1.0, 50)).toBeNull();
    expect(interpolateDistortion(lens, 1.45, 50)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------------------
// An independent re-implementation of lfModifier in Lensfun's own normalised units
// (modifier.cpp, mod-coord.cpp, mod-subpix.cpp, mod-color.cpp), in pixel coordinates.

interface RefSetup {
  w: number;
  h: number;
  cameraCrop: number;
  calibCrop: number;
  aspect: number;
  realFocal: number;
  dist?: { model: 'poly3' | 'poly5' | 'ptlens'; terms: number[] };
  tca?: { model: 'linear' | 'poly3'; terms: number[] };
  vig?: [number, number, number];
}

function lensfunReference(s: RefSetup) {
  const W = s.w - 1;
  const H = s.h - 1;
  const ns = Math.hypot(36, 24) / s.cameraCrop / Math.hypot(W + 1, H + 1) / s.realFocal;
  const cx = (W / 2) * ns;
  const cy = (H / 2) * ns;
  const hs = s.realFocal / (Math.hypot(36, 24) / s.calibCrop / Math.hypot(s.aspect, 1) / 2);
  const hv = s.realFocal / (Math.hypot(36, 24) / s.calibCrop / 2);
  const distort = (x: number, y: number): [number, number] => {
    if (!s.dist) return [x, y];
    const [a = 0, b = 0, c = 0] = s.dist.terms;
    const r2 = x * x + y * y;
    let f: number;
    if (s.dist.model === 'ptlens') {
      const d = 1 - a - b - c;
      const r = Math.sqrt(r2);
      f = ((a * hs ** 3) / d ** 4) * r2 * r + ((b * hs ** 2) / d ** 3) * r2 + ((c * hs) / d ** 2) * r + 1;
    } else if (s.dist.model === 'poly3') {
      f = ((a * hs ** 2) / (1 - a) ** 3) * r2 + 1;
    } else {
      f = 1 + a * hs ** 2 * r2 + b * hs ** 4 * r2 * r2;
    }
    return [x * f, y * f];
  };
  const tca = (x: number, y: number, ch: 0 | 1 | 2): [number, number] => {
    if (!s.tca || ch === 1) return [x, y];
    const t = s.tca.terms;
    if (s.tca.model === 'linear') {
      const k = ch === 0 ? t[0]! : t[1]!;
      return [x * k, y * k];
    }
    const [v, c, b] = ch === 0 ? [t[0]!, t[2] ?? 0, t[4] ?? 0] : [t[1]!, t[3] ?? 0, t[5] ?? 0];
    const r2 = x * x + y * y;
    const p = b * hs * hs * r2 + c * hs * Math.sqrt(r2) + v;
    return [x * p, y * p];
  };
  return {
    source(px: number, py: number, ch: 0 | 1 | 2): [number, number] {
      const [dx, dy] = distort(px * ns - cx, py * ns - cy);
      const [tx, ty] = tca(dx, dy, ch);
      return [(tx + cx) / ns, (ty + cy) / ns];
    },
    gain(px: number, py: number): number {
      const [k1, k2, k3] = s.vig!;
      const x = px * ns - cx;
      const y = py * ns - cy;
      const r2 = x * x + y * y;
      return 1 / (1 + k1 * hv ** 2 * r2 + k2 * hv ** 4 * r2 * r2 + k3 * hv ** 6 * r2 ** 3);
    },
  };
}

/** Largest pixel distance between our model and the reference over a grid and the corners. */
function maxError(setup: RefSetup, corr: ReturnType<typeof lensfunToCorrection>, channels: (0 | 1 | 2)[]): number {
  const ref = lensfunReference(setup);
  let worst = 0;
  for (let j = 0; j <= 16; j++) {
    for (let i = 0; i <= 24; i++) {
      const px = (i / 24) * (setup.w - 1);
      const py = (j / 16) * (setup.h - 1);
      for (const ch of channels) {
        const [rx, ry] = ref.source(px, py, ch);
        const [sx, sy] = sourcePoint(corr!, (px + 0.5) / setup.w, (py + 0.5) / setup.h, ch);
        worst = Math.max(worst, Math.hypot(sx * setup.w - 0.5 - rx, sy * setup.h - 0.5 - ry));
      }
    }
  }
  return worst;
}

describe('conversion to LensCorrection matches Lensfun', () => {
  it('ptlens + poly3 TCA: green exact, red/blue fitted within 0.05 px at 8000 px', () => {
    const [a, b, c] = [0.018761658, -0.094537706, 0.061490311];
    const tcaTerms = [1.0001816, 1.0000015, -0.0003122, 0.0003122, 0.0001813, -0.0001813];
    const lens = lensOf({ dm: 'ptlens', d: [[28, a, b, c]], tm: 'poly3', tc: [[28, ...tcaTerms]] });
    const setup: RefSetup = {
      w: 8000,
      h: 5333,
      cameraCrop: 1,
      calibCrop: 1,
      aspect: 1.5,
      realFocal: 28 * (1 - a - b - c),
      dist: { model: 'ptlens', terms: [a, b, c] },
      tca: { model: 'poly3', terms: tcaTerms },
    };
    const corr = lensfunToCorrection(lens, 1, { focal: 28, aperture: 0, width: 8000, height: 5333 });
    expect(corr!.geometry!.scale[0]).toBeCloseTo(8000 / (Math.hypot(8000, 5333) / 2), 12);
    expect(maxError(setup, corr, [1])).toBeLessThan(1e-6);
    expect(maxError(setup, corr, [0, 2])).toBeLessThan(0.05);

    // Also along the diagonal beyond the corner, where auto-scale < 1 can sample.
    const ref = lensfunReference(setup);
    const zoom = autoScale(corr!);
    let worst = 0;
    for (let i = 0; i <= 400; i++) {
      const t = (i / 400) * 0.5 * Math.max(1, 1 / zoom);
      const px = (0.5 + t) * 8000 - 0.5;
      const py = (0.5 + t) * 5333 - 0.5;
      for (const ch of [0, 2] as const) {
        const [rx, ry] = ref.source(px, py, ch);
        const [sx, sy] = sourcePoint(corr!, 0.5 + t, 0.5 + t, ch);
        worst = Math.max(worst, Math.hypot(sx * 8000 - 0.5 - rx, sy * 5333 - 0.5 - ry));
      }
    }
    expect(worst).toBeLessThan(0.05);
  });

  it('poly3 + linear TCA, full-frame calibration on an APS-C camera: exact', () => {
    const lens = lensOf({ dm: 'poly3', d: [[35, -0.02]], tm: 'linear', tc: [[35, 1.0003, 0.9997]] });
    const setup: RefSetup = {
      w: 6000,
      h: 4000,
      cameraCrop: 1.534,
      calibCrop: 1,
      aspect: 1.5,
      realFocal: 35 * 1.02,
      dist: { model: 'poly3', terms: [-0.02] },
      tca: { model: 'linear', terms: [1.0003, 0.9997] },
    };
    const corr = lensfunToCorrection(lens, 1.534, { focal: 35, aperture: 0, width: 6000, height: 4000 });
    expect(maxError(setup, corr, [0, 1, 2])).toBeLessThan(1e-6);
  });

  it('poly5 with a 4:3 calibration on a 4:3 image: exact', () => {
    const lens = lensOf({ c: 2, ar: 4 / 3, dm: 'poly5', d: [[12, 0.01, -0.005]] });
    const setup: RefSetup = {
      w: 5184,
      h: 3888,
      cameraCrop: 2,
      calibCrop: 2,
      aspect: 4 / 3,
      realFocal: 12,
      dist: { model: 'poly5', terms: [0.01, -0.005] },
    };
    const corr = lensfunToCorrection(lens, 2, { focal: 12, aperture: 0, width: 5184, height: 3888 });
    expect(maxError(setup, corr, [0, 1, 2])).toBeLessThan(1e-6);
  });

  it('pa vignetting: same gain as ModifyColor_DeVignetting_PA', () => {
    const k: [number, number, number] = [-0.7899402, -0.0385421, 0.2171542];
    const lens = lensOf({ c: 1.529, v: [[18, 2.8, 1000, ...k]] });
    const setup: RefSetup = { w: 7752, h: 5178, cameraCrop: 1.534, calibCrop: 1.529, aspect: 1.5, realFocal: 18, vig: k };
    const corr = lensfunToCorrection(lens, 1.534, { focal: 18, aperture: 2.8, distance: 1000, width: 7752, height: 5178 })!;
    expect(corr.vignetting!.mode).toBe('divide');
    const ref = lensfunReference(setup);
    for (const [px, py] of [[0, 0], [3875.5, 2588.5], [7751, 5177], [1000, 4000], [7751, 2588.5]] as const) {
      expect(vignetteGain(corr, (px + 0.5) / 7752, (py + 0.5) / 5178)).toBeCloseTo(ref.gain(px, py), 12);
    }
    // Corner of a full-frame image of the calibration: g = 1 + k1 + k2 + k3.
    const ff = lensfunToCorrection(lens, 1.529, { focal: 18, aperture: 2.8, distance: 1000, width: 3000, height: 2000 })!;
    expect(1 / vignetteGain(ff, 0, 0)).toBeCloseTo(1 + k[0] + k[1] + k[2], 12);
  });

  it('skips the geometry of non-rectilinear lenses but keeps vignetting', () => {
    const lens = lensOf({ t: 'fisheye', dm: 'poly3', d: [[8, 0.1]], v: [[8, 4, 1000, -0.5, 0, 0]] });
    const corr = lensfunToCorrection(lens, 1, { focal: 8, aperture: 4, width: 600, height: 400 })!;
    expect(corr.geometry).toBeNull();
    expect(corr.vignetting).not.toBeNull();
  });

  it('every poly3 TCA fit in the database stays within 0.05 px at 8000 px', () => {
    const N = Math.hypot(8000, 5333) / 2;
    let worst = 0;
    let count = 0;
    for (const lens of db.lenses) {
      if (lens.type !== 'rectilinear' || lens.tca[0]?.model !== 'poly3') continue;
      for (const focal of new Set(lens.tca.map((t) => t.focal))) {
        const [vr, vb, cr, cb, br, bb] = interpolateTca(lens, lens.cropFactor, focal)!.terms;
        if (!cr && !cb && !br && !bb) continue;
        const corr = lensfunToCorrection(lens, lens.cropFactor, { focal, aperture: 0, width: 8000, height: 5333 })!;
        const [red, green, blue] = corr.geometry!.poly;
        const rho = Math.hypot(lens.aspectRatio, 1);
        const at = (p: number[], r: number) => r * p.reduceRight((s, c) => s * r + c, 0);
        // Visible radii: up to where the green source reaches the corner, or folds back.
        let prev = 0;
        for (let i = 1; i <= 600; i++) {
          const r = i / 200;
          const rd = at(green, r);
          if (r > 1 && (rd > 1 || rd <= prev)) break;
          prev = rd;
          for (const [p, v, c, b] of [[red, vr, cr, br], [blue, vb, cb, bb]] as const) {
            const exact = rd * (v + c * rho * rd + b * rho * rho * rd * rd);
            worst = Math.max(worst, Math.abs(at(p, r) - exact) * N);
          }
        }
        count++;
      }
    }
    expect(count).toBeGreaterThan(1000);
    expect(worst).toBeLessThan(0.05);
  });
});

describe('matching real photos against the database', () => {
  const photo = (cameraMake: string, cameraModel: string, lens: string, focalLength: number, aperture: number) => ({
    cameraMake,
    cameraModel,
    lens,
    focalLength,
    aperture,
    width: 6000,
    height: 4000,
  });

  it('Sony ILCE-7RM5 + Sony FE 50mm F1.2 GM (maker in the EXIF name)', () => {
    const r = lensfunCorrection(db, photo('SONY', 'ILCE-7RM5', 'Sony FE 50mm F1.2 GM', 50, 1.2))!;
    expect(r.camera).toBe('Sony ILCE-7RM5');
    expect(r.lens).toBe('Sony FE 50mm f/1.2 GM');
    expect(r.method).toBe('name');
    expect(r.correction.geometry).not.toBeNull();
    // Lensfun has distortion and TCA for this lens, no vignetting.
    expect(r.correction.vignetting).toBeNull();
    // Without the maker it is a plain Lensfun match.
    expect(findLens(db, findCamera(db, 'Sony', 'ILCE-7RM5')!.camera, 'FE 50mm F1.2 GM', 50)!.lens.id).toBe(r.lensId);
  });

  it('Fujifilm X-T5 + XF18mm F2 R (via the "XF 18mm f/2 R" translation)', () => {
    const r = lensfunCorrection(db, photo('FUJIFILM', 'X-T5', 'XF18mm F2 R', 18, 2.8))!;
    expect(r.camera).toBe('Fujifilm X-T5');
    expect(r.lens).toBe('Fujifilm XF18mmF2 R');
    expect(r.method).toBe('name');
    expect(r.correction.geometry).not.toBeNull();
    expect(r.correction.vignetting).not.toBeNull();
  });

  it('Canon EOS R5 + Sigma 50mm f/1.4 DG HSM | A (EF lens through the RF adapter)', () => {
    const cam = findCamera(db, 'Canon', 'Canon EOS R5')!;
    expect(cam.camera.mount).toBe('Canon RF');
    const m = findLens(db, cam.camera, 'Sigma 50mm f/1.4 DG HSM | A', 50)!;
    expect(lensDisplayName(m.lens)).toBe('Sigma 50mm f/1.4 DG HSM [A]');
    expect(m.lens.mounts).toContain('Canon EF');
    expect(m.lens.mounts).not.toContain('Canon RF');
    const r = lensfunCorrection(db, photo('Canon', 'Canon EOS R5', 'Sigma 50mm f/1.4 DG HSM | A', 50, 5.6))!;
    expect(r.lens).toBe('Sigma 50mm f/1.4 DG HSM [A]');
    expect(r.correction.vignetting).not.toBeNull();
  });

  it('Leica Q2 + "28.0mm f/1.7": the fixed lens, found by its mount', () => {
    const cam = findCamera(db, 'LEICA CAMERA AG', 'LEICA Q2')!;
    expect(cam.camera.fixedLens).toBe(true);
    const r = lensfunCorrection(db, photo('LEICA CAMERA AG', 'LEICA Q2', '28.0mm f/1.7', 28, 6.3))!;
    expect(r.camera).toBe('Leica Q2');
    expect(r.lens).toBe('LEICA Q2 & compatibles');
    expect(r.method).toBe('fixed-lens');
    expect(r.correction.geometry).not.toBeNull();
    expect(r.correction.vignetting).not.toBeNull();
  });

  it('Nikon Z 7 + NIKKOR Z 24-70mm f/4 S at 56 mm, also with LibRaw-style names', () => {
    const r = lensfunCorrection(db, photo('NIKON CORPORATION', 'NIKON Z 7', 'NIKKOR Z 24-70mm f/4 S', 56, 5.6))!;
    expect(r.camera).toBe('Nikon Z 7');
    expect(r.lens).toBe('Nikon Nikkor Z 24-70mm f/4 S');
    expect(r.method).toBe('name');
    // crop 5 + focal/aperture 30 + mount 10 + name 100 · 0.4
    expect(r.score).toBe(85);
    expect(findCamera(db, 'Nikon', 'Z 7')!.camera).toBe(findCamera(db, 'NIKON CORPORATION', 'NIKON Z 7')!.camera);
  });

  it('a forced lens id is used as is', () => {
    const r = lensfunCorrection(db, photo('Canon', 'Canon EOS R5', 'something unknown', 50, 4), { lens: 'Sigma/Sigma 50mm f/1.4 DG HSM [A]' })!;
    expect(r.method).toBe('manual');
    expect(r.lens).toBe('Sigma 50mm f/1.4 DG HSM [A]');
    expect(lensfunCorrection(db, photo('Canon', 'Canon EOS R5', 'something unknown', 50, 4))).toBeNull();
  });

  it('searchLenses offers candidates for a manual choice', () => {
    const cam = findCamera(db, 'Canon', 'Canon EOS R5')!.camera;
    const names = searchLenses(db, cam, 'sig 50 1.4').map((m) => lensDisplayName(m.lens));
    expect(names).toContain('Sigma 50mm f/1.4 DG HSM [A]');
    expect(names.every((n) => /sigma/i.test(n) && /50/.test(n))).toBe(true);
    // Everything compatible with the camera when nothing is typed, including adapted EF lenses.
    const all = searchLenses(db, cam, '', 5000);
    expect(all.length).toBeGreaterThan(200);
    expect(all.some((m) => m.lens.mounts.includes('Canon EF'))).toBe(true);
    expect(all.some((m) => m.lens.mounts.every((x) => x === 'Nikon Z'))).toBe(false);
  });
});
