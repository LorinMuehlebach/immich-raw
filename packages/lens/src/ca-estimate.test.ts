import { describe, expect, it } from 'vitest';
import { estimateLateralCA, type CaImage } from './ca-estimate.ts';
import type { LensCorrection, RadialPoly } from './types.ts';

/** Lateral CA of one channel against green: r_c = r·(1 + a + b·r²), then a shift (tx, ty) in px. */
interface Ca {
  a: number;
  b: number;
  tx?: number;
  ty?: number;
}

interface Scene {
  width: number;
  height: number;
  red: Ca;
  blue: Ca;
  /** Shot-noise gain (variance = gain·value + read²) and read noise, in 16-bit units. */
  gain?: number;
  read?: number;
  /** Per-channel clipping level. */
  clip?: [number, number, number];
  /** Share of shapes far brighter than the clipping level, drawn with a wider blur. */
  blown?: number;
  /** Shapes in the scene; false renders a flat grey frame. */
  shapes?: boolean;
  seed?: number;
}

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CELL = 36;

interface Shape {
  x: number;
  y: number;
  /** Disc radius or half the side of a square. */
  size: number;
  square: boolean;
  cos: number;
  sin: number;
  fg: [number, number, number];
  /** Edge width (logistic scale), px. */
  soft: number;
}

/**
 * Renders a grid of discs and rotated squares, one per 36 px cell, with smooth edges that are
 * evaluated analytically per channel, so red and blue are exact sub-pixel warps of green.
 */
function render(sc: Scene): CaImage {
  const { width: w, height: h } = sc;
  const rnd = mulberry32(sc.seed ?? 1);
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const n = Math.hypot(w, h) / 2;
  const gx = Math.ceil(w / CELL) + 2;
  const gy = Math.ceil(h / CELL) + 2;
  const shapes: Shape[] = [];
  for (let j = 0; j < gy; j++) {
    for (let i = 0; i < gx; i++) {
      const blown = rnd() < (sc.blown ?? 0);
      const v = 12000 + rnd() * 38000;
      const angle = rnd() * Math.PI;
      shapes.push({
        x: (i - 1 + 0.5) * CELL + (rnd() - 0.5) * 8,
        y: (j - 1 + 0.5) * CELL + (rnd() - 0.5) * 8,
        size: 6 + rnd() * 5,
        square: rnd() < 0.5,
        cos: Math.cos(angle),
        sin: Math.sin(angle),
        fg: blown ? [180000, 200000, 190000] : [v * (0.55 + 0.45 * rnd()), v, v * (0.6 + 0.4 * rnd())],
        soft: blown ? 1.5 : 0.45,
      });
    }
  }
  const bg = [2500, 4000, 3200];
  const scene = (ch: number, x: number, y: number): number => {
    if (sc.shapes === false) return bg[ch]!;
    const i = Math.floor(x / CELL) + 1;
    const j = Math.floor(y / CELL) + 1;
    const s = shapes[j * gx + i];
    if (!s) return bg[ch]!;
    const lx = (x - s.x) * s.cos + (y - s.y) * s.sin;
    const ly = (y - s.y) * s.cos - (x - s.x) * s.sin;
    let dist: number;
    if (s.square) {
      const ex = Math.abs(lx) - s.size;
      const ey = Math.abs(ly) - s.size;
      dist = Math.hypot(Math.max(ex, 0), Math.max(ey, 0)) + Math.min(Math.max(ex, ey), 0);
    } else {
      dist = Math.hypot(lx, ly) - s.size;
    }
    const cover = 1 / (1 + Math.exp(dist / s.soft));
    return bg[ch]! + (s.fg[ch]! - bg[ch]!) * cover;
  };

  // Where the scene point recorded at (x, y) by a channel with CA `ca` sits in green.
  const toScene = (ca: Ca, x: number, y: number): [number, number] => {
    const px = x - cx - (ca.tx ?? 0);
    const py = y - cy - (ca.ty ?? 0);
    const rho = Math.hypot(px, py) / n;
    if (rho === 0) return [cx, cy];
    let r = rho / (1 + ca.a + ca.b * rho * rho);
    for (let k = 0; k < 3; k++) {
      const f = r * (1 + ca.a + ca.b * r * r) - rho;
      r -= f / (1 + ca.a + 3 * ca.b * r * r);
    }
    return [cx + (px * r) / rho, cy + (py * r) / rho];
  };

  const clip = sc.clip ?? [65535, 65535, 65535];
  const gain = sc.gain ?? 2;
  const read = sc.read ?? 20;
  const data = new Uint16Array(w * h * 3);
  let spare = NaN;
  const gauss = () => {
    if (!Number.isNaN(spare)) {
      const s = spare;
      spare = NaN;
      return s;
    }
    const u = Math.max(1e-12, rnd());
    const v = rnd();
    const m = Math.sqrt(-2 * Math.log(u));
    spare = m * Math.sin(2 * Math.PI * v);
    return m * Math.cos(2 * Math.PI * v);
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let ch = 0; ch < 3; ch++) {
        const [sx, sy] = ch === 1 ? [x, y] : toScene(ch === 0 ? sc.red : sc.blue, x, y);
        const v = scene(ch, sx, sy);
        const noisy = v + gauss() * Math.sqrt(gain * Math.min(v, 65535) + read * read);
        data[(y * w + x) * 3 + ch] = Math.round(Math.min(clip[ch]!, Math.max(0, noisy)));
      }
    }
  }
  return { width: w, height: h, data };
}

