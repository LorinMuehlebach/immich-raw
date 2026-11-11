// LibRaw fills color.cam_xyz (XYZ -> camera) only from its table of known cameras. For other
// files, e.g. a DNG from a camera it doesn't know, it stays all zero, although LibRaw still
// builds rgb_cam (camera -> sRGB) and pre_mul from the matrix in the file:
//   cam_rgb = cam_xyz · XYZ_RGB,  pre_mul[i] = 1 / rowsum(cam_rgb)[i],
//   rgb_cam = inverse(cam_rgb with each row divided by its sum)
// so cam_xyz can be taken back from rgb_cam and pre_mul.

type Mat3 = [[number, number, number], [number, number, number], [number, number, number]];

/** LibRaw's linear sRGB (D65) -> XYZ matrix (LibRaw_constants::xyz_rgb). */
const XYZ_RGB: Mat3 = [
  [0.4124564, 0.3575761, 0.1804375],
  [0.2126729, 0.7151522, 0.072175],
  [0.0193339, 0.119192, 0.9503041],
];

function inv3(m: Mat3): Mat3 | null {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h;
  const B = f * g - d * i;
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  return [
    [A / det, (c * h - b * i) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, (c * d - a * f) / det],
    [C / det, (b * g - a * h) / det, (a * e - b * d) / det],
  ];
}

function mul3(a: Mat3, b: Mat3): Mat3 {
  const row = (r: readonly number[]) => [0, 1, 2].map((j) => r[0]! * b[0][j]! + r[1]! * b[1][j]! + r[2]! * b[2][j]!) as [number, number, number];
  return [row(a[0]), row(a[1]), row(a[2])];
}

const top3 = (m: readonly (readonly number[])[]): Mat3 | null => {
  if (m.length < 3 || m.slice(0, 3).some((r) => r.length < 3)) return null;
  return [0, 1, 2].map((i) => [m[i]![0]!, m[i]![1]!, m[i]![2]!]) as Mat3;
};

/** True when the 3x3 part of LibRaw's cam_xyz can be used (not all zero, invertible). */
export function hasCamXyz(camXyz: readonly (readonly number[])[] | undefined): boolean {
  const m = camXyz && top3(camXyz);
  return !!m && inv3(m) !== null;
}

/** cam_xyz rebuilt from LibRaw's rgb_cam and pre_mul, or null when they can't give one. */
export function camXyzFromRgbCam(rgbCam: readonly (readonly number[])[], preMul: readonly number[]): number[][] | null {
  const m = top3(rgbCam);
  const camRgb = m && inv3(m);
  if (!camRgb || preMul.length < 3) return null;
  const scale = preMul.slice(0, 3).map((p) => (Number.isFinite(p) && p > 0 ? 1 / p : NaN));
  if (scale.some((s) => !Number.isFinite(s))) return null;
  const camXyz = mul3(camRgb, inv3(XYZ_RGB)!).map((r, i) => r.map((v) => v * scale[i]!));
  return hasCamXyz(camXyz) ? camXyz : null;
}
