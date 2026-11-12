// GLSL ES 3.00 sources.
//
// Convention for every pass that renders into a texture: texel row y holds image row y
// counted from the TOP (row 0 = v 0 = first uploaded row). Only the final present pass,
// which draws to the canvas, flips vertically.
//
// Passes per render (preview or export tile):
//   linear  : source -> scene-linear ProPhoto + log2 luminance      (FS_LINEAR)
//   nr      : luminance and colour noise reduction (effects.ts), when on
//   blurL x2: fine-scale Gaussian of log luminance (texture/clarity) (FS_BLUR_L)
//   tone    : local tone, clarity, texture, profile look, presence, colour mixer,
//             profile tone, colour grading, tone curve               (FS_TONE)
//   blur x2 + finish: sharpening, post-crop vignetting and grain     (FS_BLUR, FS_FINISH)
// The analysis (guided-filter coefficients, dehaze) runs at low resolution, cached.
import { EFFECTS_GLSL } from './effects.ts';

export const VS_FULLSCREEN = /* glsl */ `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/** RGB16UI source -> RGBA16F, box-averaged by uScale source pixels per output pixel. */
export const FS_PREPARE = /* glsl */ `#version 300 es
precision highp float;
precision highp usampler2D;
uniform usampler2D uSrc;
uniform vec2 uScale;
out vec4 o;
void main() {
  ivec2 size = textureSize(uSrc, 0);
  vec2 p0 = floor(gl_FragCoord.xy - 0.5) * uScale;
  ivec2 base = ivec2(floor(p0));
  int n = max(1, int(ceil(uScale.x - 1e-4)));
  int m = max(1, int(ceil(uScale.y - 1e-4)));
  vec3 acc = vec3(0.0);
  float cnt = 0.0;
  for (int y = 0; y < 8; y++) {
    if (y >= m) break;
    for (int x = 0; x < 8; x++) {
      if (x >= n) break;
      ivec2 t = clamp(base + ivec2(x, y), ivec2(0), size - 1);
      acc += vec3(texelFetch(uSrc, t, 0).rgb);
      cnt += 1.0;
    }
  }
  o = vec4(acc / (cnt * 65535.0), 1.0);
}`;

const COMMON = /* glsl */ `
uniform sampler2D uSrc;      // camera RGB 0..1, as-shot WB, max-normalised (RGBA16F)
uniform mat3 uGeom;          // output t -> source s (both normalised, y down)
uniform vec4 uSrcRect;       // part of the source this texture covers: origin.xy, size.zw
uniform vec2 uSrcTexScale;   // share of the texture that region fills (export tiles reuse one big texture)
uniform vec2 uFramePx;       // full output frame size in pixels at this render scale
uniform vec2 uTileOrigin;    // top-left of this render target inside the frame, pixels
uniform int uClampT;         // export: repeat edge pixels instead of rendering outside the frame
uniform int uBlankWhite;     // 1: areas the (transformed) image doesn't cover are white, as in Lightroom
uniform vec3 uWb;            // per-channel gain: max/min compensation x user/as-shot ratio
uniform vec3 uClip;          // per-channel clip level after uWb
uniform mat3 uCamToWork;     // white-balanced camera RGB -> linear ProPhoto
uniform float uExposure;     // linear gain
uniform int uDehazeMode;     // 1 when the haze map and airlight below are available
uniform sampler2D uTrans;    // haze density (1 - transmission at full strength), analysis resolution, frame coordinates
uniform vec3 uAir;           // airlight (haze colour)
uniform float uDehaze;       // global Dehaze, -1..1
// Lens corrections (see lens.ts for the mapping).
uniform int uLensOn;
uniform float uLensZoom;
uniform float uManualDist;
uniform vec2 uManualScale;
uniform int uGeoOn;
uniform vec2 uGeoCenter;
uniform vec2 uGeoScale;
uniform float uGeoR[7];
uniform float uGeoG[7];
uniform float uGeoB[7];
uniform int uCaOn;
uniform vec2 uCaCenter;
uniform vec2 uCaScale;
uniform float uCaR[7];
uniform float uCaB[7];
uniform int uVigOn;
uniform vec2 uVigCenter;
uniform vec2 uVigScale;
uniform float uVigK[5];
uniform int uVigDivide;
uniform float uVigAmount;
uniform vec2 uManualVig;     // EV at the corners, falloff start radius

const vec3 LUMA = vec3(0.2880402, 0.7118741, 0.0000857); // ProPhoto Y
const float MID = -2.4739312; // log2(0.18)

vec2 frameT() {
  vec2 t = (uTileOrigin + gl_FragCoord.xy) / uFramePx;
  if (uClampT == 1) t = clamp(t, 0.5 / uFramePx, 1.0 - 0.5 / uFramePx);
  return t;
}

// uGeom is projective once the Transform panel is used.
vec2 geomMap(vec2 t) {
  vec3 h = uGeom * vec3(t, 1.0);
  return h.xy / h.z;
}

bool insideImage(vec2 t) {
  vec2 s = geomMap(t);
  return s.x >= 0.0 && s.y >= 0.0 && s.x <= 1.0 && s.y <= 1.0;
}

vec2 srcTex(vec2 s) { return (s - uSrcRect.xy) / uSrcRect.zw * uSrcTexScale; }

// Gradients of the source texture coordinate per output pixel, for the mip level of the
// (mipmapped) preview. Worked out from the geometry rather than with dFdx/dFdy: the GPU's own
// derivatives are unreliable where a 2x2 pixel block sticks out of the render target (an odd
// view height) or after the early return outside the image, and gave the photo's last row the
// wrong mip level, a darker line when zoomed out. (Lens distortion is left out: it hardly
// changes the scale.)
vec2 gSrcDx;
vec2 gSrcDy;
void srcGradients(vec2 t) {
  vec3 h = uGeom * vec3(t, 1.0);
  // s = h.xy / h.z; columns 0 and 1 of uGeom are dh/dt.x and dh/dt.y.
  vec2 sx = (uGeom[0].xy * h.z - h.xy * uGeom[0].z) / (h.z * h.z);
  vec2 sy = (uGeom[1].xy * h.z - h.xy * uGeom[1].z) / (h.z * h.z);
  vec2 k = uSrcTexScale / uSrcRect.zw;
  gSrcDx = sx * k / uFramePx.x;
  gSrcDy = sy * k / uFramePx.y;
}
vec4 srcAt(vec2 s) { return textureGrad(uSrc, srcTex(s), gSrcDx, gSrcDy); }