type Geometry = NonNullable<LensCorrection['geometry']>;

/** The renderer's mapping: where channel c of the ideal normalised point s is read from. */
function sourcePoint(g: Geometry, c: number, s: [number, number]): [number, number] {
  const dx = (s[0] - g.center[0]) * g.scale[0];
  const dy = (s[1] - g.center[1]) * g.scale[1];
  const r = Math.hypot(dx, dy);
  const poly = g.poly[c]!;
  let k = 0;
  for (let i = poly.length - 1; i >= 0; i--) k = k * r + poly[i]!;
  // r_src / r = Σ poly[i]·r^i
  return [g.center[0] + (s[0] - g.center[0]) * k, g.center[1] + (s[1] - g.center[1]) * k];
}

/** Re-samples red and blue through the correction, as the renderer would. */
function applyCorrection(img: CaImage, g: Geometry): CaImage {
  const { width: w, height: h, data } = img;
  const out = new Uint16Array(data.length);
  const sample = (ch: number, x: number, y: number) => {
    const xc = Math.min(w - 1.001, Math.max(0, x));
    const yc = Math.min(h - 1.001, Math.max(0, y));
    const x0 = Math.floor(xc);
    const y0 = Math.floor(yc);
    const fx = xc - x0;
    const fy = yc - y0;
    const at = (xx: number, yy: number) => data[(yy * w + xx) * 3 + ch]!;
    return (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s: [number, number] = [(x + 0.5) / w, (y + 0.5) / h];
      for (let ch = 0; ch < 3; ch++) {
        const [u, v] = sourcePoint(g, ch, s);
        out[(y * w + x) * 3 + ch] = Math.round(sample(ch, u * w - 0.5, v * h - 0.5));
      }
    }
  }
  return { width: w, height: h, data: out };
}

/**
 * Largest distance, in px, between where the correction reads channel c and where that
 * channel really recorded the scene point, over a grid of ideal points.
 */
