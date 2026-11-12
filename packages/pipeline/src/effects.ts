// Noise reduction (Detail panel), post-crop vignetting and grain (Effects panel):
// the shader code, the parameters they get, and CPU copies of the simple maths for tests.
//
// Noise reduction runs on the scene-linear image (after the linear pass, before tone), in
// OKLab, as an edge-avoiding à-trous wavelet pyramid:
//   prep    : linear ProPhoto -> (L, a / L, b / L, 0)
//   level i : 5x5 B3-spline smoothing at a spacing of 2^i full-resolution pixels. Luminance:
//             the detail removed at this level is shrunk (small = noise) and accumulated in w.
//             Chroma: smoothed in place where luminance and colour differences are small.
//   compose : L = smoothest level + kept detail, chroma = smoothed -> linear ProPhoto again.
// Level spacings are in full-resolution pixels, so the fitted proxy, the 1:1 view and the
// export filter the same image structures. Levels finer than the render grid are skipped.
//
// Vignetting and grain are drawn in the finish pass, in display space, at positions of the
// full-resolution output frame (the crop), so export tiles and zoomed views line up.
import type { DetailParams, EffectsParams, VignetteStyle } from '@immich-raw/recipe';
import { toGlMat3 } from './color/index.ts';
import type { GLContext, Program, Target } from './gl.ts';
import { STATIC_UNIFORMS } from './uniforms.ts';

// ------------------------------------------------------------------ noise reduction

/** Level spacings in full-resolution pixels. The export apron must cover 2 x their sum. */
export const NR_SCALES = [1, 2, 4, 8, 16, 32] as const;
/** How far noise reduction reaches, in full-resolution pixels. */
export const NR_REACH = 2 * NR_SCALES.reduce((a, b) => a + b, 0);
/**
 * Luminance shrink threshold per level, relative to level 0: how much demosaiced noise is
 * left at each scale (white noise would fall faster, 1 / 0.22 / 0.1 / 0.045 / 0.022).
 */
const LUM_BASE = [1, 0.5, 0.25, 0.13, 0.07];
/** Threshold at Luminance 100 for midtones at ISO 100, in OKLab L. */
const LUM_MAX_T = 0.04;
/** Levels with a smaller spacing (in render pixels) are averaged away in a downscaled render. */
const MIN_DILATION = 0.7;

export interface NrLevel {
  /** Tap spacing in render pixels. */
  dilation: number;
  /** Shrink threshold for this level's luminance detail (OKLab L); 0 keeps it all. */
  lumT: number;
  /** Edge-stopping width of the luminance smoothing. */
  lumRange: number;
  /** Share of this level's chroma smoothing that is applied, 0..1. */
  colorGain: number;
}

