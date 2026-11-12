// DNG camera-profile parts: the hue/saturation/value look table and the tone curve
// (ProfileLookTable, ProfileToneCurve), plus 3D colour LUTs (.cube).
//
// The look table follows the DNG specification and the DNG SDK (RefBaselineHueSatMap in
// dng_reference.cpp, DNG_RGBtoHSV in dng_utils.h): it works on linear ProPhoto RGB in
// "hexcone" HSV with hue 0..6, and with sRGB value encoding the value axis is sRGB-encoded.
// The shader (applyLook in shaders.ts) does the same; applyLookCpu() here mirrors it exactly.
import { monotoneCubic } from '../curves.ts';
import type { Vec3 } from './matrices.ts';

export interface HueSatTable {
  hueDivisions: number;
  satDivisions: number;
  valDivisions: number;
  /** The value axis is sRGB-encoded (DNG ProfileLookTableEncoding = 1). */
  srgbValues: boolean;
  /** Per node: hue shift (degrees), saturation scale, value scale. DNG order: ((v*H + h)*S + s)*3. */
  data: Float32Array;
}

export interface CubeLut {
  size: number;
  /** RGB per node, red fastest (the .cube order). */
  data: Float32Array;
}

export interface ToneLut {
  /** Curve output for input x = max * u², u = i / (length - 1). */
  lut: Float32Array;
  max: number;
  /** Scene value that renders as white (Auto aims the brightest tones below it). */
  whitePoint: number;
}

const ATTR = /(\w+)="([^"]*)"/g;

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(ATTR)) out[m[1]!] = m[2]!;
  return out;
}

function num(v: string | undefined, what: string): number {
  const n = Number(v);
  if (v === undefined || v.trim() === '' || !Number.isFinite(n)) throw new Error(`Bad ${what}: ${v}`);
  return n;
}

function section(text: string, name: string): { head: Record<string, string>; body: string } {
  const m = new RegExp(`<${name}\\b([^>]*)>([\\s\\S]*?)</${name}>`).exec(text);
  if (!m) throw new Error(`No <${name}> found`);
  return { head: attrs(m[1]!), body: m[2]! };
}

/** The <LookTable> of a dcpTool XML profile (or a fragment of one). */
export function parseDcpLookTableXml(text: string, srgbValues = true): HueSatTable {
  const { head, body } = section(text, 'LookTable');
  const H = num(head.hueDivisions, 'hueDivisions');
  const S = num(head.satDivisions, 'satDivisions');
  const V = num(head.valDivisions, 'valDivisions');
  if (![H, S, V].every((n) => Number.isInteger(n) && n >= 1 && n <= 256) || S < 2) throw new Error(`Bad look table size ${H}x${S}x${V}`);
  const data = new Float32Array(H * S * V * 3);
  const seen = new Uint8Array(H * S * V);
  let count = 0;
  for (const m of body.matchAll(/<Element\b([^>]*)\/>/g)) {
    const a = attrs(m[1]!);
    const h = num(a.HueDiv, 'HueDiv');
    const s = num(a.SatDiv, 'SatDiv');
    const v = num(a.ValDiv, 'ValDiv');
    if (!(h >= 0 && h < H && s >= 0 && s < S && v >= 0 && v < V) || ![h, s, v].every(Number.isInteger)) throw new Error(`Look table index out of range: ${h},${s},${v}`);
    const i = (v * H + h) * S + s;
    if (seen[i]) throw new Error(`Look table node ${h},${s},${v} given twice`);
    seen[i] = 1;
    data[i * 3] = num(a.HueShift, 'HueShift');
    data[i * 3 + 1] = num(a.SatScale, 'SatScale');
    data[i * 3 + 2] = num(a.ValScale, 'ValScale');
    count++;
  }
  if (count !== H * S * V) throw new Error(`Look table has ${count} of ${H * S * V} nodes`);
  return { hueDivisions: H, satDivisions: S, valDivisions: V, srgbValues, data };
}

/** The <ToneCurve> of a dcpTool XML profile: x0, y0, x1, y1, … (linear, 0..1). */
export function parseDcpToneCurveXml(text: string): Float32Array {
  const { head, body } = section(text, 'ToneCurve');
  const points: [number, number, number][] = [];
  for (const m of body.matchAll(/<Element\b([^>]*)\/>/g)) {
    const a = attrs(m[1]!);
    points.push([num(a.N, 'N'), num(a.h, 'h'), num(a.v, 'v')]);
  }
  if (head.Size !== undefined && num(head.Size, 'Size') !== points.length) throw new Error(`Tone curve has ${points.length} of ${head.Size} points`);
  points.sort((p, q) => p[0] - q[0]);
  return validCurve(points.flatMap(([, x, y]) => [x, y]));
}

