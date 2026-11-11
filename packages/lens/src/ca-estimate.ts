// Lateral chromatic aberration measured in the photo itself, for "Remove Chromatic
// Aberration" when there is no lens profile.
//
// Lateral CA scales the red and blue images slightly against the green one about the
// optical centre. At an edge that crosses the radius, the red (blue) edge therefore sits a
// fraction of a pixel further out or further in than the green edge. We measure that radial
// offset at one strong edge per grid cell, fit shift(r) = a·r + b·r³ per channel robustly,
// and hand it to the renderer as per-channel radial polynomials, with green as reference.
//
// Only short strips around the chosen edges are read, so a 45 MP image costs tens of
// milliseconds and nothing is allocated in proportion to its size.
//
// Pixel coordinates: pixel (i, j) is the point (i, j), the optical centre is
// ((w - 1) / 2, (h - 1) / 2). That is the normalised (0.5, 0.5) of the renderer, where pixel
// i covers [i / w, (i + 1) / w]. Radii are in units of half the diagonal (1 at the corners).
import { IDENTITY_POLY, type LensCorrection, type RadialPoly } from './types.ts';

export interface CaImage {
  width: number;
  height: number;
  /** Interleaved RGB, linear, 0..65535. */
  data: Uint16Array;
}

export interface CaEstimate {
  /** Null when the measurement is not trustworthy or the aberration is too small to matter. */
  correction: LensCorrection | null;
  /**
   * Radial shift of the red / blue image against green at the image corner, in pixels of
   * the full-resolution image. Positive: that channel is magnified (its fringe lies on the
   * outer side of bright edges).
   */
  redShiftPx: number;
  blueShiftPx: number;
  /** 0..1, how trustworthy the measurement is. */
  confidence: number;
  /** Edges that passed the local checks and went into the fit. */
  samples: number;
}

export interface CaOptions {
  /** Patches examined; at most one edge is measured in each. Default 1600. */
  maxSamples?: number;
  /** Width of the full-resolution image when measuring a downscaled one (e.g. the half-size decode). */
  fullWidth?: number;
}

const SOURCE = 'Chromatic aberration (measured)';

/** Edges closer to the centre barely move and mostly add noise. */
const R_MIN = 0.25;
/**
 * Half-length of the compared edge profile, in samples one full-resolution pixel apart (half
 * a pixel on the half-size image). Real edges carry broad colour halos (veiling glare,
 * longitudinal CA) that a warp cannot fix; the longer the profile, the more of them it
 * mistakes for lateral shift. Fixing the length in full-resolution pixels makes the
 * half-size and the full-resolution decode measure the same thing.
 */
const HALF = 7;
const SPAN = 2 * HALF + 1;
/** Parallel rays averaged on each side of the measuring ray, 1 px apart, against noise. */
const STRIP = 2;
/** Minimum correlation between a channel's profile and the green one at the coarse match. */
const MIN_NCC = 0.8;
/** Minimum share of the profile's variance explained by the aligned green profile. */
const MIN_FIT = 0.85;
/** Samples at each end of the profile averaged into the levels on either side of the edge. */
const PLATEAU = 4;
const BALANCE_GAIN = (SPAN * SPAN) / 2 / PLATEAU + SPAN;
/** The net step across the profile must be this share of its range: an edge, not a line. */
const STEP_SHARE = 0.6;
/** Floor for one edge's variance in samples²: interpolation and demosaicing limit the precision. */
const MIN_VAR = 0.02 ** 2;
const MIN_EDGES = 12;
/** Edge candidates kept per cell, tried best first until one measures. */
const CANDIDATES = 3;
/** Shifts below this, in full-resolution pixels, are not worth correcting. */
const NEGLIGIBLE_PX = 0.1;
const MIN_CONFIDENCE = 0.3;