float evalPoly(float c[7], float r) {
  return r * (c[0] + r * (c[1] + r * (c[2] + r * (c[3] + r * (c[4] + r * (c[5] + r * c[6]))))));
}

vec2 radialMap(vec2 s, vec2 center, vec2 scale, float c[7]) {
  float r = length((s - center) * scale);
  return r < 1e-9 ? s : center + (s - center) * (evalPoly(c, r) / r);
}

// Where ideal source point s lies in the decoded image (green channel): what AI masks, which
// are computed from the decoded image, are looked up with. Same mapping as sampleLens.
vec2 lensPoint(vec2 s) {
  if (uLensOn == 0) return s;
  vec2 si = 0.5 + (s - 0.5) / uLensZoom;
  float rm = length((si - 0.5) * uManualScale);
  if (uManualDist != 0.0) si = 0.5 + (si - 0.5) * (1.0 + uManualDist * rm * rm);
  return uGeoOn == 1 ? radialMap(si, uGeoCenter, uGeoScale, uGeoG) : si;
}

// Camera RGB at ideal source point s, with the lens corrections; gain = vignetting.
vec3 sampleLens(vec2 s, out float gain) {
  gain = 1.0;
  if (uLensOn == 0) return srcAt(s).rgb;
  vec2 si = 0.5 + (s - 0.5) / uLensZoom;
  vec2 d = (si - 0.5) * uManualScale;
  float rm = length(d);
  if (uManualDist != 0.0) si = 0.5 + (si - 0.5) * (1.0 + uManualDist * rm * rm);
  vec2 sr = si, sg = si, sb = si;
  if (uGeoOn == 1) {
    sr = radialMap(si, uGeoCenter, uGeoScale, uGeoR);
    sg = radialMap(si, uGeoCenter, uGeoScale, uGeoG);
    sb = radialMap(si, uGeoCenter, uGeoScale, uGeoB);
  }
  if (uCaOn == 1) {
    sr = radialMap(sr, uCaCenter, uCaScale, uCaR);
    sb = radialMap(sb, uCaCenter, uCaScale, uCaB);
  }
  vec3 cam = vec3(srcAt(sr).r, srcAt(sg).g, srcAt(sb).b);
  if (uVigOn == 1) {
    vec2 v = (sg - uVigCenter) * uVigScale;
    float r2 = dot(v, v);
    float g = max(1.0 + r2 * (uVigK[0] + r2 * (uVigK[1] + r2 * (uVigK[2] + r2 * (uVigK[3] + r2 * uVigK[4])))), 0.05);
    // Capped: far corners can need huge gains that would only amplify noise.
    gain = clamp(pow(g, uVigDivide == 1 ? -uVigAmount : uVigAmount), 0.125, 6.0);
  }
  if (uManualVig.x != 0.0) gain *= exp2(uManualVig.x * smoothstep(uManualVig.y, 1.0, rm));
  return cam;
}

// Scene-linear ProPhoto with exposure applied (no dehaze yet).
vec3 developBase(vec2 t) {
  vec2 s = geomMap(t);
  float gain;
  vec3 cam = sampleLens(s, gain) * uWb;
  // Highlight reconstruction: as any channel nears its clip level, blend towards a
  // neutral at the brightest channel. Keeps clipped areas white and smooth, and leaves
  // headroom above 1.0 for the Highlights/Whites sliders.
  vec3 r = cam / uClip;
  float m = smoothstep(0.82, 1.0, max(r.r, max(r.g, r.b)));
  float peak = max(cam.r, max(cam.g, cam.b));
  cam = mix(cam, vec3(peak), m) * gain;
  return (uCamToWork * cam) * uExposure;
}

// Dehaze by the dark channel prior: positive amounts remove haze with the transmission map,
// negative ones add a veil of the haze colour.
vec3 applyDehaze(vec3 lin, vec2 t, float amount) {
  if (uDehazeMode != 1 || amount == 0.0) return lin;
  if (amount > 0.0) {
    float tr = max(1.0 - min(amount, 1.0) * texture(uTrans, t).r, 0.1);
    return max((lin - uAir) / tr + uAir, 0.0);
  }
  return mix(lin, uAir, min(-amount, 1.0) * 0.4);
}

vec3 developInput(vec2 t) { return applyDehaze(developBase(t), t, uDehaze); }

// ---- Masks (local adjustments); see masks.ts for the packing.
#define MAX_COMP 24
#define MAX_MASK 8
uniform int uMaskCount;
uniform int uCompCount;
#define MAX_COLOR_SAMPLES 16
uniform ivec4 uCompInfo[MAX_COMP]; // kind (1 linear, 2 radial, 3 luminance, 4 brush, 5 colour, 6 AI), mode (0 add, 1 subtract, 2 intersect), mask slot, invert
uniform vec4 uCompA[MAX_COMP];
uniform vec4 uCompB[MAX_COMP];
uniform vec2 uMaskFrame;           // source s -> mask frame
uniform vec4 uMaskTone[MAX_MASK];  // shadows, highlights, whites, blacks
uniform vec4 uMaskE[MAX_MASK];     // exposure (EV), contrast, clarity, texture
uniform vec4 uMaskC[MAX_MASK];     // temp, tint, saturation, hue (radians)
uniform vec4 uMaskD[MAX_MASK];     // dehaze, sharpness, colour overlay a, b
uniform sampler2D uBrush;          // brush coverage maps, packed (brush.ts)
uniform sampler2D uAiMask;         // AI selection maps in decoded-image coordinates, packed
uniform mat3 uMaskLms;             // working space -> OKLab LMS, for colour ranges
uniform vec4 uColorSamples[MAX_COLOR_SAMPLES]; // sampled colours: OKLab a/L, b/L

