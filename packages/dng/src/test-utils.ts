// Synthetic test images (used by the tests only).
import type { CfaRaw, DngMetadata, LinearRaw } from './types.ts';

/** Deterministic PRNG (mulberry32), 0..1. */
export function rng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** LibRaw's default X-Trans layout (0 = R, 1 = G, 2 = B). */
export const XTRANS = [1, 1, 0, 1, 1, 2, 1, 1, 2, 1, 1, 0, 2, 0, 1, 0, 2, 1, 1, 1, 2, 1, 1, 0, 1, 1, 0, 1, 1, 2, 0, 2, 1, 2, 0, 1];

/** Smooth scene with edges and texture, linear 0..1 per channel, roughly daylight raw balance. */
export function scene(x: number, y: number, w: number, h: number): [number, number, number] {
  const u = x / w;
  const v = y / h;
  let l = 0.02 + 0.5 * u * u + 0.2 * v;
  if ((Math.floor(u * 7) + Math.floor(v * 5)) % 3 === 0) l *= 0.25; // hard edges
  l *= 1 + 0.15 * Math.sin(x * 0.07) * Math.sin(y * 0.05); // texture
  const hue = Math.floor(u * 4 + v * 3) % 4;
  const tint: [number, number, number][] = [
    [0.5, 1, 0.6],
    [0.8, 0.9, 0.3],
    [0.3, 0.7, 0.9],
    [0.55, 1, 0.65],
  ];
  const t = tint[hue]!;
  return [Math.min(1, l * t[0]), Math.min(1, l * t[1]), Math.min(1, l * t[2])];
}

/** Mosaic of `scene` with shot + read noise, 14-bit scale, black added. */
export function syntheticCfa(width: number, height: number, pattern: number[], pw: number, black: number[], white: number, seed = 1): CfaRaw {
  const r = rng(seed);
  const data = new Uint16Array(width * height);
  const ph = pattern.length / pw;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const k = (y % ph) * pw + (x % pw);
      const c = pattern[k]!;
      const b = black[k]!;
      const signal = scene(x, y, width, height)[c]! * (white - b);
      const noise = (r() + r() + r() - 1.5) * 2 * (2 + Math.sqrt(signal) * 0.5);
      data[y * width + x] = Math.max(0, Math.min(white, Math.round(b + signal + noise)));
    }
  }
  return { kind: 'cfa', width, height, data, patternWidth: pw, patternHeight: ph, pattern, black, white };
}

export function syntheticLinear(width: number, height: number): LinearRaw {
  const data = new Uint16Array(width * height * 3);
  for (let y = 0, i = 0; y < height; y++) {
    for (let x = 0; x < width; x++, i += 3) {
      const [r, g, b] = scene(x, y, width, height);
      data[i] = Math.round(r * 65535);
      data[i + 1] = Math.round(g * 65535);
      data[i + 2] = Math.round(b * 65535);
    }
  }
  return { kind: 'linear', width, height, data };
}

export function baseMeta(): DngMetadata {
  return {
    make: 'Canon',
    model: 'EOS R5',
    uniqueCameraModel: 'Canon EOS R5',
    software: 'immich-raw 1.0',
    orientation: 6,
    colorMatrix1: [0.9766, -0.4, -0.0281, -0.3714, 1.1556, 0.2361, -0.0597, 0.1442, 0.6086],
    calibrationIlluminant1: 17,
    colorMatrix2: [0.6722, -0.0635, -0.0963, -0.4287, 1.246, 0.2028, -0.0908, 0.2162, 0.5668],
    calibrationIlluminant2: 21,
    forwardMatrix1: [0.6, 0.3, 0.06, 0.2, 0.75, 0.05, 0.03, 0.01, 0.79],
    forwardMatrix2: [0.61, 0.29, 0.06, 0.21, 0.74, 0.05, 0.02, 0.02, 0.79],
    asShotNeutral: [0.4876, 1, 0.6612],
    baselineExposure: -0.25,
    defaultCrop: { x: 8, y: 6, width: 500, height: 300 },
    originalRawFileName: 'IMG_0001 Zürich.CR3',
    dateTime: '2026:11:11 10:20:30',
    exif: {
      dateTimeOriginal: '2026:07:04 18:45:12',
      offsetTimeOriginal: '+02:00',
      subSecTimeOriginal: '25',
      exposureTime: 1 / 250,
      fNumber: 2.8,
      iso: 400,
      exposureBias: -1 / 3,
      focalLength: 35,
      focalLengthIn35mm: 35,
      lensMake: 'Canon',
      lensModel: 'RF35mm F1.8 MACRO IS STM',
      bodySerialNumber: '123456789012',
    },
    gps: { latitude: 47.376887, longitude: -8.541694, altitude: -12.5 },
    xmp: '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"/></x:xmpmeta>',
  };
}