/** Weights along the profile: flat in the middle, cosine taper over the last 4 samples. */
const WIN = Float64Array.from({ length: SPAN }, (_, i) => {
  const o = Math.abs(i - HALF) - (HALF - 4);
  return o <= 0 ? 1 : 0.5 + 0.5 * Math.cos((Math.PI * o) / 5);
});
const WIN_SUM = WIN.reduce((s, v) => s + v, 0);

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Mean of 2·STRIP + 1 parallel bilinear profiles of channel ch along the unit vector
 * (ux, uy), sampled at t = t0, t0 + 1, … samples of sp px from (x, y); the rays are 1 px
 * apart. Returns the brightest pixel touched, for the clipping test. The caller keeps every
 * sample at least STRIP + 2 px inside the image.
 */
function strip(data: Uint16Array, w: number, ch: number, x: number, y: number, ux: number, uy: number, sp: number, t0: number, out: Float64Array, count: number): number {
  const row = 3 * w;
  let peak = 0;
  for (let j = 0; j < count; j++) {
    const t = (t0 + j) * sp;
    let sum = 0;
    for (let k = -STRIP; k <= STRIP; k++) {
      const sx = x + t * ux - k * uy;
      const sy = y + t * uy + k * ux;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      const i = (y0 * w + x0) * 3 + ch;
      const p00 = data[i]!;
      const p10 = data[i + 3]!;
      const p01 = data[i + row]!;
      const p11 = data[i + row + 3]!;
      sum += (p00 + (p10 - p00) * fx) * (1 - fy) + (p01 + (p11 - p01) * fx) * fy;
      const hi = Math.max(p00, p10, p01, p11);
      if (hi > peak) peak = hi;
    }
    out[j] = sum / (2 * STRIP + 1);
  }
  return peak;
}

/**
 * Inserts a scan point into the best-first candidate list (score, y·w + x pairs, score -1
 * when empty). A point within a profile length of a listed one is on the same edge: it
 * replaces that entry when better and is dropped otherwise.
 */
function keepCandidate(top: Float64Array, score: number, x: number, y: number, w: number): void {
  let k = CANDIDATES - 1;
  for (let j = 0; j < CANDIDATES && top[2 * j]! >= 0; j++) {
    const at = top[2 * j + 1]!;
    const ax = at % w;
    if (Math.abs(ax - x) < HALF && Math.abs((at - ax) / w - y) < HALF) {
      if (score <= top[2 * j]!) return;
      k = j;
      break;
    }
  }
  while (k > 0 && top[2 * k - 2]! < score) {
    top[2 * k] = top[2 * k - 2]!;
    top[2 * k + 1] = top[2 * k - 1]!;
    k--;
  }
  top[2 * k] = score;
  top[2 * k + 1] = y * w + x;
}

/** Inverse of a symmetric 3x3 matrix into out (row-major); false when it is (nearly) singular. */
function invert3(a00: number, a01: number, a02: number, a11: number, a12: number, a22: number, out: Float64Array): boolean {
  const c00 = a11 * a22 - a12 * a12;
  const c01 = a02 * a12 - a01 * a22;
  const c02 = a01 * a12 - a02 * a11;
  const det = a00 * c00 + a01 * c01 + a02 * c02;
  if (!(det > 1e-9 * a00 * a11 * a22)) return false;
  const c11 = a00 * a22 - a02 * a02;
  const c12 = a01 * a02 - a00 * a12;
  const c22 = a00 * a11 - a01 * a01;
  out[0] = c00 / det;
  out[1] = out[3] = c01 / det;
  out[2] = out[6] = c02 / det;
  out[4] = c11 / det;
  out[5] = out[7] = c12 / det;
  out[8] = c22 / det;
  return true;
}

/**
 * Per-channel level above which a pixel may be clipped, from a sparse sample of the image.
 * Channels clip at different levels once white balance is applied, so each gets its own;
 * anything within 3 % of a channel's brightest value counts.
 */
