// 3x3 matrix helpers and the color-space constants the pipeline needs.
// Matrices are row-major arrays of 9 numbers: m[row * 3 + col].

export type Mat3 = readonly number[];
export type Vec3 = readonly [number, number, number];

export const IDENTITY3: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function mul3(a: Mat3, b: Mat3): Mat3 {
  const out = new Array<number>(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] = a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!;
    }
  }
  return out;
}

export function mulVec3(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0]! * v[0] + m[1]! * v[1] + m[2]! * v[2],
    m[3]! * v[0] + m[4]! * v[1] + m[5]! * v[2],
    m[6]! * v[0] + m[7]! * v[1] + m[8]! * v[2],
  ];
}

export function inv3(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m as [number, number, number, number, number, number, number, number, number];
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) throw new Error('inv3: matrix is singular');
  const s = 1 / det;
  return [
    A * s, -(b * i - c * h) * s, (b * f - c * e) * s,
    B * s, (a * i - c * g) * s, -(a * f - c * d) * s,
    C * s, -(a * h - b * g) * s, (a * e - b * d) * s,
  ];
}

export function transpose3(m: Mat3): Mat3 {
  return [m[0]!, m[3]!, m[6]!, m[1]!, m[4]!, m[7]!, m[2]!, m[5]!, m[8]!];
}

export function diag3(v: Vec3): Mat3 {
  return [v[0], 0, 0, 0, v[1], 0, 0, 0, v[2]];
}

/** First 3 rows x first 3 columns; fits LibRaw's 3x4 rgb_cam and 4x3 cam_xyz. */
export function fromRows(rows: readonly (readonly number[])[]): Mat3 {
  const out: number[] = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) out.push(rows[r]?.[c] ?? 0);
  }
  return out;
}

/** Column-major Float32Array for gl.uniformMatrix3fv(loc, false, ...). */
export function toGlMat3(m: Mat3): Float32Array {
  return new Float32Array([m[0]!, m[3]!, m[6]!, m[1]!, m[4]!, m[7]!, m[2]!, m[5]!, m[8]!]);
}

export interface Chromaticity {
  x: number;
  y: number;
}

/** xy chromaticity -> XYZ with Y = 1. */
export function xyToXyz({ x, y }: Chromaticity): Vec3 {
  return [x / y, 1, (1 - x - y) / y];
}

export function xyzToXy(xyz: Vec3): Chromaticity {
  const sum = xyz[0] + xyz[1] + xyz[2];
  return { x: xyz[0] / sum, y: xyz[1] / sum };
}

/** RGB -> XYZ matrix from primaries and a white point (standard derivation). */
export function rgbToXyzMatrix(r: Chromaticity, g: Chromaticity, b: Chromaticity, white: Vec3): Mat3 {
  const [xr, yr, zr] = xyToXyz(r);
  const [xg, yg, zg] = xyToXyz(g);
  const [xb, yb, zb] = xyToXyz(b);
  const p: Mat3 = [xr, xg, xb, yr, yg, yb, zr, zg, zb];
  const [sr, sg, sb] = mulVec3(inv3(p), white);
  return [xr * sr, xg * sg, xb * sb, yr * sr, yg * sg, yb * sb, zr * sr, zg * sg, zb * sb];
}

// D65 from its xy chromaticity (sRGB's definition); D50 as used by ICC profiles and ProPhoto.
export const WHITE_D65_XYZ: Vec3 = xyToXyz({ x: 0.3127, y: 0.329 });
export const WHITE_D50_XYZ: Vec3 = [0.96422, 1, 0.82521];

export const SRGB_TO_XYZ_D65: Mat3 = rgbToXyzMatrix(
  { x: 0.64, y: 0.33 },
  { x: 0.3, y: 0.6 },
  { x: 0.15, y: 0.06 },
  WHITE_D65_XYZ,
);
export const XYZ_D65_TO_SRGB: Mat3 = inv3(SRGB_TO_XYZ_D65);

// ROMM RGB (ProPhoto) primaries, D50 white.
export const PROPHOTO_TO_XYZ_D50: Mat3 = rgbToXyzMatrix(
  { x: 0.7347, y: 0.2653 },
  { x: 0.1596, y: 0.8404 },
  { x: 0.0366, y: 0.0001 },
  WHITE_D50_XYZ,
);
export const XYZ_D50_TO_PROPHOTO: Mat3 = inv3(PROPHOTO_TO_XYZ_D50);

const BRADFORD: Mat3 = [0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296];

/** Bradford chromatic adaptation from one white to another (XYZ -> XYZ). */
export function bradford(src: Vec3, dst: Vec3): Mat3 {
  const s = mulVec3(BRADFORD, src);
  const d = mulVec3(BRADFORD, dst);
  return mul3(inv3(BRADFORD), mul3(diag3([d[0] / s[0], d[1] / s[1], d[2] / s[2]]), BRADFORD));
}

export const BRADFORD_D65_TO_D50: Mat3 = bradford(WHITE_D65_XYZ, WHITE_D50_XYZ);
export const BRADFORD_D50_TO_D65: Mat3 = bradford(WHITE_D50_XYZ, WHITE_D65_XYZ);

// OKLab (Björn Ottosson): M1 takes XYZ D65 to LMS; cube roots; M2 takes LMS' to Lab.
export const XYZ_D65_TO_LMS_OKLAB: Mat3 = [
  0.8189330101, 0.3618667424, -0.1288597137,
  0.0329845436, 0.9293118715, 0.0361456387,
  0.0482003018, 0.2643662691, 0.633851707,
];
export const OKLAB_M2: Mat3 = [
  0.2104542553, 0.793617785, -0.0040720468,
  1.9779984951, -2.428592205, 0.4505937099,
  0.0259040371, 0.7827717662, -0.808675766,
];