export interface NrPlan {
  luminance: boolean;
  color: boolean;
  /**
   * Noise grows with ISO and with an exposure push (a darker capture shown brighter): the
   * luminance thresholds are multiplied by this, and per pixel by how dark it is.
   */
  noiseGain: number;
  levels: NrLevel[];
  /** Edge-stopping widths of the chroma smoothing: luminance and chroma differences. */
  colorRange: [number, number];
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * The noise reduction passes for these settings. `scale` = render pixels per
 * full-resolution pixel (1 for export); `exposure` = the Exposure slider (EV); `iso` from
 * EXIF. Null when noise reduction is off.
 */
export function nrPlan(d: DetailParams, scale: number, exposure = 0, iso = 100): NrPlan | null {
  const lum = d.nrLuminance / 100;
  const col = d.nrColor / 100;
  if (lum <= 0 && col <= 0) return null;
  // Detail lowers the threshold of the fine levels (keeps texture, and some noise); Contrast
  // lowers it at the coarse levels (keeps local contrast, and some blotches).
  const detail = 2 ** ((0.5 - d.nrLuminanceDetail / 100) * 2);
  const contrast = 1 - (0.9 * d.nrLuminanceContrast) / 100;
  // Color smooths chroma up to a radius; Smoothness adds the coarse levels (mottling);
  // Detail narrows the edge-stopping widths, so thin colour edges survive.
  const radius = 2 + 22 * col;
  const smooth = d.nrColorSmoothness / 100;
  const colorDetail = 2 ** ((0.5 - d.nrColorDetail / 100) * 2.5);
  const levels: NrLevel[] = [];
  NR_SCALES.forEach((s, i) => {
    const dilation = s * scale;
    if (dilation < MIN_DILATION) return;
    const fine = i <= 1 ? 1 : i === 2 ? 0.5 : 0;
    // Gentle at low settings, where it should only take the edge off fine noise.
    const lumT = lum > 0 && i < LUM_BASE.length ? LUM_MAX_T * lum ** 1.6 * LUM_BASE[i]! * detail ** fine * contrast ** (1 - fine) : 0;
    let colorGain = 0;
    if (col > 0) {
      colorGain = clamp01(Math.log2(radius / s) + 1);
      if (i >= 3) colorGain = Math.max(colorGain, smooth * (0.4 + 0.3 * (i - 3)));
    }
    if (lumT <= 0 && colorGain <= 0) return;
    levels.push({ dilation, lumT, lumRange: Math.max(3 * lumT, 0.01), colorGain });
  });
  if (!levels.length) return null;
  return {
    luminance: lum > 0,
    color: col > 0,
    // Shot noise would grow with the square root of the gain; the fourth root keeps the
    // slider partly absolute, as Lightroom's is, without a measured noise profile.
    noiseGain: Math.min(6, Math.max(0.5, (2 ** exposure * (iso / 100)) ** 0.25)),
    levels,
    // Chroma differences are relative to lightness (a / L, b / L).
    colorRange: [(0.03 + 0.25 * col) * colorDetail, (0.02 + 0.16 * col) * colorDetail],
  };
}

const OKLAB = /* glsl */ `
vec3 cbrt3(vec3 v) { return sign(v) * pow(abs(v), vec3(1.0 / 3.0)); }
vec3 lmsToLab(vec3 lms) {
  vec3 l = cbrt3(lms);
  return vec3(
    0.2104542553 * l.x + 0.7936177850 * l.y - 0.0040720468 * l.z,
    1.9779984951 * l.x - 2.4285922050 * l.y + 0.4505937099 * l.z,
    0.0259040371 * l.x + 0.7827717662 * l.y - 0.8086757660 * l.z);
}
vec3 labToLms(vec3 lab) {
  vec3 l = vec3(
    lab.x + 0.3963377774 * lab.y + 0.2158037573 * lab.z,
    lab.x - 0.1055613458 * lab.y - 0.0638541728 * lab.z,
    lab.x - 0.0894841775 * lab.y - 1.2914855480 * lab.z);
  return l * l * l;
}`;

// Chroma is smoothed relative to lightness: averaging a, b of a bright and a dark pixel and
// putting each back on its own lightness would desaturate the bright one.
const CHROMA_FLOOR = /* glsl */ `const float CHROMA_FLOOR = 0.04;`;

/** Linear pass output -> (OKLab L, a / L, b / L, 0). */
export const FS_NR_PREP = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uLin;
uniform mat3 uWorkToLms;
out vec4 o;
${OKLAB}
${CHROMA_FLOOR}
void main() {
  vec3 lab = lmsToLab(uWorkToLms * texelFetch(uLin, ivec2(gl_FragCoord.xy), 0).rgb);
  o = vec4(lab.x, lab.yz / max(lab.x, CHROMA_FLOOR), 0.0);
}`;

/** One pyramid level: (L, a, b, kept detail) -> the next, smoother one. */
export const FS_NR_LEVEL = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uTex;      // linear filtering: spacings are fractional in scaled views
uniform float uDil;
uniform float uLumT;
uniform float uLumRange;
uniform float uNoiseGain;
uniform float uColorGain;
uniform vec2 uColorRange;
out vec4 o;
const float K[5] = float[5](0.0625, 0.25, 0.375, 0.25, 0.0625);
void main() {
  vec2 size = vec2(textureSize(uTex, 0));
  vec4 c = texelFetch(uTex, ivec2(gl_FragCoord.xy), 0);
  // Shot noise in OKLab L falls with brightness (~ L^-1/2, midtones at L 0.6) and grows
  // with an exposure push.
  float noise = clamp(uNoiseGain * inversesqrt(max(c.x, 0.05) / 0.6), 0.25, 6.0);
  float lumT = uLumT * noise;
  float lumRange = uLumRange * noise;
  float il = -0.5 / (lumRange * lumRange);
  vec2 ic = -0.5 / (uColorRange * uColorRange);
  float sumL = 0.0, wL = 0.0, wC = 0.0;
  vec2 sumC = vec2(0.0);
  for (int j = 0; j < 5; j++) {
    for (int i = 0; i < 5; i++) {
      vec4 s = texture(uTex, (gl_FragCoord.xy + vec2(i - 2, j - 2) * uDil) / size);
      float k = K[i] * K[j];
      float dl = s.x - c.x;
      vec2 dc = s.yz - c.yz;
      float wl = k * exp(dl * dl * il);
      sumL += wl * s.x;
      wL += wl;
      float wc = k * exp(dl * dl * ic.x + dot(dc, dc) * ic.y);
      sumC += wc * s.yz;
      wC += wc;
    }
  }
  float smoothL = sumL / wL;
  // Detail at this level: kept when large (edges, texture), shrunk when small (noise).
  float d = c.x - smoothL;
  float kept = lumT > 0.0 ? d * d * d / (d * d + lumT * lumT) : d;
  o = vec4(smoothL, mix(c.yz, sumC / wC, uColorGain), c.w + kept);
}`;

/** Back to the linear pass format (linear ProPhoto, log2 luminance), original where NR is off. */
export const FS_NR_COMPOSE = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uLin;
uniform sampler2D uNr;
uniform int uLum;
uniform int uColor;
uniform mat3 uWorkToLms;
uniform mat3 uLmsToWork;
out vec4 o;
const vec3 LUMA = vec3(0.2880402, 0.7118741, 0.0000857);
${OKLAB}
${CHROMA_FLOOR}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 v = texelFetch(uLin, p, 0);
  vec4 n = texelFetch(uNr, p, 0);
  vec3 lab = lmsToLab(uWorkToLms * v.rgb);
  if (uLum == 1) lab.x = n.x + n.w;
  if (uColor == 1) lab.yz = n.yz * max(lab.x, CHROMA_FLOOR);
  vec3 lin = uLmsToWork * labToLms(lab);
  o = vec4(lin, log2(max(dot(lin, LUMA), 1e-7)));
}`;

/** Runs a noise reduction plan on the linear pass output. */
export class Denoiser {
  private ctx: GLContext;
  private prep: Program;
  private level: Program;
  private compose: Program;

  constructor(ctx: GLContext) {
    this.ctx = ctx;
    this.prep = ctx.program(FS_NR_PREP);
    this.level = ctx.program(FS_NR_LEVEL);
    this.compose = ctx.program(FS_NR_COMPOSE);
  }

  /**
   * Denoises `lin` using `a` and `b` (RGBA16F, same size) as scratch. Returns the one of
   * the two that holds the result, in the linear pass format.
   */
  run(plan: NrPlan, lin: Target, a: Target, b: Target): Target {
    const { ctx } = this;
    const gl = ctx.gl;
    for (const t of [a, b]) {
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    }
    const toLms = toGlMat3(STATIC_UNIFORMS.uWorkToLms);
    ctx.draw(this.prep, a, { uLin: lin.tex }, { uWorkToLms: toLms });
    let src = a;
    let dst = b;
    for (const lv of plan.levels) {
      ctx.draw(this.level, dst, { uTex: src.tex }, {
        uDil: lv.dilation,
        uLumT: lv.lumT,
        uLumRange: lv.lumRange,
        uNoiseGain: plan.noiseGain,
        uColorGain: lv.colorGain,
        uColorRange: plan.colorRange,
      });
      [src, dst] = [dst, src];
    }
    ctx.draw(this.compose, dst, { uLin: lin.tex, uNr: src.tex }, {
      uLum: plan.luminance ? 1 : 0,
      uColor: plan.color ? 1 : 0,
      uWorkToLms: toLms,
      uLmsToWork: toGlMat3(STATIC_UNIFORMS.uLmsToWork),
    });
    return dst;
  }
}

// ------------------------------------------------------------------ vignetting and grain

const STYLE_INDEX: Record<VignetteStyle, number> = { highlight: 1, color: 2, paint: 3 };

/** Grain cell size in full-resolution pixels for Size 0..100. */
export function grainCellSize(size: number): number {
  return 0.9 + 6 * (size / 100) ** 1.4;
}

export interface EffectsUniforms {
  /** Full-resolution output frame in pixels; [0, 0] turns the effects off (crop view). */
  uOutPx: [number, number];
  uVig: [number, number, number, number];
  uVigOpt: [number, number];
  uGrain: [number, number, number, number];
}

/**
 * Finish-pass parameters. `outPx` is the size of the full-resolution crop frame, or null
 * where post-crop effects don't apply (the crop tool shows the uncropped image).
 */
export function effectsUniforms(e: EffectsParams, outPx: [number, number] | null): EffectsUniforms {
  const on = !!outPx && (e.vignetteAmount !== 0 || e.grainAmount > 0);
  return {
    uOutPx: on ? outPx : [0, 0],
    uVig: [e.vignetteAmount / 100, e.vignetteMidpoint / 100, e.vignetteRoundness / 100, e.vignetteFeather / 100],
    uVigOpt: [STYLE_INDEX[e.vignetteStyle], e.vignetteHighlights / 100],
    // Amount: standard deviation in display units (Lightroom's 100 is very coarse).
    uGrain: [0.13 * (e.grainAmount / 100) ** 1.2, grainCellSize(e.grainSize), e.grainRoughness / 100, 0],
  };
}

/** Feather and midpoint -> where the vignette starts and is complete (radius 1 = corners). */
function vignetteEdges(midpoint: number, feather: number, aa: number): [number, number] {
  const centre = 0.25 + 0.85 * midpoint;
  const half = Math.max(0.55 * feather, aa);
  return [centre - half, centre + half];
}

/**
 * How much of the vignette applies at frame point t (0..1), CPU copy of vignetteWeight in
 * the shader. `size` = output frame in pixels (only its aspect matters).
 */
export function vignetteWeight(t: [number, number], size: [number, number], e: Pick<EffectsParams, 'vignetteMidpoint' | 'vignetteRoundness' | 'vignetteFeather'>): number {
  let ux = Math.abs(t[0] - 0.5) * 2;
  let uy = Math.abs(t[1] - 0.5) * 2;
  const round = e.vignetteRoundness / 100;
  let n = 2;
  if (round >= 0) {
    const d = Math.sqrt(0.5 * (size[0] ** 2 + size[1] ** 2));
    ux *= 1 + (size[0] / d - 1) * round;
    uy *= 1 + (size[1] / d - 1) * round;
  } else {
    n = 2 * 2 ** (-2 * round);
  }
  const r = (ux ** n + uy ** n) ** (1 / n) * 2 ** (-1 / n);
  const [lo, hi] = vignetteEdges(e.vignetteMidpoint / 100, e.vignetteFeather / 100, 2 / Math.min(size[0], size[1]));
  const x = clamp01((r - lo) / (hi - lo));
  return x * x * (3 - 2 * x);
}

/**
 * Finish-pass chunk: postCrop(enc) applies the vignette and grain to display-encoded RGB.
 * Needs the COMMON chunk (uFramePx, uTileOrigin).
 */
export const EFFECTS_GLSL = /* glsl */ `
uniform vec2 uOutPx;
uniform vec4 uVig;      // amount (-1..1), midpoint, roundness (-1..1), feather
uniform vec2 uVigOpt;   // style (1 highlight priority, 2 color priority, 3 paint overlay), highlights
uniform vec4 uGrain;    // amount (std. dev.), cell size (full-resolution px), roughness, -
const vec3 FX_LUMA = vec3(0.2126, 0.7152, 0.0722);