function clipLevels(data: Uint16Array, w: number, h: number): [number, number, number] {
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 250_000)));
  let r = 0;
  let g = 0;
  let b = 0;
  for (let y = step >> 1; y < h; y += step) {
    for (let x = (y * 7) % step; x < w; x += step) {
      const i = (y * w + x) * 3;
      r = Math.max(r, data[i]!);
      g = Math.max(g, data[i + 1]!);
      b = Math.max(b, data[i + 2]!);
    }
  }
  return [0.97 * r, 0.97 * g, 0.97 * b];
}

/** Settings and scratch buffers shared by all edge measurements of one estimate. */
interface Probe {
  data: Uint16Array;
  w: number;
  cx: number;
  cy: number;
  n: number;
  /** Profile sample spacing, px: one full-resolution pixel. Lengths below are in samples. */
  sp: number;
  /** Largest shift searched for. */
  search: number;
  /** How far the steepest green transition may be from the scan point. */
  reach: number;
  /** Half-length of the read profiles: template, search range and reach. */
  half: number;
  clip: [number, number, number];
  prof: [Float64Array, Float64Array, Float64Array];
  /** Green template (weighted mean removed) and its slope. */
  tmpl: Float64Array;
  slope: Float64Array;
  q: Float64Array;
  ncc: Float64Array;
  /** Inverse normal matrix of the fit q ≈ gain·tmpl + level + lean·slope. */
  inv: Float64Array;
  tNorm: number;
  /** Balance point and step of the green template, see balance(). */
  tAt: number;
  tStep: number;
  /** Result of the last align(): shift along the outward radius and its variance, in samples. */
  shift: number;
  variance: number;
}

interface Samples {
  r: Float64Array;
  ux: Float64Array;
  uy: Float64Array;
  /** Shifts and variances in normalised radius units; NaN where the channel was not measured. */
  dR: Float64Array;
  vR: Float64Array;
  dB: Float64Array;
  vB: Float64Array;
}

/**
 * Balance point of an edge profile v[0..SPAN), in samples from its middle: where a sharp
 * step between the start and end levels would enclose the same area. Exact for a step
 * integrated over pixels, and unchanged by any symmetric blur, so a channel that is a
 * smoothed copy of another still balances at the same place. Start and end levels are
 * means of PLATEAU samples; their noise, weighted by SPAN / 2, dominates the variance:
 * (SPAN² / 2 / PLATEAU + SPAN)·σ² / step² = BALANCE_GAIN·σ² / step².
 */
function balance(v: Float64Array): { at: number; step: number; range: number } {
  let a = 0;
  let b = 0;
  let sum = 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < SPAN; i++) {
    const x = v[i]!;
    sum += x;
    lo = Math.min(lo, x);
    hi = Math.max(hi, x);
    if (i < PLATEAU) a += x;
    else if (i >= SPAN - PLATEAU) b += x;
  }
  a /= PLATEAU;
  b /= PLATEAU;
  return { at: (((a + b) / 2) * SPAN - sum) / (b - a), step: b - a, range: hi - lo };
}

/**
 * Radial offset of channel ch against the green template: coarse whole-pixel match by
 * normalised cross-correlation (channels differ in level and contrast), Lucas-Kanade
 * refinement with an affine intensity model, resampling the channel at the sub-pixel shift,
 * and a final correction by the edges' balance points.
 */