// Colour range feature: OKLab chroma divided by lightness (doesn't change with exposure),
// and the lightness itself.
vec3 maskChroma(vec3 lin) {
  vec3 l = pow(max(uMaskLms * lin, vec3(1e-9)), vec3(1.0 / 3.0));
  float L = 0.2104542553 * l.x + 0.7936177850 * l.y - 0.0040720468 * l.z;
  float A = 1.9779984951 * l.x - 2.4285922050 * l.y + 0.4505937099 * l.z;
  float B = 0.0259040371 * l.x + 0.7827717662 * l.y - 0.8086757660 * l.z;
  return vec3(vec2(A, B) / max(L, 1e-4), L);
}

// Display lightness 0..1 for a log2 scene luminance (what luminance range masks select on).
float maskLum(float L) {
  float y = exp2(L);
  y = clamp(y * (1.0 + y / 2.25) / (1.0 + y), 0.0, 1.0);
  return y <= 0.0031308 ? 12.92 * y : 1.055 * pow(y, 1.0 / 2.4) - 0.055;
}

float componentWeight(int i, vec2 s, vec2 m, float lum, vec3 chroma) {
  ivec4 info = uCompInfo[i];
  vec4 a = uCompA[i];
  vec4 b = uCompB[i];
  float w = 0.0;
  if (info.x == 1) {
    vec2 d = a.zw - a.xy;
    w = 1.0 - smoothstep(0.0, 1.0, dot(m - a.xy, d) / max(dot(d, d), 1e-12));
  } else if (info.x == 2) {
    vec2 q = m - a.xy;
    vec2 r = vec2(q.x * b.x + q.y * b.y, -q.x * b.y + q.y * b.x) * a.zw;
    w = 1.0 - smoothstep(b.z, max(1.0, b.z + 0.002), length(r));
  } else if (info.x == 3) {
    float lo = a.x < 0.001 ? 1.0 : smoothstep(a.x - a.z, a.x, lum);
    float hi = a.y > 0.999 ? 1.0 : 1.0 - smoothstep(a.y, a.y + a.z, lum);
    w = lo * hi;
  } else if (info.x == 4) {
    // a: the map's place in the atlas (origin, size); b: half a texel, to stay inside it.
    if (s.x >= 0.0 && s.y >= 0.0 && s.x <= 1.0 && s.y <= 1.0) {
      vec2 uv = clamp(a.xy + s * a.zw, a.xy + b.xy, a.xy + a.zw - b.xy);
      w = texture(uBrush, uv).r;
    }
  } else if (info.x == 5) {
    // a: first sample, sample count, distance at which the selection has faded out.
    float d = 1e9;
    for (int j = 0; j < MAX_COLOR_SAMPLES; j++) {
      if (j < int(a.x) || j >= int(a.x) + int(a.y)) continue;
      d = min(d, distance(chroma.xy, uColorSamples[j].xy));
    }
    // Near black the colour of a pixel is mostly noise.
    w = (1.0 - smoothstep(0.45 * a.z, a.z, d)) * smoothstep(0.03, 0.1, chroma.z);
  } else if (info.x == 6) {
    // a: the map's place in the atlas; b: half a texel. The map covers the decoded image,
    // so it is looked up through the lens corrections and stays on the content.
    vec2 p = lensPoint(s);
    if (p.x >= 0.0 && p.y >= 0.0 && p.x <= 1.0 && p.y <= 1.0) {
      vec2 uv = clamp(a.xy + p * a.zw, a.xy + b.xy, a.xy + a.zw - b.xy);
      w = texture(uAiMask, uv).r;
    }
  }
  return info.w == 1 ? 1.0 - w : w;
}

// Weight of every mask slot at frame point t.
// lin: the pixel's colour in the working space (any exposure), for colour ranges.
void maskWeights(vec2 t, float lum, vec3 lin, out float w[MAX_MASK]) {
  for (int k = 0; k < MAX_MASK; k++) w[k] = 0.0;
  vec2 s = geomMap(t);
  vec2 m = s * uMaskFrame;
  vec3 chroma = maskChroma(lin);
  for (int i = 0; i < MAX_COMP; i++) {
    if (i >= uCompCount) break;
    float c = componentWeight(i, s, m, lum, chroma);
    int k = uCompInfo[i].z;
    int mode = uCompInfo[i].y;
    if (mode == 0) w[k] = max(w[k], c);
    else if (mode == 1) w[k] *= 1.0 - c;
    else w[k] *= c;
  }
}
`;

/** Scene-linear colour (rgb) and log2 luminance (a). Outside the image: grey. */
export const FS_LINEAR = /* glsl */ `#version 300 es
precision highp float;
${COMMON}
uniform int uMaskDehaze;     // 1 when a mask uses Dehaze
out vec4 o;
void main() {
  vec2 t = frameT();
  srcGradients(t);
  if (!insideImage(t)) { o = vec4(0.18, 0.18, 0.18, MID); return; }
  vec3 lin = developBase(t);
  float amount = uDehaze;
  if (uMaskDehaze == 1) {
    float w[MAX_MASK];
    maskWeights(t, maskLum(log2(max(dot(lin, LUMA), 1e-7))), lin, w);
    for (int k = 0; k < MAX_MASK; k++) {
      if (k >= uMaskCount) break;
      amount += w[k] * uMaskD[k].x;
    }
  }
  lin = applyDehaze(lin, t, amount);
  o = vec4(lin, log2(max(dot(lin, LUMA), 1e-7)));
}`;

/** Low-resolution (L, L²) for the guided filter. */
export const FS_ANALYSIS = /* glsl */ `#version 300 es
precision highp float;
${COMMON}
out vec4 o;
void main() {
  vec2 t = frameT();
  srcGradients(t);
  float L = insideImage(t) ? log2(max(dot(developInput(t), LUMA), 1e-7)) : MID;
  o = vec4(L, L * L, 0.0, 1.0);
}`;

/** Separable box filter on RGBA32F (texelFetch, clamped at the edges). */
export const FS_BOX = /* glsl */ `#version 300 es
precision highp float;
uniform highp sampler2D uTex;
uniform ivec2 uDir;
uniform int uRadius;
out vec4 o;
void main() {
  ivec2 size = textureSize(uTex, 0);
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 acc = vec4(0.0);
  for (int k = -64; k <= 64; k++) {
    if (k < -uRadius) continue;
    if (k > uRadius) break;
    acc += texelFetch(uTex, clamp(p + uDir * k, ivec2(0), size - 1), 0);
  }
  o = acc / float(2 * uRadius + 1);
}`;

/** Guided filter coefficients from box means of (L, L²). */
export const FS_GUIDED_COEF = /* glsl */ `#version 300 es
precision highp float;
uniform highp sampler2D uMeans;
uniform float uEps;
out vec4 o;
void main() {
  vec4 m = texelFetch(uMeans, ivec2(gl_FragCoord.xy), 0);
  float varL = max(m.g - m.r * m.r, 0.0);
  float a = varL / (varL + uEps);
  o = vec4(a, m.r - a * m.r, 0.0, 1.0);
}`;

/** Separable Gaussian of one channel (uChannel 3 = alpha of the linear pass, 0 = red). */
export const FS_BLUR_L = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform ivec2 uDir;
uniform float uSigma;
uniform int uChannel;
out vec4 o;
void main() {
  ivec2 size = textureSize(uTex, 0);
  ivec2 p = ivec2(gl_FragCoord.xy);
  float sg = max(uSigma, 0.05);
  int r = min(64, int(ceil(3.0 * sg)));
  float acc = 0.0;
  float wsum = 0.0;
  for (int k = -64; k <= 64; k++) {
    if (k < -r) continue;
    if (k > r) break;
    vec4 v = texelFetch(uTex, clamp(p + uDir * k, ivec2(0), size - 1), 0);
    float w = exp(-float(k * k) / (2.0 * sg * sg));
    acc += (uChannel == 3 ? v.a : v.r) * w;
    wsum += w;
  }
  o = vec4(acc / wsum, 0.0, 0.0, 1.0);
}`;