function validCurve(xy: number[]): Float32Array {
  const n = xy.length / 2;
  if (n < 2) throw new Error('Tone curve needs at least two points');
  const close = (a: number, b: number) => Math.abs(a - b) < 1e-4;
  if (!close(xy[0]!, 0) || !close(xy[1]!, 0) || !close(xy[2 * n - 2]!, 1) || !close(xy[2 * n - 1]!, 1)) throw new Error('Tone curve must run from (0,0) to (1,1)');
  for (let i = 0; i < n; i++) {
    const [x, y] = [xy[2 * i]!, xy[2 * i + 1]!];
    if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) throw new Error(`Tone curve point out of range: ${x},${y}`);
    if (i > 0 && !(x > xy[2 * i - 2]!)) throw new Error('Tone curve inputs must increase');
  }
  return Float32Array.from(xy);
}

/** A .cube 3D LUT (Adobe/Resolve format): LUT_3D_SIZE, optional TITLE and DOMAIN_MIN/MAX 0..1. */
export function parseCubeLut(text: string): CubeLut {
  let size = 0;
  const values: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const key = /^([A-Z][A-Z_0-9]*)\b\s*(.*)$/.exec(line);
    if (key) {
      const [, name, rest] = key;
      if (name === 'LUT_3D_SIZE') size = num(rest, 'LUT_3D_SIZE');
      else if (name === 'DOMAIN_MIN' || name === 'DOMAIN_MAX') {
        const want = name === 'DOMAIN_MIN' ? 0 : 1;
        if (!rest!.trim().split(/\s+/).every((v) => num(v, name) === want)) throw new Error(`Unsupported ${name}: ${rest}`);
      } else if (name === 'LUT_1D_SIZE') throw new Error('1D LUTs are not supported');
      continue; // TITLE and others
    }
    const parts = line.split(/\s+/);
    if (parts.length !== 3) throw new Error(`Bad LUT line: ${line}`);
    for (const p of parts) values.push(num(p, 'LUT value'));
  }
  if (!Number.isInteger(size) || size < 2 || size > 128) throw new Error(`Bad LUT_3D_SIZE ${size}`);
  if (values.length !== size ** 3 * 3) throw new Error(`LUT has ${values.length / 3} of ${size ** 3} entries`);
  return { size, data: Float32Array.from(values) };
}

/** DNG hexcone HSV: hue 0..6 (0 red, 2 green, 4 blue), saturation and value. */
export function dngRgbToHsv([r, g, b]: Vec3): Vec3 {
  const v = Math.max(r, g, b);
  const gap = v - Math.min(r, g, b);
  if (!(gap > 0)) return [0, 0, v];
  let h: number;
  if (r === v) {
    h = (g - b) / gap;
    if (h < 0) h += 6;
  } else if (g === v) h = 2 + (b - r) / gap;
  else h = 4 + (r - g) / gap;
  return [h, gap / v, v];
}

export function dngHsvToRgb([hIn, s, v]: Vec3): Vec3 {
  if (!(s > 0)) return [v, v, v];
  const h = hIn - 6 * Math.floor(hIn / 6);
  const i = Math.min(5, Math.floor(h));
  const f = h - i;
  const p = v * (1 - s);
  const q = v * (1 - s * f);
  const t = v * (1 - s * (1 - f));
  switch (i) {
    case 0:
      return [v, t, p];
    case 1:
      return [q, v, p];
    case 2:
      return [p, v, t];
    case 3:
      return [p, q, v];
    case 4:
      return [t, p, v];
    default:
      return [v, p, q];
  }
}

const encodeSrgb = (v: number) => {
  const x = Math.min(1, Math.max(0, v));
  return x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
};
const decodeSrgb = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

/** Table value at hue h (0..6), saturation s and (encoded) value, trilinear like the DNG SDK. */
export function hueSatAt(t: HueSatTable, h: number, s: number, vEnc: number): Vec3 {
  const { hueDivisions: H, satDivisions: S, valDivisions: V, data } = t;
  const hs = (h - 6 * Math.floor(h / 6)) * (H / 6);
  const ss = Math.min(Math.max(s, 0), 1) * (S - 1);
  const vs = V < 2 ? 0 : Math.min(Math.max(vEnc, 0), 1) * (V - 1);
  let h0 = Math.floor(hs);
  const s0 = Math.min(Math.floor(ss), S - 2);
  const v0 = V < 2 ? 0 : Math.min(Math.floor(vs), V - 2);
  if (h0 >= H) h0 = H - 1;
  const h1 = h0 + 1 >= H ? 0 : h0 + 1;
  const fh = hs - h0;
  const fs = ss - s0;
  const fv = vs - v0;
  const v1 = V < 2 ? 0 : v0 + 1;
  const out: [number, number, number] = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const at = (hh: number, sv: number, vv: number) => data[((vv * H + hh) * S + sv) * 3 + k]!;
    const lerp = (a: number, b: number, f: number) => a + (b - a) * f;
    const plane = (vv: number) =>
      lerp(lerp(at(h0, s0, vv), at(h0, s0 + 1, vv), fs), lerp(at(h1, s0, vv), at(h1, s0 + 1, vv), fs), fh);
    out[k] = lerp(plane(v0), plane(v1), fv);
  }
  return out;
}

/**
 * The look table applied to one linear ProPhoto colour, with an amount (1 = as in the
 * table, 0 = none, 2 = twice the change). Mirrors applyLook() in the tone shader.
 * Negative (out-of-gamut) parts pass through; values above 1 keep their headroom.
 */