function align(p: Probe, ch: number, jc: number, px: number, py: number, ux: number, uy: number): boolean {
  const prof = p.prof[ch]!;
  const S = p.search;
  let best = -Infinity;
  let coarse = 0;
  for (let s = -S; s <= S; s++) {
    let sq = 0;
    let sqq = 0;
    let sqt = 0;
    for (let i = 0; i < SPAN; i++) {
      const v = prof[jc - HALF + i + s]!;
      const wi = WIN[i]!;
      sq += wi * v;
      sqq += wi * v * v;
      sqt += wi * v * p.tmpl[i]!;
    }
    const varQ = sqq - (sq * sq) / WIN_SUM;
    const c = varQ > 0 ? sqt / Math.sqrt(varQ * p.tNorm) : 0;
    p.ncc[s + S] = c;
    if (c > best) {
      best = c;
      coarse = s;
    }
  }
  // At the end of the range the true offset may lie beyond it.
  if (best < MIN_NCC || Math.abs(coarse) === S) return false;
  // A second, nearly as good match means a repetitive texture: the offset would be a guess.
  for (let s = -S + 1; s < S; s++) {
    const c = p.ncc[s + S]!;
    if (Math.abs(s - coarse) >= 2 && c > 0.9 * best && c >= p.ncc[s + S - 1]! && c >= p.ncc[s + S + 1]!) return false;
  }

  const inv = p.inv;
  const t0 = jc - p.half - HALF;
  let shift = coarse;
  for (let it = 0; it < 10; it++) {
    const at = shift;
    strip(p.data, p.w, ch, px, py, ux, uy, p.sp, t0 + at, p.q, SPAN);
    let r0 = 0;
    let r1 = 0;
    let r2 = 0;
    let qq = 0;
    for (let i = 0; i < SPAN; i++) {
      const v = p.q[i]!;
      const wi = WIN[i]!;
      r0 += wi * v * p.tmpl[i]!;
      r1 += wi * v;
      r2 += wi * v * p.slope[i]!;
      qq += wi * v * v;
    }
    const gain = inv[0]! * r0 + inv[1]! * r1 + inv[2]! * r2;
    const level = inv[3]! * r0 + inv[4]! * r1 + inv[5]! * r2;
    const lean = inv[6]! * r0 + inv[7]! * r1 + inv[8]! * r2;
    // Opposite polarity (e.g. a red-green boundary) does not align reliably.
    if (!(gain > 0)) return false;
    // q(t) = c(t + shift) ≈ gain·g(t + shift - true) + level, so lean = gain·(shift - true).
    const step = clamp(-lean / gain, -0.5, 0.5);
    shift += step;
    if (Math.abs(step) < 1e-3 || it === 9) {
      if (Math.abs(step) > 0.02 || Math.abs(shift) > S) return false;
      const res = Math.max(0, qq - (gain * r0 + level * r1 + lean * r2));
      const tot = qq - (r1 * r1) / WIN_SUM;
      if (!(tot > 0) || 1 - res / tot < MIN_FIT) return false;
      // The least-squares match is precise, but on a demosaiced image the red edge is partly a
      // softened copy of the green one (interpolation smooths the colour difference), and the
      // match then finds only part of the shift. Balance points are unaffected by smoothing,
      // so the result is the match plus the difference of the balance points around it.
      const bal = balance(p.q);
      if (!(Math.abs(bal.step) >= STEP_SHARE * bal.range) || bal.step * p.tStep <= 0) return false;
      p.shift = at + bal.at - p.tAt;
      // Noise of the balance point (see balance()), with the residual spread of the match
      // as noise of either channel.
      p.variance = Math.max(MIN_VAR, (BALANCE_GAIN * res) / (WIN_SUM - 3) / (bal.step * bal.step));
      return true;
    }
  }
  return false;
}