vec3 fxDecode(vec3 v) { return mix(v / 12.92, pow((v + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), v)); }
vec3 fxEncode(vec3 v) {
  v = clamp(v, 0.0, 1.0);
  return mix(12.92 * v, 1.055 * pow(v, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), v));
}

// Radius 1 at the corners of the crop. Roundness 0 follows the crop's aspect, +1 is a
// circle, -1 a rounded rectangle.
float vignetteWeight(vec2 t) {
  vec2 u = abs(t - 0.5) * 2.0;
  float n = 2.0;
  if (uVig.z >= 0.0) u *= mix(vec2(1.0), uOutPx / sqrt(0.5 * dot(uOutPx, uOutPx)), uVig.z);
  else n = 2.0 * exp2(-2.0 * uVig.z);
  float r = pow(pow(u.x, n) + pow(u.y, n), 1.0 / n) * exp2(-1.0 / n);
  float centre = 0.25 + 0.85 * uVig.y;
  float half_ = max(0.55 * uVig.w, 2.0 / min(uFramePx.x, uFramePx.y));
  return smoothstep(centre - half_, centre + half_, r);
}

vec3 applyVignette(vec3 enc, vec2 t) {
  float w = vignetteWeight(t) * abs(uVig.x);
  if (w <= 0.0) return enc;
  int style = int(uVigOpt.x + 0.5);
  // Paint Overlay: mixes black or white into the display colours (flattens the corners).
  if (style == 3) return mix(enc, vec3(uVig.x < 0.0 ? 0.0 : 1.0), w);
  vec3 lin = fxDecode(enc);
  // Highlight Priority works on each channel (colours may shift), Color Priority on the
  // luminance (hue kept).
  if (uVig.x > 0.0) {
    // Lighten like an exposure change (up to +4 EV), with a shoulder that keeps white white.
    float g = exp2(4.0 * w);
    if (style == 1) return fxEncode(lin * g / (1.0 + lin * (g - 1.0)));
    float y = max(dot(lin, FX_LUMA), 1e-6);
    return fxEncode(lin * (g / (1.0 + y * (g - 1.0))));
  }
  // Darken like an exposure change (up to -4 EV); Highlights keeps bright parts bright.
  float g = exp2(-4.0 * w);
  float h = uVigOpt.y;
  if (style == 1) lin *= mix(vec3(g), vec3(1.0), h * smoothstep(0.15, 1.0, lin));
  else lin *= mix(g, 1.0, h * smoothstep(0.15, 1.0, dot(lin, FX_LUMA)));
  return fxEncode(lin);
}