function misalignment(g: Geometry, c: number, ca: Ca, w: number, h: number): number {
  const n = Math.hypot(w, h) / 2;
  let worst = 0;
  for (let j = 0; j <= 20; j++) {
    for (let i = 0; i <= 20; i++) {
      const s: [number, number] = [i / 20, j / 20];
      const [u, v] = sourcePoint(g, c, s);
      const dx = s[0] * w - w / 2;
      const dy = s[1] * h - h / 2;
      const r = Math.hypot(dx, dy) / n;
      const k = 1 + ca.a + ca.b * r * r;
      worst = Math.max(worst, Math.hypot(u * w - (w / 2 + dx * k), v * h - (h / 2 + dy * k)));
    }
  }
  return worst;
}

/** Largest gap in px between the fitted and the true shift curve over r in [r0, 1]. */
function curveError(poly: RadialPoly, ca: Ca, n: number, r0 = 0.3): number {
  let worst = 0;
  for (let r = r0; r <= 1.0001; r += 0.05) {
    let k = 0;
    for (let i = poly.length - 1; i >= 0; i--) k = k * r + poly[i]!;
    worst = Math.max(worst, Math.abs(r * k - r * (1 + ca.a + ca.b * r * r)) * n);
  }
  return worst;
}

const W = 2000;
const H = 1400;
const N = Math.hypot(W, H) / 2;
const RED: Ca = { a: 0.0006, b: 0 };
const BLUE: Ca = { a: -0.0005, b: 0 };