/**
 * Local tone, clarity, texture, presence, Color Mixer / B&W, profile, Color Grading and
 * tone curve -> display sRGB.
 */
export const FS_TONE = /* glsl */ `#version 300 es
precision highp float;
${COMMON}
uniform sampler2D uLin;       // linear pass output (same size as this target)
uniform sampler2D uBlurL;     // fine-scale blurred log luminance (r)
uniform int uUseBlurL;
uniform highp sampler2D uABLow; // guided-filter coefficients, large radius (base for tone)
uniform highp sampler2D uABMid; // guided-filter coefficients, medium radius (clarity)
uniform sampler2D uLut;       // tone curve, 4096x1, per channel
uniform int uCurve;
uniform vec4 uTone;           // shadows, highlights, whites, blacks (-1..1)
uniform float uContrast;      // -1..1
uniform vec2 uPresence;       // vibrance, saturation (-1..1)
uniform vec2 uDetailBands;    // clarity, texture (-1..1)
uniform int uProfile;         // base tone: 0 color, 1 neutral, 2 linear, 3 monochrome (color/profiles.ts)
uniform mat3 uWorkToLms;      // linear ProPhoto -> OKLab LMS
uniform mat3 uLmsToWork;
uniform mat3 uWorkToSrgb;     // linear ProPhoto -> linear sRGB
uniform mat3 uSrgbToLms;      // linear sRGB -> OKLab LMS (colour grading works on display colours)
uniform mat3 uLmsToSrgb;
uniform float uShadowTint;    // calibration: -1 green .. +1 magenta, in the shadows
uniform int uMixer;           // 1 when any Color Mixer band is set (colour profiles)
uniform int uBwMix;           // 1 when any B&W band is set (monochrome)
uniform float uBandHue[8];    // band centres, OKLab hue in radians, ascending
uniform float uMixHue[8];     // hue shift per band, radians
uniform float uMixSat[8];     // chroma gain - 1 per band
uniform float uMixLum[8];     // lightness change per band, -1..1
uniform float uBw[8];         // B&W mix per band, -1..1
uniform int uGrading;         // 1 when any colour grading wheel is set
uniform vec2 uGradeAB[4];     // OKLab (a, b) offsets: shadows, midtones, highlights, global
uniform vec4 uGradeLum;       // OKLab lightness offsets, same order
uniform vec2 uGradeShape;     // tone where shadows meet highlights, weight exponent
uniform vec4 uDefringe;       // purple amount, green amount (0..1), -, enabled
uniform vec4 uDefringeHue;    // purple from/to, green from/to (OKLab hue, radians)
uniform int uOverlay;         // mask slot whose overlay is shown, -1 for none
uniform vec3 uOverlayColor;
// Profile look (color/profiles.ts, color/dcp.ts). All off for Color, Neutral, Linear, Monochrome.
uniform int uLook;            // 1: apply the hue/saturation/value look table
uniform float uLookAmount;    // profile Amount (1 = as in the table)
uniform int uLookSrgb;        // the table's value axis is sRGB-encoded
uniform highp sampler3D uLookTable; // x saturation, y hue (wraps), z value: hue shift (deg), sat scale, val scale
uniform int uProfileCurve;    // 1: the profile's own tone curve
uniform float uProfileCurveAmount;
uniform float uProfileCurveMax; // scene value at the end of the curve texture
uniform highp sampler2D uProfileCurveTex; // r: curve output at x = max * u^2
uniform int uSCurveCustom;    // 1: display S-curve strength from uSCurve, else Color's 0.25
uniform float uSCurve;
uniform int uFilmLut;         // 1: display-space 3D LUT after the tone curve
uniform float uFilmLutAmount;
uniform highp sampler3D uFilmLutTex; // display sRGB -> sRGB, red along x
out vec4 o;

const float TAU = 6.2831853;

vec2 sampleAB(highp sampler2D tex, vec2 t) {
  ivec2 size = textureSize(tex, 0);
  vec2 p = t * vec2(size) - 0.5;
  ivec2 i = ivec2(floor(p));
  vec2 f = p - floor(p);
  ivec2 mx = size - 1;
  vec2 a = texelFetch(tex, clamp(i, ivec2(0), mx), 0).rg;
  vec2 b = texelFetch(tex, clamp(i + ivec2(1, 0), ivec2(0), mx), 0).rg;
  vec2 c = texelFetch(tex, clamp(i + ivec2(0, 1), ivec2(0), mx), 0).rg;
  vec2 d = texelFetch(tex, clamp(i + ivec2(1, 1), ivec2(0), mx), 0).rg;
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// Tone controls act on the local base layer, in stops relative to middle grey.
// tone = shadows, highlights, whites, blacks: the global sliders plus any masks.
float toneBase(float B, vec4 tone, float contrast) {
  float x = B - MID;
  x *= max(1.0 + 0.55 * contrast, 0.05);
  float ws = (1.0 - smoothstep(-5.0, 0.5, x)) * smoothstep(-11.0, -6.0, x);
  x += tone.x * 1.6 * ws;
  float wh = smoothstep(-0.5, 2.5, x);
  x += tone.y * 1.6 * wh;
  float ww = smoothstep(0.5, 3.0, x);
  x += tone.z * 1.0 * ww;
  float wb = 1.0 - smoothstep(-9.0, -3.5, x);
  x += tone.w * 1.5 * wb;
  return x + MID;
}

// Scales a detail band; the soft limit keeps strong edges from overshooting into halos.
float boost(float band, float gain) {
  float d = band * gain;
  return band + d / (1.0 + abs(d) * 1.5);
}

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
}

vec3 toOklab(vec3 lin) { return lmsToLab(uWorkToLms * lin); }
vec3 fromOklab(vec3 lab) { return uLmsToWork * labToLms(lab); }

// Value of a per-band setting at OKLab hue h: neighbouring bands blend smoothly
// (matches bandWeights() in color/look.ts).
float bandValue(float v[8], float h) {
  float h0 = uBandHue[0];
  float x = h0 + mod(h - h0, TAU);
  for (int i = 0; i < 8; i++) {
    float a = uBandHue[i];
    float b = i == 7 ? h0 + TAU : uBandHue[i + 1];
    if (x <= b) return mix(v[i], v[(i + 1) % 8], smoothstep(a, b, x));
  }
  return v[0];
}

// Filmic shoulder (extended Reinhard) with white point w: 1.0 at x = w.
float shoulder(float x, float w) { return x * (1.0 + x / (w * w)) / (1.0 + x); }

// The profile's own tone curve (a DNG ProfileToneCurve), sampled densely in the shadows.
float profileCurve(float x) {
  float n = float(textureSize(uProfileCurveTex, 0).x);
  float u = sqrt(clamp(x / uProfileCurveMax, 0.0, 1.0));
  return textureLod(uProfileCurveTex, vec2(u * (n - 1.0) / n + 0.5 / n, 0.5), 0.0).r;
}

float baseCurve(float x) {
  if (uProfile == 2) return x;
  float y = shoulder(max(x, 0.0), uProfile == 1 ? 1.8 : 1.5);
  // Look-based profiles: blend toward their own curve by the profile Amount.
  if (uProfileCurve == 1) y = clamp(mix(y, profileCurve(x), uProfileCurveAmount), 0.0, 1.0);
  return y;
}

// DNG-style hue-preserving RGB tone: curve the max and min channels, interpolate the middle.
vec3 rgbTone(vec3 c) {
  float hi = max(c.r, max(c.g, c.b));
  float lo = min(c.r, min(c.g, c.b));
  float hi2 = baseCurve(hi);
  float lo2 = baseCurve(lo);
  vec3 k = (hi - lo) > 1e-7 ? (c - lo) / (hi - lo) : vec3(0.0);
  return lo2 + (hi2 - lo2) * k;
}

float encodeSrgb(float v) {
  v = clamp(v, 0.0, 1.0);
  return v <= 0.0031308 ? 12.92 * v : 1.055 * pow(v, 1.0 / 2.4) - 0.055;
}

float decodeSrgb(float v) {
  return v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4);
}

// DNG "hexcone" HSV (dng_utils.h): hue 0..6 (0 red, 2 green, 4 blue), saturation, value.
vec3 dngHsv(vec3 c) {
  float v = max(c.r, max(c.g, c.b));
  float gap = v - min(c.r, min(c.g, c.b));
  if (gap <= 0.0) return vec3(0.0, 0.0, v);
  float h;
  if (c.r == v) {
    h = (c.g - c.b) / gap;
    if (h < 0.0) h += 6.0;
  } else if (c.g == v) {
    h = 2.0 + (c.b - c.r) / gap;
  } else {
    h = 4.0 + (c.r - c.g) / gap;
  }
  return vec3(h, gap / v, v);
}

vec3 dngRgb(vec3 hsv) {
  float s = hsv.y;
  float v = hsv.z;
  if (s <= 0.0) return vec3(v);
  float h = mod(hsv.x, 6.0);
  float i = min(floor(h), 5.0);
  float f = h - i;
  float p = v * (1.0 - s);
  float q = v * (1.0 - s * f);
  float t = v * (1.0 - s * (1.0 - f));
  if (i < 0.5) return vec3(v, t, p);
  if (i < 1.5) return vec3(q, v, p);
  if (i < 2.5) return vec3(p, v, t);
  if (i < 3.5) return vec3(p, q, v);
  if (i < 4.5) return vec3(t, p, v);
  return vec3(v, p, q);
}

// Profile look table on linear ProPhoto: DNG ProfileLookTable as in the DNG SDK's
// RefBaselineHueSatMap. Sampling at texel centres makes the hardware's trilinear filtering
// the SDK's interpolation (hue wraps). Mirrors applyLookCpu() in color/dcp.ts: negative
// (out-of-gamut) parts pass through, and the value change is a gain so values above 1 keep
// their headroom.
vec3 applyLook(vec3 c) {
  vec3 neg = min(c, 0.0);
  vec3 hsv = dngHsv(c - neg);
  if (hsv.z <= 0.0) return c;
  float vc = min(hsv.z, 1.0);
  float ve = uLookSrgb == 1 ? encodeSrgb(vc) : vc;
  vec3 n = vec3(textureSize(uLookTable, 0)); // (saturation, hue, value) divisions
  vec3 coord = vec3((hsv.y * (n.x - 1.0) + 0.5) / n.x, hsv.x / 6.0 + 0.5 / n.y, (ve * (n.z - 1.0) + 0.5) / n.z);
  vec3 d = textureLod(uLookTable, coord, 0.0).rgb;
  float h = hsv.x + d.x * uLookAmount * (6.0 / 360.0);
  float s = min(hsv.y * max(1.0 + (d.y - 1.0) * uLookAmount, 0.0), 1.0);
  float vs = max(1.0 + (d.z - 1.0) * uLookAmount, 0.0);
  float gain = uLookSrgb == 1 ? decodeSrgb(min(ve * vs, 1.0)) / max(vc, 1e-9) : vs;
  return dngRgb(vec3(h, s, hsv.z * gain)) + neg;
}

// Lightroom's Color Grading on display colours: shadow, midtone and highlight wheels
// weighted by lightness, plus the global wheel. Pure black stays neutral.
vec3 colorGrade(vec3 enc) {
  vec3 lab = lmsToLab(uSrgbToLms * vec3(decodeSrgb(enc.r), decodeSrgb(enc.g), decodeSrgb(enc.b)));
  float y = clamp(lab.x, 0.0, 1.0);
  float p = uGradeShape.x;
  float t = y < p ? 0.5 * y / p : 0.5 + 0.5 * (y - p) / (1.0 - p);
  float ws = pow(1.0 - t, uGradeShape.y);
  float wh = pow(t, uGradeShape.y);
  float wm = max(1.0 - ws - wh, 0.0);
  float fade = smoothstep(0.0, 0.1, y);
  lab.yz += (ws * uGradeAB[0] + wm * uGradeAB[1] + wh * uGradeAB[2] + uGradeAB[3]) * fade;
  lab.x += dot(vec4(ws, wm, wh, 1.0), uGradeLum) * fade;
  vec3 lin = clamp(uLmsToSrgb * labToLms(lab), 0.0, 1.0);
  return vec3(encodeSrgb(lin.r), encodeSrgb(lin.g), encodeSrgb(lin.b));
}

// Mask colour swatch: tints display colours in OKLab, keeping lightness.
vec3 localColor(vec3 enc, vec2 ab) {
  vec3 lab = lmsToLab(uSrgbToLms * vec3(decodeSrgb(enc.r), decodeSrgb(enc.g), decodeSrgb(enc.b)));
  lab.yz += ab * smoothstep(0.0, 0.1, lab.x);
  vec3 lin = clamp(uLmsToSrgb * labToLms(lab), 0.0, 1.0);
  return vec3(encodeSrgb(lin.r), encodeSrgb(lin.g), encodeSrgb(lin.b));
}

// 1 inside the hue range from..to (radians, may wrap), fading out just beyond it.
float hueRange(float h, float from, float to) {
  float width = mod(to - from, TAU);
  float centre = from + 0.5 * width;
  float dist = abs(mod(h - centre + 3.14159265, TAU) - 3.14159265);
  return 1.0 - smoothstep(0.5 * width, 0.5 * width + 0.2, dist);
}

// How strong an edge is around this pixel (Defringe only touches colour next to edges).
float edgeStrength(float L) {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 mx = textureSize(uLin, 0) - 1;
  float e = 0.0;
  for (int y = -2; y <= 2; y += 2) {
    for (int x = -2; x <= 2; x += 2) {
      e = max(e, abs(texelFetch(uLin, clamp(p + ivec2(x, y), ivec2(0), mx), 0).a - L));
    }
  }
  // Fringes sit on edges of high or modest contrast (thin struts against a bright sky).
  return smoothstep(0.15, 0.8, e);
}

float lut(float v, int ch) {
  float u = clamp(v, 0.0, 1.0) * (4095.0 / 4096.0) + 0.5 / 4096.0;
  return texture(uLut, vec2(u, 0.5))[ch];
}

void main() {
  vec2 t = frameT();
  if (!insideImage(t)) { o = uBlankWhite == 1 ? vec4(1.0) : vec4(0.0); return; }
  vec4 v = texelFetch(uLin, ivec2(gl_FragCoord.xy), 0);
  vec3 lin = v.rgb;
  float L = v.a;
  float fringe = uDefringe.w > 0.5 ? edgeStrength(L) : 0.0;

  // Bands, coarse to fine: tone base | clarity band | mid band | fine (texture) band.
  vec2 abL = sampleAB(uABLow, t);
  vec2 abM = sampleAB(uABMid, t);
  float BL = abL.x * L + abL.y;
  float BM = abM.x * L + abM.y;
  float G = uUseBlurL == 1 ? texelFetch(uBlurL, ivec2(gl_FragCoord.xy), 0).r : L;

  // Local adjustments: every mask's sliders, weighted by the mask at this pixel.
  vec4 lTone = vec4(0.0), lE = vec4(0.0), lC = vec4(0.0), lD = vec4(0.0);
  float overlay = 0.0;
  if (uMaskCount > 0) {
    float w[MAX_MASK];
    maskWeights(t, maskLum(L), lin, w);
    for (int k = 0; k < MAX_MASK; k++) {
      if (k >= uMaskCount) break;
      lTone += w[k] * uMaskTone[k];
      lE += w[k] * uMaskE[k];
      lC += w[k] * uMaskC[k];
      lD += w[k] * uMaskD[k];
    }
    if (uOverlay >= 0) overlay = w[uOverlay];
  }
  if (lE.x != 0.0) {
    // Local exposure shifts every band equally (masks are smooth at the bands' scale).
    lin *= exp2(lE.x);
    L += lE.x;
    BL += lE.x;
    BM += lE.x;
    G += lE.x;
  }
  if (lC.x != 0.0 || lC.y != 0.0) {
    // Local temperature (blue-yellow) and tint (green-magenta), brightness kept.
    vec3 shifted = uLmsToWork * ((uWorkToLms * lin) * exp2(vec3(0.3 * lC.x + 0.12 * lC.y, -0.12 * lC.y, -0.5 * lC.x + 0.12 * lC.y)));
    lin = shifted * (dot(lin, LUMA) / max(dot(shifted, LUMA), 1e-9));
  }

  float mid = exp(-pow((BL - MID - 0.5) / 2.5, 2.0));
  float clarity = uDetailBands.x + lE.z;
  float texture_ = uDetailBands.y + lE.w;
  float L2 = toneBase(BL, uTone + lTone, uContrast + lE.y)
    + boost(BM - BL, 1.2 * clarity * mid)
    + boost(G - BM, (0.6 * clarity * mid) + 0.3 * texture_)
    + boost(L - G, 1.0 * texture_);
  vec3 toned = lin * exp2(L2 - L);

  // Calibration shadow tint: magenta (+) / green (-) below middle grey, luminance kept.
  if (uShadowTint != 0.0) {
    float k = 0.12 * uShadowTint * (1.0 - smoothstep(MID - 4.0, MID + 1.0, L2));
    vec3 tinted = toned * vec3(1.0 + k, 1.0 - k, 1.0 + k);
    toned = tinted * (dot(toned, LUMA) / max(dot(tinted, LUMA), 1e-9));
  }

  // Profile look: before the user's colour controls, which then act on its result.
  if (uLook == 1) toned = applyLook(toned);

  vec3 lab = toOklab(toned);
  float C = length(lab.yz);
  // Chroma relative to lightness: how colourful, independent of exposure.
  float rel = C / max(lab.x, 1e-4);
  float hue = C > 1e-7 ? atan(lab.z, lab.y) : 0.0; // atan(0, 0) is undefined on some GPUs
  if (fringe > 0.0) {
    // Defringe: drop the colour of purple / green fringes along high-contrast edges.
    float k = fringe * (uDefringe.x * hueRange(hue, uDefringeHue.x, uDefringeHue.y) + uDefringe.y * hueRange(hue, uDefringeHue.z, uDefringeHue.w));
    lab.yz *= 1.0 - clamp(k, 0.0, 1.0);
  }
  if (uProfile == 3) {
    // B&W mix: brighten or darken each hue band, then drop the colour.
    if (uBwMix == 1) lab.x *= exp2(0.6 * bandValue(uBw, hue) * smoothstep(0.01, 0.25, rel));
    lab.yz = vec2(0.0);
  } else {
    // Vibrance / saturation in OKLab.
    float satGain = 1.0 + uPresence.y;
    float vibGain = 1.0 + uPresence.x * (1.0 - smoothstep(0.02, 0.22, C)) * (uPresence.x > 0.0 ? 1.0 : 0.7);
    lab.yz *= max(satGain * vibGain, 0.0);
    // Color Mixer: hue, saturation and luminance per band. Near-neutral colours are left alone.
    if (uMixer == 1) {
      float cw = smoothstep(0.01, 0.08, rel);
      float h2 = hue + bandValue(uMixHue, hue) * cw;
      float c2 = length(lab.yz) * max(1.0 + bandValue(uMixSat, hue) * cw, 0.0);
      lab.yz = c2 * vec2(cos(h2), sin(h2));
      // Lightness and chroma scale together, so the colour keeps its saturation.
      lab *= exp2(0.5 * bandValue(uMixLum, hue) * smoothstep(0.02, 0.2, rel));
    }
    // Local saturation and hue.
    if (lC.z != 0.0) lab.yz *= max(1.0 + lC.z, 0.0);
    if (lC.w != 0.0) {
      float hc = cos(lC.w);
      float hs = sin(lC.w);
      lab.yz = vec2(lab.y * hc - lab.z * hs, lab.y * hs + lab.z * hc);
    }
  }
  vec3 work = fromOklab(lab);

  // Profile: tone curve in ProPhoto, then to sRGB (clipped) with a mild S-curve and, for
  // some film looks, a display-space LUT.
  vec3 srgbLin = clamp(uWorkToSrgb * rgbTone(work), 0.0, 1.0);
  vec3 enc = vec3(encodeSrgb(srgbLin.r), encodeSrgb(srgbLin.g), encodeSrgb(srgbLin.b));
  if (uProfile == 0 || uProfile == 3) {
    if (uSCurveCustom == 0) enc = mix(enc, enc * enc * (3.0 - 2.0 * enc), 0.25);
    else enc = mix(enc, enc * enc * (3.0 - 2.0 * enc), uSCurve);
  }
  if (uFilmLut == 1) {
    float m = float(textureSize(uFilmLutTex, 0).x);
    vec3 film = textureLod(uFilmLutTex, enc * ((m - 1.0) / m) + 0.5 / m, 0.0).rgb;
    enc = clamp(mix(enc, film, uFilmLutAmount), 0.0, 1.0);
  }
  if (uGrading == 1) enc = colorGrade(enc);
  if (lD.z != 0.0 || lD.w != 0.0) enc = localColor(enc, lD.zw);
  if (uCurve == 1) enc = vec3(lut(enc.r, 0), lut(enc.g, 1), lut(enc.b, 2));
  if (overlay > 0.0) enc = mix(enc, uOverlayColor, 0.5 * overlay);
  o = vec4(enc, 1.0);
}`;

