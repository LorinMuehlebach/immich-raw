import { describe, expect, it } from 'vitest';
import {
  HdrMerger,
  alignMtb,
  clipLevels,
  exifExposure,
  exposureRatio,
  ghostMap,
  greenPlane,
  mtbCodesOf,
  nativeScale,
  refineShift,
  type MergeFrame,
  type Rgb16,
  type Shift,
  type Vec3,
} from './merge.ts';

const W = 320;
const H = 240;
const MUL = [2, 1, 1.5, 1];
const K = nativeScale(MUL);
const CLIP = 65535;

/** Deterministic pseudo-random value in 0..1 for a cell. */
function hash(x: number, y: number): number {
  const h = Math.imul(x * 73856093 ^ y * 19349663, 0x9e3779b1) >>> 0;
  return (h & 0xffff) / 0xffff;
}

/**
 * Scene radiance in reference-native units: blocks of random brightness over ~12 stops, from
 * deep shadow to ~10x the reference's clip level, brighter to the right, slightly different
 * per channel. (A smooth ramp alone would be a poor test of alignment: each frame's median
 * would depend on how it is framed.)
 */
function radiance(x: number, y: number, c: number): number {
  const level = -9.5 + 8 * hash(Math.floor(x / 6), Math.floor(y / 6)) + (4.8 * x) / W;
  return CLIP * 2 ** level * [0.9, 1, 0.8][c]!;
}

/** A frame at relative exposure `e`, showing reference pixel (x, y) at (x + dx, y + dy). */
function frame(e: number, s: Shift, scene = radiance): Rgb16 {
  const data = new Uint16Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      for (let c = 0; c < 3; c++) {
        const native = Math.min(CLIP, scene(x - s.dx, y - s.dy, c) * e);
        data[(y * W + x) * 3 + c] = Math.round(native / K[c]!);
      }
    }
  }
  return { width: W, height: H, data };
}

function mergeFrame(img: Rgb16, exposure: number, shift: Shift): MergeFrame {
  return { image: img, k: K, exposure, clip: clipLevels(img, K), shift, ghost: null };
}

describe('nativeScale', () => {
  it('undoes the white balance LibRaw applied (channel c scaled by mul_c / max)', () => {
    expect(K).toEqual([1, 2, 2 / 1.5]);
  });
});

describe('exifExposure', () => {
  it('is time x ISO / f-number squared, and null without a shutter speed', () => {
    expect(exifExposure({ shutter: 1 / 100, aperture: 4, iso: 200 })).toBeCloseTo(0.125);
    expect(exifExposure({ shutter: 1 / 25, aperture: 4, iso: 200 })! / exifExposure({ shutter: 1 / 100, aperture: 4, iso: 200 })!).toBeCloseTo(4);
    expect(exifExposure({ shutter: 0, aperture: 4, iso: 200 })).toBeNull();
  });
});

describe('alignment', () => {
  it('finds the shift between differently exposed frames', () => {
    const ref = frame(1, { dx: 0, dy: 0 });
    for (const [e, s] of [
      [0.25, { dx: 5, dy: -3 }],
      [4, { dx: -11, dy: 7 }],
    ] as const) {
      const img = frame(e, s);
      expect(alignMtb(greenPlane(ref, K), greenPlane(img, K), W, H, 32)).toEqual(s);
    }
  });

  it('refines a guess that is one pixel off, against the previous frame', () => {
    const prevShift = { dx: 4, dy: 2 };
    const prev = frame(4, prevShift);
    const cur = frame(1, { dx: -3, dy: 5 });
    const found = refineShift(mtbCodesOf(prev, K), prevShift, mtbCodesOf(cur, K), W, H, { dx: -2, dy: 4 });
    expect(found).toEqual({ dx: -3, dy: 5 });
  });
});

describe('exposureRatio', () => {
  it('measures the exposure step from pixels both frames exposed well', () => {
    const a = frame(0.25, { dx: 0, dy: 0 });
    const b = frame(1, { dx: 3, dy: 1 });
    const r = exposureRatio(greenPlane(a, K), greenPlane(b, K), W, H, { dx: 0, dy: 0 }, { dx: 3, dy: 1 }, CLIP, CLIP);
    expect(r).not.toBeNull();
    expect(Math.log2(r!)).toBeCloseTo(2, 1);
  });

  it('gives up when the frames share too few well exposed pixels', () => {
    const black = { width: W, height: H, data: new Uint16Array(W * H * 3) };
    expect(exposureRatio(greenPlane(black, K), greenPlane(frame(1, { dx: 0, dy: 0 }), K), W, H, { dx: 0, dy: 0 }, { dx: 0, dy: 0 }, CLIP, CLIP)).toBeNull();
  });
});