/** Measures the red and blue offsets at the edge through scan point (px, py) into slot k. */
function measureEdge(p: Probe, px: number, py: number, out: Samples, k: number): boolean {
  let ux = px - p.cx;
  let uy = py - p.cy;
  const rad = Math.hypot(ux, uy);
  if (rad < R_MIN * p.n) return false;
  ux /= rad;
  uy /= rad;
  const L = p.half;
  const g = p.prof[1];
  if (strip(p.data, p.w, 1, px, py, ux, uy, p.sp, -L, g, 2 * L + 1) >= p.clip[1]) return false;

  // Centre the template on the steepest green transition near the scan point.
  let jc = L;
  let steep = -1;
  for (let j = L - p.reach - 1; j <= L + p.reach + 1; j++) {
    const v = Math.abs(g[j + 1]! - g[j - 1]!);
    if (v > steep) {
      steep = v;
      jc = j;
    }
  }
  let lo = Infinity;
  let hi = -Infinity;
  let mean = 0;
  for (let i = 0; i < SPAN; i++) {
    const v = g[jc - HALF + i]!;
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
    mean += WIN[i]! * v;
  }
  // Too faint to place to a fraction of a pixel.
  if (hi - lo < 0.03 * hi + 32) return false;
  mean /= WIN_SUM;
  let tNorm = 0;
  let a02 = 0;
  let a12 = 0;
  let a22 = 0;
  for (let i = 0; i < SPAN; i++) {
    const j = jc - HALF + i;
    const t = g[j]! - mean;
    const d = (g[j + 1]! - g[j - 1]!) / 2;
    const wi = WIN[i]!;
    p.tmpl[i] = t;
    p.slope[i] = d;
    tNorm += wi * t * t;
    a02 += wi * t * d;
    a12 += wi * d;
    a22 += wi * d * d;
  }
  if (!invert3(tNorm, 0, a02, WIN_SUM, a12, a22, p.inv)) return false;
  const bal = balance(p.tmpl);
  if (!(Math.abs(bal.step) >= STEP_SHARE * bal.range)) return false;
  p.tNorm = tNorm;
  p.tAt = bal.at;
  p.tStep = bal.step;
  if (strip(p.data, p.w, 0, px, py, ux, uy, p.sp, -L, p.prof[0], 2 * L + 1) >= p.clip[0]) return false;
  if (strip(p.data, p.w, 2, px, py, ux, uy, p.sp, -L, p.prof[2], 2 * L + 1) >= p.clip[2]) return false;

  const off = (jc - L) * p.sp;
  out.r[k] = Math.hypot(px + off * ux - p.cx, py + off * uy - p.cy) / p.n;
  out.ux[k] = ux;
  out.uy[k] = uy;
  const unit = p.sp / p.n;
  const red = align(p, 0, jc, px, py, ux, uy);
  out.dR[k] = red ? p.shift * unit : NaN;
  out.vR[k] = red ? p.variance * unit * unit : NaN;
  const blue = align(p, 2, jc, px, py, ux, uy);
  out.dB[k] = blue ? p.shift * unit : NaN;
  out.vB[k] = blue ? p.variance * unit * unit : NaN;
  return red || blue;
}

/** Solves the small dense system m·x = b by Gaussian elimination with partial pivoting. */
function solve(m: number[][], b: number[]): number[] | null {
  const n = b.length;
  const a = m.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r]![c]!) > Math.abs(a[piv]![c]!)) piv = r;
    const top = a[piv]!;
    if (!(Math.abs(top[c]!) > 0)) return null;
    a[piv] = a[c]!;
    a[c] = top;
    for (let r = c + 1; r < n; r++) {
      const row = a[r]!;
      const f = row[c]! / top[c]!;
      for (let k = c; k <= n; k++) row[k] = row[k]! - f * top[k]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    const row = a[r]!;
    let s = row[n]!;
    for (let k = r + 1; k < n; k++) s -= row[k]! * x[k]!;
    x[r] = s / row[r]!;
  }
  return x.every(Number.isFinite) ? x : null;
}

function median(v: Float64Array): number {
  const s = Float64Array.from(v).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : 0.5 * (s[m - 1]! + s[m]!);
}

function weightedMedian(v: Float64Array, w: Float64Array): number {
  const order = Array.from(v.keys()).sort((i, j) => v[i]! - v[j]!);
  const half = w.reduce((s, x) => s + x, 0) / 2;
  let acc = 0;
  for (const i of order) {
    acc += w[i]!;
    if (acc >= half) return v[i]!;
  }
  return 0;
}