describe('estimateLateralCA', () => {
  const img = render({ width: W, height: H, red: RED, blue: BLUE });
  const est = estimateLateralCA(img);

  it('measures magnified red and shrunk blue with the right sign', () => {
    expect(est.samples).toBeGreaterThan(500);
    expect(est.confidence).toBeGreaterThan(0.8);
    expect(est.redShiftPx).toBeCloseTo(RED.a * N, 1);
    expect(est.blueShiftPx).toBeCloseTo(BLUE.a * N, 1);
    const c = est.correction!;
    expect(c.source).toBe('Chromatic aberration (measured)');
    expect(c.vignetting).toBeNull();
    const g = c.geometry!;
    expect(g.center).toEqual([0.5, 0.5]);
    expect(g.scale[0]).toBeCloseTo(W / N, 9);
    expect(g.scale[1]).toBeCloseTo(H / N, 9);
    expect(g.poly[1]).toEqual([1, 0, 0, 0, 0, 0, 0]);
    // Red magnified: read from a larger radius. Blue shrunk: from a smaller one.
    expect(g.poly[0][0]).toBeGreaterThan(1);
    expect(g.poly[2][0]).toBeLessThan(1);
    expect(curveError(g.poly[0], RED, N, 0)).toBeLessThan(0.05);
    expect(curveError(g.poly[2], BLUE, N, 0)).toBeLessThan(0.05);
  });

  it('re-aligns the channels through the renderer mapping', () => {
    const g = est.correction!.geometry!;
    expect(misalignment(g, 0, RED, W, H)).toBeLessThan(0.1);
    expect(misalignment(g, 2, BLUE, W, H)).toBeLessThan(0.1);
    expect(misalignment(g, 1, { a: 0, b: 0 }, W, H)).toBeLessThan(1e-9);
    // Measured again after correction, nothing is left to fix.
    const again = estimateLateralCA(applyCorrection(img, g));
    expect(Math.abs(again.redShiftPx)).toBeLessThan(0.1);
    expect(Math.abs(again.blueShiftPx)).toBeLessThan(0.1);
    expect(again.correction).toBeNull();
  });

  it('returns no correction when the channels already line up', () => {
    const r = estimateLateralCA(render({ width: W, height: H, red: { a: 0, b: 0 }, blue: { a: 0, b: 0 }, seed: 2 }));
    expect(r.correction).toBeNull();
    expect(Math.abs(r.redShiftPx)).toBeLessThan(0.05);
    expect(Math.abs(r.blueShiftPx)).toBeLessThan(0.05);
    expect(r.confidence).toBeGreaterThan(0.8);
  });

  it('fits a shift that grows faster than the radius', () => {
    const red: Ca = { a: 0.0002, b: 0.0007 };
    const blue: Ca = { a: -0.0003, b: 0.0004 };
    const r = estimateLateralCA(render({ width: W, height: H, red, blue, seed: 3 }));
    const g = r.correction!.geometry!;
    expect(g.poly[0][2]).toBeGreaterThan(0.0004);
    expect(curveError(g.poly[0], red, N)).toBeLessThan(0.06);
    expect(curveError(g.poly[2], blue, N)).toBeLessThan(0.06);
    expect(misalignment(g, 0, red, W, H)).toBeLessThan(0.1);
    expect(misalignment(g, 2, blue, W, H)).toBeLessThan(0.1);
  });

  it('stays accurate in heavy noise', () => {
    const r = estimateLateralCA(render({ width: W, height: H, red: RED, blue: BLUE, gain: 60, read: 300, seed: 4 }));
    expect(r.correction).not.toBeNull();
    expect(r.confidence).toBeGreaterThan(0.3);
    expect(r.redShiftPx).toBeCloseTo(RED.a * N, 1);
    expect(r.blueShiftPx).toBeCloseTo(BLUE.a * N, 1);
    expect(misalignment(r.correction!.geometry!, 0, RED, W, H)).toBeLessThan(0.1);
  });

  it('ignores edges of clipped highlights', () => {
    // Channels clip at different levels, as in a white-balanced decode. Half the shapes are
    // blown, with soft edges that look wider in the channel that clips first: measured, they
    // pull the red estimate about 0.13 px off, which the robust fit alone does not catch.
    const scene: Scene = { width: W, height: H, red: RED, blue: BLUE, clip: [36000, 65535, 52000], blown: 0.5, seed: 5 };
    const r = estimateLateralCA(render(scene));
    expect(r.samples).toBeGreaterThan(400);
    expect(Math.abs(r.redShiftPx - RED.a * N)).toBeLessThan(0.03);
    expect(Math.abs(r.blueShiftPx - BLUE.a * N)).toBeLessThan(0.03);
    expect(misalignment(r.correction!.geometry!, 0, RED, W, H)).toBeLessThan(0.05);
    expect(misalignment(r.correction!.geometry!, 2, BLUE, W, H)).toBeLessThan(0.05);
  });

  it('reports full-resolution pixels when measuring the half-size image', () => {
    // A half-size decode takes R and B from opposite corners of each 2x2 Bayer block: a
    // fixed quarter-pixel offset against G on top of the lens's radial CA.
    const red: Ca = { ...RED, tx: -0.25, ty: -0.25 };
    const blue: Ca = { ...BLUE, tx: 0.25, ty: 0.25 };
    const half = render({ width: W / 2, height: H / 2, red, blue, seed: 6 });
    const r = estimateLateralCA(half, { fullWidth: W });
    expect(r.redShiftPx).toBeCloseTo(RED.a * N, 1);
    expect(r.blueShiftPx).toBeCloseTo(BLUE.a * N, 1);
    const g = r.correction!.geometry!;
    expect(g.scale[0]).toBeCloseTo(W / N, 9);
    // In full-resolution px, the radial part matches the lens.
    expect(curveError(g.poly[0], RED, N)).toBeLessThan(0.1);
    expect(curveError(g.poly[2], BLUE, N)).toBeLessThan(0.1);
  });

  it('gives up on a featureless frame', () => {
    const r = estimateLateralCA(render({ width: 1200, height: 800, red: RED, blue: BLUE, shapes: false, seed: 7 }));
    expect(r.correction).toBeNull();
    expect(r.confidence).toBeLessThan(0.3);
  });

  it('copes with images too small to measure', () => {
    const r = estimateLateralCA({ width: 40, height: 30, data: new Uint16Array(40 * 30 * 3) });
    expect(r).toEqual({ correction: null, redShiftPx: 0, blueShiftPx: 0, confidence: 0, samples: 0 });
  });
});