/** Merges -2 / 0 / +2 EV frames (brightest first) and returns the output with its scale. */
async function mergeThree(shifts: [Shift, Shift, Shift], ghost?: { frame: 0 | 2; map: MergeFrame['ghost'] }, scenes?: (typeof radiance)[]) {
  const exps = [4, 1, 0.25];
  const frames = exps.map((e, i) => mergeFrame(frame(e, shifts[i]!, scenes?.[i] ?? radiance), e, shifts[i]!));
  if (ghost) frames[ghost.frame]!.ghost = ghost.map;
  const darkest = frames[2]!;
  const scale = (0.999 * CLIP) / (Math.max(...darkest.clip) / darkest.exposure);
  const m = new HdrMerger(W, H, scale);
  for (let i = 0; i < 3; i++) await m.add(frames[i]!, i === 2);
  return { out: m.out, scale };
}

describe('HdrMerger', () => {
  it('reconstructs the scene from the shadows to 3 stops over the reference clip', async () => {
    const shifts: [Shift, Shift, Shift] = [
      { dx: -4, dy: 2 },
      { dx: 0, dy: 0 },
      { dx: 3, dy: -1 },
    ];
    const { out, scale } = await mergeThree(shifts);
    let worst = 0;
    for (let y = 20; y < H - 20; y += 3) {
      for (let x = 20; x < W - 20; x += 3) {
        for (let c = 0; c < 3; c++) {
          const want = radiance(x, y, c) * scale;
          if (want > 0.99 * CLIP) continue; // clipped even in the darkest frame
          const got = out[(y * W + x) * 3 + c]!;
          // Rounding of a frame's 16-bit values, scaled down by up to 16x, costs ~1 output unit.
          worst = Math.max(worst, Math.abs(got - want) / (want + 30));
        }
      }
    }
    expect(worst).toBeLessThan(0.03);
  });

  it('uses the brightest frame where it is not clipped (least noise)', async () => {
    // A scene only the brightest frame resolves: 4x exposure lifts it 2 stops above the others.
    const dim = (x: number, y: number, c: number) => (x < W / 2 ? 40 + 3 * c + (x & 1) : radiance(x, y, c));
    const zero = { dx: 0, dy: 0 };
    const { out, scale } = await mergeThree([zero, zero, zero], undefined, [dim, dim, dim]);
    // The brightest frame stores 160 (x4), giving 160 / 4 * scale: exact to the 16-bit step.
    const got = out[(100 * W + 10) * 3 + 1]!;
    expect(Math.abs(got - 43 * scale)).toBeLessThanOrEqual(1);
  });

  it('lets the reference show where another frame saw something move', async () => {
    const zero = { dx: 0, dy: 0 };
    // In the brightest frame a dark object stands in the middle; the others don't show it.
    const moved = (x: number, y: number, c: number) => (x > 120 && x < 180 && y > 90 && y < 150 ? radiance(x, y, c) / 8 : radiance(x, y, c));
    const ref = frame(1, zero);
    const bright = frame(4, zero, moved);
    const g = ghostMap(greenPlane(ref, K), greenPlane(bright, K), W, H, zero, 4, CLIP, CLIP, 0.6, 16);
    const plain = await mergeThree([zero, zero, zero], undefined, [moved, radiance, radiance]);
    const fixed = await mergeThree([zero, zero, zero], { frame: 0, map: g }, [moved, radiance, radiance]);
    const at = (o: Uint16Array) => o[(120 * W + 150) * 3 + 1]!;
    const want = radiance(150, 120, 1) * plain.scale;
    expect(at(plain.out) / want).toBeLessThan(0.3); // the ghost
    expect(at(fixed.out) / want).toBeGreaterThan(0.9);
    expect(at(fixed.out) / want).toBeLessThan(1.1);
  });

  it('rejects frames of another size', async () => {
    const m = new HdrMerger(W, H, 1);
    const small: Rgb16 = { width: 10, height: 10, data: new Uint16Array(300) };
    const f: MergeFrame = { image: small, k: K, exposure: 1, clip: [1, 1, 1] as Vec3, shift: { dx: 0, dy: 0 }, ghost: null };
    await expect(m.add(f, true)).rejects.toThrow(/differ in size/);
  });
});