interface ChannelFit {
  /** shift(r) = a·r + b·r³ in normalised radius units. */
  a: number;
  b: number;
  /** Standard deviation of the corner shift a + b. */
  cornerSd: number;
  used: number;
  inliers: number;
}

/**
 * Robust fit of d = a·r + b·r³ + tx·ux + ty·uy. The translation (tx, ty) is not part of the
 * correction: it absorbs the fixed offset between the colour sites of a half-size decode
 * (R and B come from opposite corners of each 2x2 Bayer block) and slight lens decentring,
 * which would otherwise scatter the radial shifts by direction. n is the number of
 * full-resolution pixels per normalised radius unit.
 */
function fitChannel(s: Samples, d: Float64Array, v: Float64Array, count: number, n: number): ChannelFit | null {
  const idx: number[] = [];
  for (let i = 0; i < count; i++) if (Number.isFinite(d[i]!)) idx.push(i);
  const m = idx.length;
  if (m < MIN_EDGES) return null;

  const X = new Float64Array(m * 4);
  const y = new Float64Array(m);
  const w0 = new Float64Array(m);
  // Edges at different depths and demosaicing make real shifts scatter more than the noise says.
  const extra = (0.03 / n) ** 2;
  idx.forEach((i, k) => {
    const r = s.r[i]!;
    X[4 * k] = r;
    X[4 * k + 1] = r * r * r;
    X[4 * k + 2] = s.ux[i]!;
    X[4 * k + 3] = s.uy[i]!;
    y[k] = d[i]!;
    w0[k] = 1 / (v[i]! + extra);
  });

  // b, tx and ty ~ N(0, (2 px)²): only matters when the edges cannot tell them apart.
  const prior = (n * n) / 4;
  const normal = (wt: Float64Array): { M: number[][]; rhs: number[] } => {
    const M = [0, 1, 2, 3].map((i) => [0, 1, 2, 3].map((j) => (i === j && i > 0 ? prior : 0)));
    const rhs = [0, 0, 0, 0];
    for (let k = 0; k < m; k++) {
      const wk = wt[k]!;
      for (let i = 0; i < 4; i++) {
        const xi = X[4 * k + i]! * wk;
        rhs[i] = rhs[i]! + xi * y[k]!;
        const row = M[i]!;
        for (let j = 0; j < 4; j++) row[j] = row[j]! + xi * X[4 * k + j]!;
      }
    }
    return { M, rhs };
  };

  // Start from the median magnification, then iteratively reweighted least squares: Huber
  // to settle, Tukey's biweight to drop the outliers entirely.
  const ratio = new Float64Array(m);
  const rw = new Float64Array(m);
  for (let k = 0; k < m; k++) {
    ratio[k] = y[k]! / X[4 * k]!;
    rw[k] = w0[k]! * X[4 * k]! ** 2;
  }
  let beta = [weightedMedian(ratio, rw), 0, 0, 0];
  const z = new Float64Array(m);
  const absZ = new Float64Array(m);
  const wt = new Float64Array(m);
  const residuals = () => {
    for (let k = 0; k < m; k++) {
      let f = 0;
      for (let i = 0; i < 4; i++) f += X[4 * k + i]! * beta[i]!;
      z[k] = (y[k]! - f) * Math.sqrt(w0[k]!);
      absZ[k] = Math.abs(z[k]!);
    }
    return Math.max(1e-6, 1.4826 * median(absZ));
  };
  const TUKEY = 4.685;
  let scale = residuals();
  for (let it = 0; it < 12; it++) {
    for (let k = 0; k < m; k++) {
      const u = absZ[k]! / scale;
      const robust = it < 4 ? (u <= 1.345 ? 1 : 1.345 / u) : u < TUKEY ? (1 - (u / TUKEY) ** 2) ** 2 : 0;
      wt[k] = w0[k]! * robust;
    }
    const { M, rhs } = normal(wt);
    const next = solve(M, rhs);
    if (!next) return null;
    beta = next;
    scale = residuals();
  }

  let inliers = 0;
  for (let k = 0; k < m; k++) {
    const u = absZ[k]! / scale;
    wt[k] = u < TUKEY ? w0[k]! * (1 - (u / TUKEY) ** 2) ** 2 : 0;
    if (u < TUKEY) inliers++;
  }
  // Variance of a + b: g·M⁻¹·g with g = (1, 1, 0, 0), scaled by the observed residual spread.
  const { M } = normal(wt);
  const gSol = solve(M, [1, 1, 0, 0]);
  if (!gSol) return null;
  const cornerVar = scale * scale * (gSol[0]! + gSol[1]!);
  return { a: beta[0]!, b: beta[1]!, cornerSd: Math.sqrt(Math.max(0, cornerVar)), used: m, inliers };
}