/**
 * Separable Gaussian. Pass 0 converts display RGB to (Y, R-Y, B-Y); pass 1 reads that.
 * Y uses sigma.x (sharpening), the colour difference uses sigma.y (colour noise reduction).
 */
export const FS_BLUR = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform ivec2 uDir;
uniform vec2 uSigma;
uniform int uConvert;
out vec4 o;
const vec3 W709 = vec3(0.2126, 0.7152, 0.0722);
vec3 fetchYC(ivec2 p, ivec2 size) {
  vec4 v = texelFetch(uTex, clamp(p, ivec2(0), size - 1), 0);
  if (uConvert == 1) {
    float y = dot(v.rgb, W709);
    return vec3(y, v.r - y, v.b - y);
  }
  return v.rgb;
}
void main() {
  ivec2 size = textureSize(uTex, 0);
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec2 sg = max(uSigma, vec2(0.05));
  int r = min(48, int(ceil(3.0 * max(sg.x, sg.y))));
  vec3 acc = vec3(0.0);
  vec2 wsum = vec2(0.0);
  for (int k = -48; k <= 48; k++) {
    if (k < -r) continue;
    if (k > r) break;
    vec3 v = fetchYC(p + uDir * k, size);
    float fk = float(k * k);
    vec2 w = exp(-fk / (2.0 * sg * sg));
    acc += vec3(v.x * w.x, v.yz * w.y);
    wsum += w;
  }
  o = vec4(acc.x / wsum.x, acc.yz / wsum.y, 1.0);
}`;

/** Sharpening (unsharp mask on Y), then post-crop vignetting and grain. */
export const FS_FINISH = /* glsl */ `#version 300 es
precision highp float;
${COMMON}
${EFFECTS_GLSL}
uniform sampler2D uDev;     // tone output, display-encoded RGB, a = inside
uniform sampler2D uBlur;    // Y blurred by the sharpening sigma (r)
uniform vec4 uSharpen;      // amount, detail, masking (0..1), enabled
// Alt-drag views of the sharpening sliders: 1 edge mask (Masking), 2 sharpened luminance
// (Amount), 3 the detail sharpening adds (Radius), 4 the same after Detail's limit (Detail).
uniform int uShowMask;
uniform int uMaskSharp;     // 1 when a mask uses Sharpness
out vec4 o;
const vec3 W709 = vec3(0.2126, 0.7152, 0.0722);
void main() {
  srcGradients(frameT());
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 size = textureSize(uDev, 0);
  vec4 d = texelFetch(uDev, p, 0);
  vec3 b = texelFetch(uBlur, p, 0).rgb;
  float y = dot(d.rgb, W709);
  vec2 cd = vec2(d.r - y, d.b - y);
  float mask = 1.0;
  if (uSharpen.w > 0.5 || uShowMask != 0) {
    float bx1 = texelFetch(uBlur, clamp(p + ivec2(1, 0), ivec2(0), size - 1), 0).r;
    float bx0 = texelFetch(uBlur, clamp(p - ivec2(1, 0), ivec2(0), size - 1), 0).r;
    float by1 = texelFetch(uBlur, clamp(p + ivec2(0, 1), ivec2(0), size - 1), 0).r;
    float by0 = texelFetch(uBlur, clamp(p - ivec2(0, 1), ivec2(0), size - 1), 0).r;
    float grad = length(vec2(bx1 - bx0, by1 - by0));
    mask = uSharpen.z <= 0.0 ? 1.0 : smoothstep(uSharpen.z * 0.02, uSharpen.z * 0.06, grad);
  }
  if (uShowMask == 1) { o = vec4(vec3(mask), d.a); return; }
  float lim = 0.02 + 0.25 * uSharpen.y;
  if (uShowMask == 3) { o = vec4(vec3(0.5 + 8.0 * (y - b.x)), d.a); return; }
  if (uShowMask == 4) { o = vec4(vec3(0.5 + 8.0 * clamp(y - b.x, -lim, lim) * mask), d.a); return; }
  float amount = uSharpen.w > 0.5 ? uSharpen.x : 0.0;
  if (uMaskSharp == 1 && d.a > 0.5) {
    // Positive local sharpness adds sharpening, negative softens towards the blurred image.
    float w[MAX_MASK];
    maskWeights(frameT(), y, developBase(frameT()), w);
    float local = 0.0;
    for (int k = 0; k < MAX_MASK; k++) {
      if (k >= uMaskCount) break;
      local += w[k] * uMaskD[k].y;
    }
    if (local > 0.0) amount += 1.4 * local;
    else y = mix(y, b.x, clamp(-local, 0.0, 1.0));
  }
  if (amount > 0.0) y += clamp(y - b.x, -lim, lim) * amount * mask;
  if (uShowMask == 2) { o = vec4(vec3(clamp(y, 0.0, 1.0)), d.a); return; }
  float g = (y - 0.2126 * (cd.x + y) - 0.0722 * (cd.y + y)) / 0.7152;
  vec3 rgb = clamp(vec3(cd.x + y, g, cd.y + y), 0.0, 1.0);
  if (uOutPx.x > 0.0 && d.a > 0.5) rgb = postCrop(rgb);
  o = vec4(clamp(rgb, 0.0, 1.0), d.a);
}`;

/**
 * Draws the finished image to the canvas (flipped), with clipping warnings, Lightroom's
 * Alt-drag clipping views and the background outside the image.
 */
export const FS_PRESENT = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uImg;
uniform vec2 uSize;
uniform int uClipping;   // J: highlights red, shadows blue
uniform int uMaskView;   // Alt-drag: 1 highlight clipping on black, 2 shadow clipping on white
uniform vec3 uBackground;
out vec4 o;
void main() {
  vec2 uv = vec2(gl_FragCoord.x / uSize.x, 1.0 - gl_FragCoord.y / uSize.y);
  vec4 c = texture(uImg, uv);
  vec3 rgb = c.rgb;
  if (uMaskView == 1) {
    rgb = step(vec3(0.998), rgb);
  } else if (uMaskView == 2) {
    rgb = step(vec3(0.002), rgb);
  } else if (uClipping == 1 && c.a > 0.5) {
    if (max(rgb.r, max(rgb.g, rgb.b)) >= 0.998) rgb = vec3(1.0, 0.0, 0.0);
    else if (max(rgb.r, max(rgb.g, rgb.b)) <= 0.002) rgb = vec3(0.0, 0.35, 1.0);
  }
  o = vec4(mix(uBackground, rgb, c.a), 1.0);
}`;

/** Downsampled copy for the histogram readback. */
export const FS_THUMB = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uImg;
uniform vec2 uSize;
out vec4 o;
void main() {
  o = texture(uImg, gl_FragCoord.xy / uSize);
}`;