export function applyLookCpu(t: HueSatTable, rgb: Vec3, amount = 1): Vec3 {
  const neg: Vec3 = [Math.min(rgb[0], 0), Math.min(rgb[1], 0), Math.min(rgb[2], 0)];
  const [h, s, v] = dngRgbToHsv([rgb[0] - neg[0], rgb[1] - neg[1], rgb[2] - neg[2]]);
  if (!(v > 0)) return rgb;
  const vc = Math.min(v, 1);
  const ve = t.srgbValues ? encodeSrgb(vc) : vc;
  const [dh, ds, dv] = hueSatAt(t, h, s, ve);
  const h2 = h + dh * amount * (6 / 360);
  const s2 = Math.min(s * Math.max(1 + (ds - 1) * amount, 0), 1);
  const vs = Math.max(1 + (dv - 1) * amount, 0);
  const gain = t.srgbValues ? decodeSrgb(Math.min(ve * vs, 1)) / Math.max(vc, 1e-9) : vs;
  const out = dngHsvToRgb([h2, s2, v * gain]);
  return [out[0] + neg[0], out[1] + neg[1], out[2] + neg[2]];
}

/** RGBA16F texels for a 3D texture: x = saturation, y = hue, z = value (the DNG storage order). */
export function hueSatTexels(t: HueSatTable): Float32Array {
  const n = t.hueDivisions * t.satDivisions * t.valDivisions;
  const out = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    out[i * 4] = t.data[i * 3]!;
    out[i * 4 + 1] = t.data[i * 3 + 1]!;
    out[i * 4 + 2] = t.data[i * 3 + 2]!;
    out[i * 4 + 3] = 1;
  }
  return out;
}

/** RGBA16F texels for a 3D texture: x = red, y = green, z = blue. */
export function cubeTexels(c: CubeLut): Float32Array {
  const n = c.size ** 3;
  const out = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    out[i * 4] = c.data[i * 3]!;
    out[i * 4 + 1] = c.data[i * 3 + 1]!;
    out[i * 4 + 2] = c.data[i * 3 + 2]!;
    out[i * 4 + 3] = 1;
  }
  return out;
}

/** Trilinear lookup in a cube LUT (for tests and CPU checks; the shader samples a 3D texture). */
export function cubeAt(c: CubeLut, rgb: Vec3): Vec3 {
  const n = c.size;
  const p = rgb.map((v) => Math.min(Math.max(v, 0), 1) * (n - 1));
  const i0 = p.map((v) => Math.min(Math.floor(v), n - 2));
  const f = p.map((v, k) => v - i0[k]!);
  const out: [number, number, number] = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    let acc = 0;
    for (let corner = 0; corner < 8; corner++) {
      const d = [corner & 1, (corner >> 1) & 1, (corner >> 2) & 1];
      const w = d.reduce((m, b, ax) => m * (b ? f[ax]! : 1 - f[ax]!), 1);
      const idx = ((i0[2]! + d[2]!) * n + (i0[1]! + d[1]!)) * n + (i0[0]! + d[0]!);
      acc += w * c.data[idx * 3 + k]!;
    }
    out[k] = acc;
  }
  return out;
}

export interface ToneLutOptions {
  size?: number;
  /** Largest scene value the LUT covers. */
  max?: number;
  /** Scene values above the knee are rolled off toward 1 instead of clipping (1 = clip). */
  knee?: number;
}

/**
 * A DCP tone curve as a lookup table over scene values 0..max, sampled densely in the
 * shadows (x = max·u²). The curve itself covers 0..1; above `knee` the input is rolled off
 * smoothly so highlights up to about twice the white keep some detail.
 */
export function buildToneLut(points: Float32Array, opts: ToneLutOptions = {}): ToneLut {
  const size = opts.size ?? 4096;
  const max = opts.max ?? 2;
  const knee = opts.knee ?? 0.8;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < points.length; i += 2) {
    xs.push(points[i]!);
    ys.push(points[i + 1]!);
  }
  const curve = monotoneCubic(xs, ys);
  const rolloff = (x: number) => (knee >= 1 || x <= knee ? Math.min(x, 1) : knee + (1 - knee) * Math.tanh((x - knee) / (1 - knee)));
  const lut = new Float32Array(size);
  let prev = 0;
  let whitePoint = max;
  for (let i = 0; i < size; i++) {
    const u = i / (size - 1);
    const x = max * u * u;
    const y = Math.max(prev, Math.min(1, Math.max(0, curve(rolloff(x)))));
    lut[i] = y;
    prev = y;
    if (whitePoint === max && y >= 0.995) whitePoint = x;
  }
  return { lut, max, whitePoint };
}

/** Value of a tone LUT at scene value x (linear interpolation, as the shader's texture lookup). */
export function toneLutAt(t: ToneLut, x: number): number {
  const n = t.lut.length;
  const p = Math.sqrt(Math.min(Math.max(x / t.max, 0), 1)) * (n - 1);
  const i = Math.min(Math.floor(p), n - 2);
  return t.lut[i]! + (t.lut[i + 1]! - t.lut[i]!) * (p - i);
}