/** Largest |a·r + b·r³| over r in [0, 1]. */
function peakShift(f: ChannelFit): number {
  let peak = 0;
  for (let i = 1; i <= 20; i++) {
    const r = i / 20;
    peak = Math.max(peak, Math.abs(f.a * r + f.b * r * r * r));
  }
  return peak;
}

/** 0..1 from the corner shift's uncertainty (full-resolution px) and the support of the fit. */
function channelConfidence(f: ChannelFit, toFull: number): number {
  const sd = f.cornerSd * toFull;
  const support = Math.min(1, f.inliers / 40) * Math.min(1, f.inliers / f.used / 0.5);
  return support / (1 + (sd / 0.08) ** 2);
}

/** r_src = r·(1 + a + b·r²): the channel recorded the ideal point at that radius. */
const toPoly = (f: ChannelFit): RadialPoly => [1 + f.a, 0, f.b, 0, 0, 0, 0];

/**
 * Measures lateral chromatic aberration of a linear RGB image and returns the correction
 * that re-aligns red and blue to green.
 *
 * Sign convention: if the lens images red at m·r where green is at r (red magnified), the
 * red polynomial is r_src = m·r, i.e. the corrected red at an ideal point is read from the
 * larger radius where red actually recorded it, and redShiftPx > 0.
 */
