// Lens Corrections -> shader parameters, and the same mapping on the CPU (export tile
// bounds, the white-balance picker). The mapping, for an "ideal" (corrected) normalised
// source point s:
//   1. auto zoom about the centre, so no gaps show at the edges:            s1 = 0.5 + (s - 0.5) / zoom
//   2. manual Distortion about the centre (r = 1 at the corners):            r2 = r1 · (1 + k · r1²)
//   3. the lens profile, per channel (distortion + lateral CA)               (LensCorrection.geometry)
//   4. measured lateral CA (Remove Chromatic Aberration), red and blue       (LensCorrection.geometry)
// and the channel is sampled there. Vignetting is a gain at the green channel's point.
import type { LensCorrection, RadialFrame, RadialPoly } from '@immich-raw/lens';
import type { Recipe } from '@immich-raw/recipe';

export interface LensData {
  /** Profile correction found for the photo (Lensfun or the DNG's own), or null. */
  profile: LensCorrection | null;
  /** Lateral chromatic aberration measured on the photo, or null. */
  ca: LensCorrection | null;
}

export const NO_LENS: LensData = { profile: null, ca: null };

type Poly3 = [RadialPoly, RadialPoly, RadialPoly];

export interface LensModel {
  zoom: number;
  /** Manual distortion k and the frame it is measured in (r = 1 at the corners). */
  manual: number;
  manualScale: [number, number];
  geo: (RadialFrame & { poly: Poly3 }) | null;
  ca: (RadialFrame & { poly: Poly3 }) | null;
  vig: (RadialFrame & { k: number[]; divide: boolean; amount: number }) | null;
  /** Manual vignetting: EV at the corners, and where the falloff starts (radius). */
  manualVig: [number, number];
}

const IDENTITY: RadialPoly = [1, 0, 0, 0, 0, 0, 0];

/** Profile strength: 0 = no correction, 1 = the profile, 2 = twice the correction. */
const scalePoly = (p: RadialPoly, a: number): RadialPoly => p.map((c, i) => IDENTITY[i]! + a * (c - IDENTITY[i]!)) as RadialPoly;

const evalPoly = (c: readonly number[], r: number) => r * (c[0]! + r * (c[1]! + r * (c[2]! + r * (c[3]! + r * (c[4]! + r * (c[5]! + r * c[6]!))))));

function radialMap(f: RadialFrame, poly: readonly number[], s: [number, number]): [number, number] {
  const dx = (s[0] - f.center[0]) * f.scale[0];
  const dy = (s[1] - f.center[1]) * f.scale[1];
  const r = Math.hypot(dx, dy);
  if (r < 1e-12) return s;
  const k = evalPoly(poly, r) / r;
  return [f.center[0] + (s[0] - f.center[0]) * k, f.center[1] + (s[1] - f.center[1]) * k];
}

/** Steps 2-4 of the mapping (no zoom). */
function mapChannel(m: Omit<LensModel, 'zoom'>, s: [number, number], ch: 0 | 1 | 2): [number, number] {
  let p = s;
  if (m.manual !== 0) {
    const dx = (p[0] - 0.5) * m.manualScale[0];
    const dy = (p[1] - 0.5) * m.manualScale[1];
    const k = 1 + m.manual * (dx * dx + dy * dy);
    p = [0.5 + (p[0] - 0.5) * k, 0.5 + (p[1] - 0.5) * k];
  }
  if (m.geo) p = radialMap(m.geo, m.geo.poly[ch], p);
  if (m.ca && ch !== 1) p = radialMap(m.ca, m.ca.poly[ch], p);
  return p;
}

/** Where channel `ch` of the ideal point s is found in the decoded image (normalised). */
export function lensSourcePoint(m: LensModel, s: [number, number], ch: 0 | 1 | 2 = 1): [number, number] {
  return mapChannel(m, [0.5 + (s[0] - 0.5) / m.zoom, 0.5 + (s[1] - 0.5) / m.zoom], ch);
}

export function isLensActive(m: LensModel): boolean {
  return m.zoom !== 1 || m.manual !== 0 || !!m.geo || !!m.ca;
}

/**
 * Smallest zoom (at least 1) at which every channel of the frame's border maps inside the
 * image. Like Lightroom it only zooms in to hide gaps, never out: zooming out after a barrel
 * correction would bring back corners the lens never lit (dark, noisy, or masked).
 */
function autoZoom(m: Omit<LensModel, 'zoom'>): number {
  const border: [number, number][] = [];
  const n = 24;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    border.push([t, 0], [t, 1], [0, t], [1, t]);
  }
  const fits = (zoom: number) =>
    border.every((b) => {
      const s: [number, number] = [0.5 + (b[0] - 0.5) / zoom, 0.5 + (b[1] - 0.5) / zoom];
      return ([0, 1, 2] as const).every((ch) => {
        const p = mapChannel(m, s, ch);
        return p[0] >= -1e-4 && p[1] >= -1e-4 && p[0] <= 1 + 1e-4 && p[1] <= 1 + 1e-4;
      });
    });
  if (fits(1)) return 1;
  let lo = 1;
  let hi = 2.5;
  if (!fits(hi)) return hi;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

