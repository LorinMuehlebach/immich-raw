import { defaultRecipe, normalizeRecipe, type TransformParams } from '@immich-raw/recipe';
import { describe, expect, it } from 'vitest';
import { applyAffine, editFrame, invertAffine, mulAffine, orientAffine, transformMatrix, uprightMatrix, uprightSize, type Affine, type QuarterTurns } from './geometry.ts';
import { focalFromGuides, rotationHomography, solveUpright, turnDegrees, type Rot3, type Segment } from './upright.ts';

const rad = (d: number) => (d * Math.PI) / 180;
const rotX = (a: number): Rot3 => [1, 0, 0, 0, Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a)];
const rotY = (a: number): Rot3 => [Math.cos(a), 0, Math.sin(a), 0, 1, 0, -Math.sin(a), 0, Math.cos(a)];
const rotZ = (a: number): Rot3 => [Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a), 0, 0, 0, 1];
const mul3 = (a: Rot3, b: Rot3) => mulAffine(a as Affine, b as Affine) as Rot3;

/** The photo of straight lines taken with the camera turned by `turn`: lines -> as photographed. */
const photographed = (turn: Rot3, f: number) => invertAffine(rotationHomography(turn, f));
const map = (h: Affine, s: Segment): Segment => [applyAffine(h, ...s[0]), applyAffine(h, ...s[1])];
/** Degrees off vertical (or off horizontal). */
const offVertical = (s: Segment) => Math.abs((Math.atan2(s[1][0] - s[0][0], s[1][1] - s[0][1]) * 180) / Math.PI) % 180;
const offHorizontal = (s: Segment) => {
  const a = Math.abs((Math.atan2(s[1][1] - s[0][1], s[1][0] - s[0][0]) * 180) / Math.PI) % 180;
  return Math.min(a, 180 - a);
};

const VERTICALS: Segment[] = [
  [[-0.5, -0.4], [-0.5, 0.4]],
  [[0.45, -0.3], [0.45, 0.5]],
];
const HORIZONTALS: Segment[] = [
  [[-0.6, -0.35], [0.5, -0.35]],
  [[-0.5, 0.4], [0.6, 0.4]],
];

/** Photographs the lines, solves, and returns the corrected lines. */
function roundTrip(turn: Rot3, f: number, lines: Segment[], fGuess = f) {
  const shot = lines.map((s) => map(photographed(turn, f), s));
  const solved = solveUpright(shot, fGuess);
  expect(solved).not.toBeNull();
  const fix = rotationHomography(solved!.rot, solved!.f);
  return { fixed: shot.map((s) => map(fix, s)), solved: solved! };
}

describe('solveUpright', () => {
  it('two verticals of a camera tilted up 15°: vertical again', () => {
    const { fixed } = roundTrip(rotX(rad(15)), 1.2, VERTICALS);
    for (const s of fixed) expect(offVertical(s)).toBeLessThan(0.05);
  });

  it('two verticals and a horizontal, camera tilted and turned: both fixed', () => {
    const turn = mul3(rotY(rad(12)), rotX(rad(-10)));
    const { fixed } = roundTrip(turn, 1.5, [...VERTICALS, HORIZONTALS[0]!]);
    expect(offVertical(fixed[0]!)).toBeLessThan(0.05);
    expect(offVertical(fixed[1]!)).toBeLessThan(0.05);
    expect(offHorizontal(fixed[2]!)).toBeLessThan(0.05);
  });

  it('two horizontals (and a vertical)', () => {
    const turn = mul3(rotX(rad(8)), rotY(rad(14)));
    const { fixed } = roundTrip(turn, 1.4, [...HORIZONTALS, VERTICALS[0]!]);
    expect(offHorizontal(fixed[0]!)).toBeLessThan(0.05);
    expect(offHorizontal(fixed[1]!)).toBeLessThan(0.05);
    expect(offVertical(fixed[2]!)).toBeLessThan(0.05);
  });

  it('two of each: the focal length is measured from them, and all four are fixed', () => {
    const turn = mul3(rotZ(rad(3)), mul3(rotY(rad(18)), rotX(rad(14))));
    const { fixed, solved } = roundTrip(turn, 1.3, [...VERTICALS, ...HORIZONTALS], 2.5);
    expect(solved.f).toBeCloseTo(1.3, 3);
    for (const s of fixed.slice(0, 2)) expect(offVertical(s)).toBeLessThan(0.05);
    for (const s of fixed.slice(2)) expect(offHorizontal(s)).toBeLessThan(0.05);
  });

  it('the turn undoes the camera turn', () => {
    const turn = rotX(rad(15));
    const { solved } = roundTrip(turn, 1.2, VERTICALS);
    expect(turnDegrees(solved.rot)).toBeCloseTo(15, 3);
  });

  it('one slanted guide: only turned in the image plane', () => {
    const s: Segment = [[0.1, -0.5], [0.1 + Math.tan(rad(3)), 0.5]];
    const solved = solveUpright([s], 1.2)!;
    const fixed = map(rotationHomography(solved.rot, solved.f), s);
    expect(offVertical(fixed)).toBeLessThan(1e-6);
    expect(turnDegrees(solved.rot)).toBeCloseTo(3, 6);
  });

  it('no guides, or a turn too large to be meant: null', () => {
    expect(solveUpright([], 1)).toBeNull();
    // Verticals that meet just above the frame: a 70° tilt.
    expect(solveUpright([[[-0.5, 1], [0, -0.5]], [[0.5, 1], [0, -0.5]]], 1.2)).toBeNull();
  });

  it('focalFromGuides: none for parallel lines', () => {
    expect(focalFromGuides([VERTICALS[0]!, VERTICALS[1]!], [HORIZONTALS[0]!, HORIZONTALS[1]!])).toBeNull();
  });
});