export function estimateLateralCA(img: CaImage, opts: CaOptions = {}): CaEstimate {
  const { width: w, height: h, data } = img;
  const none: CaEstimate = { correction: null, redShiftPx: 0, blueShiftPx: 0, confidence: 0, samples: 0 };
  if (!(w > 0 && h > 0) || data.length < w * h * 3) return none;

  const n = Math.hypot(w, h) / 2;
  const maxSamples = Math.max(16, Math.round(opts.maxSamples ?? 1600));
  // One edge per cell; about 90 % of the cells lie outside R_MIN.
  const cell = Math.max(8, Math.round(Math.sqrt((w * h * 0.9) / maxSamples)));
  // At most 48 x 48 scan points per cell. The finite difference spans the stride, so no
  // edge slips between two scan points.
  const stride = Math.ceil(cell / 48);
  const reach = Math.ceil(stride / 2);
  // Profiles are sampled per full-resolution pixel, but not finer than half a pixel of this
  // image, where interpolation would dominate.
  const fullScale = Math.max(1, (opts.fullWidth ?? w) / w);
  const sp = Math.max(0.5, 1 / fullScale);
  // Shifts up to 0.16 % of the half diagonal, ~8 full-resolution px at 45 MP.
  const search = clamp(Math.ceil((n / sp) * 0.0016), 3, 10);
  const half = HALF + search + Math.ceil(reach / sp) + 2;
  const margin = Math.ceil(half * sp) + STRIP + 2;
  if (w < 4 * margin || h < 4 * margin) return none;

  const probe: Probe = {
    data,
    w,
    cx: (w - 1) / 2,
    cy: (h - 1) / 2,
    n,
    sp,
    search,
    reach: Math.ceil(reach / sp),
    half,
    clip: clipLevels(data, w, h),
    prof: [new Float64Array(2 * half + 1), new Float64Array(2 * half + 1), new Float64Array(2 * half + 1)],
    tmpl: new Float64Array(SPAN),
    slope: new Float64Array(SPAN),
    q: new Float64Array(SPAN),
    ncc: new Float64Array(2 * search + 1),
    inv: new Float64Array(9),
    tNorm: 0,
    tAt: 0,
    tStep: 0,
    shift: 0,
    variance: 0,
  };
  const cells = Math.ceil(w / cell) * Math.ceil(h / cell);
  const out: Samples = {
    r: new Float64Array(cells),
    ux: new Float64Array(cells),
    uy: new Float64Array(cells),
    dR: new Float64Array(cells),
    vR: new Float64Array(cells),
    dB: new Float64Array(cells),
    vB: new Float64Array(cells),
  };

  // Read noise floor for the edge score, so deep shadows do not win on relative contrast.
  const floor = 16 + probe.clip[1] * 0.002;
  // Edge candidates of the current cell, see keepCandidate().
  const top = new Float64Array(2 * CANDIDATES);
  let count = 0;
  for (let y0 = 0; y0 < h; y0 += cell) {
    const ya = Math.max(y0, margin);
    const yb = Math.min(y0 + cell, h - margin);
    for (let x0 = 0; x0 < w; x0 += cell) {
      const xa = Math.max(x0, margin);
      const xb = Math.min(x0 + cell, w - margin);
      if (xa >= xb || ya >= yb) continue;
      const mx = (xa + xb) / 2 - probe.cx;
      const my = (ya + yb) / 2 - probe.cy;
      const len = Math.hypot(mx, my);
      if (len < R_MIN * n - cell) continue;
      // Green difference along the cell's radius, between the nearest pixels.
      const radial = 3 * (Math.round(((reach + 0.5) * my) / len) * w + Math.round(((reach + 0.5) * mx) / len));

      // Strongest edges across the radius, scored by squared difference over brightness:
      // about their signal-to-noise ratio under shot noise. A few separate candidates are
      // kept, because the best one is often the rim of a clipped highlight and gets rejected.
      top.fill(-1);
      for (let y = ya; y < yb; y += stride) {
        for (let x = xa; x < xb; x += stride) {
          const i = (y * w + x) * 3 + 1;
          const d = data[i + radial]! - data[i - radial]!;
          const score = (d * d) / (data[i]! + floor);
          if (score > top[2 * (CANDIDATES - 1)]!) keepCandidate(top, score, x, y, w);
        }
      }
      for (let k = 0; k < CANDIDATES && top[2 * k]! >= 0; k++) {
        const at = top[2 * k + 1]!;
        const px = at % w;
        if (measureEdge(probe, px, (at - px) / w, out, count)) {
          count++;
          break;
        }
      }
    }
  }

  const toFull = n * fullScale;
  const red = fitChannel(out, out.dR, out.vR, count, toFull);
  const blue = fitChannel(out, out.dB, out.vB, count, toFull);
  if (!red || !blue) {
    return { ...none, redShiftPx: red ? (red.a + red.b) * toFull : 0, blueShiftPx: blue ? (blue.a + blue.b) * toFull : 0, samples: count };
  }

  const confidence = Math.min(channelConfidence(red, toFull), channelConfidence(blue, toFull));
  const worth = Math.max(peakShift(red), peakShift(blue)) * toFull >= NEGLIGIBLE_PX;
  const correction: LensCorrection | null =
    confidence >= MIN_CONFIDENCE && worth
      ? {
          source: SOURCE,
          geometry: {
            center: [0.5, 0.5],
            scale: [w / n, h / n],
            poly: [toPoly(red), [...IDENTITY_POLY] as RadialPoly, toPoly(blue)],
          },
          vignetting: null,
        }
      : null;
  return {
    correction,
    redShiftPx: (red.a + red.b) * toFull,
    blueShiftPx: (blue.a + blue.b) * toFull,
    confidence,
    samples: count,
  };
}