/**
 * The corrections the recipe asks for, given what is known about the lens.
 * width/height: the decoded image size (any scale; only the aspect matters).
 */
export function lensModel(recipe: Recipe, data: LensData, width: number, height: number): LensModel {
  const L = recipe.lens;
  const half = Math.hypot(width, height) / 2 || 1;
  const manualScale: [number, number] = [width / half, height / half];
  const removeCA = L.removeCA && !!data.ca?.geometry;
  let geo: LensModel['geo'] = null;
  let vig: LensModel['vig'] = null;
  if (L.profile && data.profile) {
    const g = data.profile.geometry;
    const a = L.profileDistortion / 100;
    if (g && a > 0) {
      // With measured CA, the profile's own CA terms would correct it twice: use green for all.
      const poly = (removeCA ? [g.poly[1], g.poly[1], g.poly[1]] : g.poly).map((p) => scalePoly(p, a)) as Poly3;
      geo = { center: g.center, scale: g.scale, poly };
    }
    const v = data.profile.vignetting;
    if (v && L.profileVignetting > 0) vig = { center: v.center, scale: v.scale, k: [...v.k], divide: v.mode === 'divide', amount: L.profileVignetting / 100 };
  }
  const ca = removeCA && data.ca?.geometry ? { center: data.ca.geometry.center, scale: data.ca.geometry.scale, poly: data.ca.geometry.poly } : null;
  // Positive Distortion corrects barrel distortion: the corners are taken from further in.
  const manual = (-L.distortion / 100) * 0.2;
  const base = { manual, manualScale, geo, ca, vig, manualVig: [(L.vignetting / 100) * 1.5, (L.vignetteMidpoint / 100) * 0.85] as [number, number] };
  const zoom = geo || ca || manual !== 0 ? autoZoom(base) : 1;
  return { ...base, zoom };
}

const polyArray = (p: readonly number[]) => new Float32Array(p);

/** Uniforms for COMMON in shaders.ts. */
export function lensUniforms(m: LensModel) {
  const z7 = polyArray(IDENTITY);
  return {
    uLensOn: isLensActive(m) || m.vig || m.manualVig[0] !== 0 ? 1 : 0,
    uLensZoom: m.zoom,
    uManualDist: m.manual,
    uManualScale: m.manualScale,
    uGeoOn: m.geo ? 1 : 0,
    uGeoCenter: m.geo?.center ?? [0.5, 0.5],
    uGeoScale: m.geo?.scale ?? [1, 1],
    uGeoR: m.geo ? polyArray(m.geo.poly[0]) : z7,
    uGeoG: m.geo ? polyArray(m.geo.poly[1]) : z7,
    uGeoB: m.geo ? polyArray(m.geo.poly[2]) : z7,
    uCaOn: m.ca ? 1 : 0,
    uCaCenter: m.ca?.center ?? [0.5, 0.5],
    uCaScale: m.ca?.scale ?? [1, 1],
    uCaR: m.ca ? polyArray(m.ca.poly[0]) : z7,
    uCaB: m.ca ? polyArray(m.ca.poly[2]) : z7,
    uVigOn: m.vig ? 1 : 0,
    uVigCenter: m.vig?.center ?? [0.5, 0.5],
    uVigScale: m.vig?.scale ?? [1, 1],
    uVigK: new Float32Array(m.vig ? [...m.vig.k, 0, 0, 0, 0, 0].slice(0, 5) : [0, 0, 0, 0, 0]),
    uVigDivide: m.vig?.divide ? 1 : 0,
    uVigAmount: m.vig?.amount ?? 0,
    uManualVig: m.manualVig,
  };
}

/** Defringe (tone pass): amounts 0..1 and the hue ranges in OKLab radians. */
export function defringeUniforms(recipe: Recipe) {
  const L = recipe.lens;
  const rad = (d: number) => (d * Math.PI) / 180;
  // Lightroom's hue sliders, 0..100: purple runs blue -> magenta -> red, green yellow -> aqua.
  const purple = (v: number) => rad(260 + v * 1.2);
  const green = (v: number) => rad(80 + v * 1.2);
  return {
    uDefringe: [L.defringePurple / 20, L.defringeGreen / 20, 0, L.defringePurple > 0 || L.defringeGreen > 0 ? 1 : 0],
    uDefringeHue: [purple(L.defringePurpleLo), purple(L.defringePurpleHi), green(L.defringeGreenLo), green(L.defringeGreenHi)],
  };
}