uint fxHash(ivec2 q, uint seed) {
  // Rotated octaves reach negative lattice points; keep them positive before the cast.
  uvec2 u = uvec2(q + 65536);
  uint h = (u.x * 0x8da6b343u) ^ (u.y * 0xd8163841u) ^ (seed * 0xcb1ab31fu);
  h ^= h >> 16u;
  h *= 0x7feb352du;
  h ^= h >> 15u;
  h *= 0x846ca68bu;
  h ^= h >> 16u;
  return h;
}

float fxGrad(ivec2 q, uint seed, vec2 f) {
  float a = float(fxHash(q, seed)) * (6.2831853 / 4294967296.0);
  return dot(vec2(cos(a), sin(a)), f);
}

// Gradient noise with unit standard deviation (raw std is ~0.216).
float fxNoise(vec2 x, uint seed) {
  vec2 i = floor(x);
  vec2 f = x - i;
  ivec2 q = ivec2(i);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = fxGrad(q, seed, f);
  float b = fxGrad(q + ivec2(1, 0), seed, f - vec2(1.0, 0.0));
  float c = fxGrad(q + ivec2(0, 1), seed, f - vec2(0.0, 1.0));
  float d = fxGrad(q + ivec2(1, 1), seed, f - vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 4.6;
}

// One grain octave of cell size c at full-resolution position p, seen through a render
// pixel covering fp full-resolution pixels: finer cells than the pixel are replaced by
// noise at the pixel's scale, with the strength a box average of the fine grain would keep.
float grainOctave(vec2 p, float c, float fp, mat2 rot, vec2 off, uint seed) {
  if (fp <= 1.0) return fxNoise(rot * p / c + off, seed);
  float k = 1.4 / c;
  float att = sqrt((1.0 + k * k) / (1.0 + k * k * fp * fp));
  return fxNoise(rot * p / max(c, fp) + off, seed) * att;
}

vec3 applyGrain(vec3 enc, vec2 p, float fp) {
  float c = uGrain.y;
  float r = uGrain.z;
  float n0 = grainOctave(p, c, fp, mat2(1.0, 0.0, 0.0, 1.0), vec2(0.0), 1u);
  float n1 = grainOctave(p, 1.9 * c, fp, mat2(0.8, 0.6, -0.6, 0.8), vec2(17.31, 5.13), 2u);
  // Roughness: a coarser octave and clumping (strength varying over a larger scale).
  float m = grainOctave(p, 4.3 * c, fp, mat2(0.28, -0.96, 0.96, 0.28), vec2(3.71, 11.93), 3u);
  float g = mix(n0, 0.55 * n0 + 0.85 * n1, r) * (1.0 + 0.6 * r * m) / (1.0 + 0.2 * r);
  // Mostly in the midtones, like film; luminance only.
  float y = dot(enc, FX_LUMA);
  float k = 0.35 + 0.65 * (1.0 - (2.0 * y - 1.0) * (2.0 * y - 1.0));
  return enc + uGrain.x * k * g;
}

// Vignette and grain at this pixel; positions are in the full-resolution crop frame.
vec3 postCrop(vec3 enc) {
  vec2 px = uTileOrigin + gl_FragCoord.xy;
  vec2 fp = uOutPx / uFramePx;
  if (uVig.x != 0.0) enc = applyVignette(enc, px / uFramePx);
  if (uGrain.x > 0.0) enc = applyGrain(enc, px * fp, fp.x);
  return enc;
}
`;
