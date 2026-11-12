// Port of the Adobe DNG SDK's dng_temperature (Robertson isotemperature lines), so
// Temp/Tint values match Lightroom's. Positive tint = the light is on the green side of
// the Planckian locus, which the correction pushes toward magenta (Lightroom's convention).
//
// dng_temperature.cpp: Copyright 2006 Adobe Systems Incorporated, used under the DNG SDK
// License Agreement (licenses/dng-sdk.txt).
import type { Chromaticity } from './matrices.ts';

export interface TempTint {
  temp: number;
  tint: number;
}

const TINT_SCALE = -3000;

// Robertson (1968): reciprocal temperature in mireds, u, v on the locus, and the
// slope t of the isotemperature line. Same table as the DNG SDK.
const TABLE: readonly (readonly [number, number, number, number])[] = [
  [0, 0.18006, 0.26352, -0.24341],
  [10, 0.18066, 0.26589, -0.25479],
  [20, 0.18133, 0.26846, -0.26876],
  [30, 0.18208, 0.27119, -0.28539],
  [40, 0.18293, 0.27407, -0.3047],
  [50, 0.18388, 0.27709, -0.32675],
  [60, 0.18494, 0.28021, -0.35156],
  [70, 0.18611, 0.28342, -0.37915],
  [80, 0.1874, 0.28668, -0.40955],
  [90, 0.1888, 0.28997, -0.44278],
  [100, 0.19032, 0.29326, -0.47888],
  [125, 0.19462, 0.30141, -0.58204],
  [150, 0.19962, 0.30921, -0.70471],
  [175, 0.20525, 0.31647, -0.84901],
  [200, 0.21142, 0.32312, -1.0182],
  [225, 0.21807, 0.32909, -1.2168],
  [250, 0.22511, 0.33439, -1.4512],
  [275, 0.23247, 0.33904, -1.7298],
  [300, 0.2401, 0.34308, -2.0637],
  [325, 0.24792, 0.34655, -2.4681],
  [350, 0.25591, 0.34951, -2.9641],
  [375, 0.264, 0.352, -3.5814],
  [400, 0.27218, 0.35407, -4.3633],
  [425, 0.28039, 0.35577, -5.3762],
  [450, 0.28863, 0.35714, -6.7262],
  [475, 0.29685, 0.35823, -8.5955],
  [500, 0.30505, 0.35907, -11.324],
  [525, 0.3132, 0.35968, -15.628],
  [550, 0.32129, 0.36011, -23.325],
  [575, 0.32931, 0.36038, -40.77],
  [600, 0.33724, 0.36051, -116.45],
];

/** dng_temperature::Set_xy_coord */
export function xyToTempTint(xy: Chromaticity): TempTint {
  const denom = 1.5 - xy.x + 6 * xy.y;
  const u = (2 * xy.x) / denom;
  const v = (3 * xy.y) / denom;

  let lastDt = 0;
  let lastDu = 0;
  let lastDv = 0;
  for (let index = 1; index <= 30; index++) {
    const row = TABLE[index]!;
    const prev = TABLE[index - 1]!;
    // Unit vector along this isotemperature line.
    let du = 1;
    let dv = row[3];
    let len = Math.hypot(du, dv);
    du /= len;
    dv /= len;
    // Signed distance of the test point from the line.
    let uu = u - row[1];
    let vv = v - row[2];
    let dt = -uu * dv + vv * du;

    if (dt <= 0 || index === 30) {
      if (dt > 0) dt = 0;
      dt = -dt;
      const f = index === 1 ? 0 : dt / (lastDt + dt);
      const temp = 1e6 / (prev[0] * f + row[0] * (1 - f));

      uu = u - (prev[1] * f + row[1] * (1 - f));
      vv = v - (prev[2] * f + row[2] * (1 - f));
      du = du * (1 - f) + lastDu * f;
      dv = dv * (1 - f) + lastDv * f;
      len = Math.hypot(du, dv);
      du /= len;
      dv /= len;
      return { temp, tint: (uu * du + vv * dv) * TINT_SCALE };
    }
    lastDt = dt;
    lastDu = du;
    lastDv = dv;
  }
  // Unreachable: the loop always returns at index 30.
  return { temp: 1e6 / TABLE[30]![0], tint: 0 };
}

/** dng_temperature::Get_xy_coord */
export function tempTintToXy(temp: number, tint: number): Chromaticity {
  const r = 1e6 / temp;
  const offset = tint * (1 / TINT_SCALE);
  for (let index = 0; index <= 29; index++) {
    const row = TABLE[index]!;
    const next = TABLE[index + 1]!;
    if (r < next[0] || index === 29) {
      const f = (next[0] - r) / (next[0] - row[0]);
      let u = row[1] * f + next[1] * (1 - f);
      let v = row[2] * f + next[2] * (1 - f);

      const len1 = Math.hypot(1, row[3]);
      const len2 = Math.hypot(1, next[3]);
      const uu1 = 1 / len1;
      const vv1 = row[3] / len1;
      const uu2 = 1 / len2;
      const vv2 = next[3] / len2;
      let uu3 = uu1 * f + uu2 * (1 - f);
      let vv3 = vv1 * f + vv2 * (1 - f);
      const len3 = Math.hypot(uu3, vv3);
      uu3 /= len3;
      vv3 /= len3;

      u += uu3 * offset;
      v += vv3 * offset;
      const d = u - 4 * v + 2;
      return { x: (1.5 * u) / d, y: v / d };
    }
  }
  return { x: 0.3127, y: 0.329 };
}