describe('uprightMatrix in the edit frame', () => {
  const W = 6000;
  const H = 4000;
  /** Guides in the mask frame from segments in upright normalised coordinates. */
  function toMask(q: QuarterTurns, segs: [number, number, number, number][]): [number, number, number, number][] {
    const m = Math.max(W, H);
    const o = orientAffine(q);
    return segs.map(([x0, y0, x1, y1]) => {
      const a = applyAffine(o, x0, y0);
      const b = applyAffine(o, x1, y1);
      return [(a[0] * W) / m, (a[1] * H) / m, (b[0] * W) / m, (b[1] * H) / m];
    });
  }
  /** Converging verticals as photographed, in upright normalised coordinates (q = 0). */
  const leaning: [number, number, number, number][] = [
    [0.2, 0.1, 0.25, 0.9],
    [0.8, 0.1, 0.75, 0.9],
  ];
  const t = (o: Partial<TransformParams>, guides: [number, number, number, number][]): TransformParams => ({
    ...defaultRecipe().transform,
    ...o,
    upright: { guides, focal35: 35 },
  });
  const angleOff = (m: Affine, [x0, y0, x1, y1]: [number, number, number, number], Wu: number, Hu: number) => {
    const a = applyAffine(m, x0, y0);
    const b = applyAffine(m, x1, y1);
    return Math.abs((Math.atan2((b[0] - a[0]) * Wu, (b[1] - a[1]) * Hu) * 180) / Math.PI);
  };

  it('makes converging guides vertical on the upright image', () => {
    const tr = t({}, toMask(0, leaning));
    const U = uprightMatrix(tr, 0, W, H)!;
    expect(U).not.toBeNull();
    for (const g of leaning) expect(angleOff(transformMatrix(tr, W, H, U), g, W, H)).toBeLessThan(0.05);
  });

  it('the guides stay on the content when the photo is turned a quarter', () => {
    // The same guides, in the mask frame; the photo now shows turned (q = 1).
    const guides = toMask(0, leaning);
    const tr = t({}, guides);
    const { w: Wu, h: Hu } = uprightSize(W, H, 1);
    const U = uprightMatrix(tr, 1, W, H)!;
    const m = Math.max(W, H);
    const sToU = invertAffine(orientAffine(1));
    for (const [x0, y0, x1, y1] of guides) {
      const a = applyAffine(sToU, (x0 * m) / W, (y0 * m) / H);
      const b = applyAffine(sToU, (x1 * m) / W, (y1 * m) / H);
      // Turned with the photo they are horizontal there, and Upright makes them exactly so.
      const pa = applyAffine(U, ...a);
      const pb = applyAffine(U, ...b);
      expect(Math.abs((Math.atan2((pb[1] - pa[1]) * Hu, (pb[0] - pa[0]) * Wu) * 180) / Math.PI) % 180).toBeLessThan(0.05);
    }
  });

  it('the sliders apply on top: Rotate turns the straightened guides', () => {
    const tr = t({ rotate: 5 }, toMask(0, leaning));
    const M = transformMatrix(tr, W, H, uprightMatrix(tr, 0, W, H));
    for (const g of leaning) expect(angleOff(M, g, W, H)).toBeCloseTo(5, 1);
  });

  it('editFrame uses it: a point on a guide maps back onto the guide', () => {
    const tr = t({}, toMask(0, leaning));
    const f = editFrame(defaultRecipe().crop, 0, W, H, tr);
    const U = uprightMatrix(tr, 0, W, H)!;
    // The guide's midpoint, after the correction, is shown somewhere in the frame; the frame maps
    // that position back to the midpoint in the source.
    const mid = [0.225, 0.5] as [number, number];
    const shown = applyAffine(U, ...mid);
    const back = applyAffine(f.tToS, ...shown);
    expect(back[0]).toBeCloseTo(mid[0], 6);
    expect(back[1]).toBeCloseTo(mid[1], 6);
  });

  it('stored and read back through normalizeRecipe', () => {
    const r = defaultRecipe();
    // Stored with 5 decimals, like masks.
    const guides = toMask(0, leaning).map((g) => g.map((v) => Math.round(v * 1e5) / 1e5) as [number, number, number, number]);
    r.transform.upright = { guides, focal35: 35 };
    const n = normalizeRecipe(JSON.parse(JSON.stringify(r)));
    expect(n.transform.upright).toEqual(r.transform.upright);
    expect(normalizeRecipe(JSON.parse(JSON.stringify(defaultRecipe()))).transform.upright).toBeUndefined();
  });
});
