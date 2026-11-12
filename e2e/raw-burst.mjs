// Wraps the linear test frames from services/culler/scripts/make_burst.py (--linear16) into
// Bayer DNG files, so the culler's end-to-end test runs on real RAW files. Uses the editor's
// DNG writer (packages/dng); Node imports its TypeScript directly.
import { readFileSync, writeFileSync } from 'node:fs';
import { buildDng } from '../packages/dng/src/index.ts';

const BLACK = 512;
const WHITE = 16383; // 14-bit sensor
// The "camera" is linear sRGB: ColorMatrix1 (XYZ -> camera) is the D65 XYZ -> linear sRGB matrix.
const XYZ_TO_SRGB = [3.2404542, -1.5371385, -0.4985314, -0.969266, 1.8760108, 0.041556, 0.0556434, -0.2040259, 1.0572252];

function rng(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** RGGB mosaic of linear RGB (16-bit, 65535 = clipping) with light shot and read noise. */
export function mosaic(rgb16, width, height, seed = 1) {
  const r = rng(seed);
  const data = new Uint16Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const c = y % 2 === 0 ? (x % 2 === 0 ? 0 : 1) : x % 2 === 0 ? 1 : 2;
      const signal = (rgb16[(y * width + x) * 3 + c] / 65535) * (WHITE - BLACK);
      const noise = (r() + r() + r() - 1.5) * 1.6 * Math.sqrt(4 + signal * 0.2);
      data[y * width + x] = Math.max(0, Math.min(WHITE, Math.round(BLACK + signal + noise)));
    }
  }
  return { kind: 'cfa', width, height, data, patternWidth: 2, patternHeight: 2, pattern: [0, 1, 1, 2], black: [BLACK, BLACK, BLACK, BLACK], white: WHITE };
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** 'YYYY:MM:DD HH:MM:SS' and the milliseconds, in UTC. */
function exifDate(date) {
  const d = new Date(date);
  const text = `${d.getUTCFullYear()}:${pad(d.getUTCMonth() + 1)}:${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  return { text, subSec: pad(d.getUTCMilliseconds(), 3) };
}

/** Writes `<dir>/<entry.name>.dng` from a manifest entry; returns its path. */
export async function writeDng(dir, entry, takenAt, seed) {
  const bytes = readFileSync(`${dir}/${entry.raw}`);
  const rgb16 = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
  const when = exifDate(takenAt);
  const meta = {
    make: 'Immich-RAW',
    model: 'Test Camera',
    uniqueCameraModel: 'Immich-RAW Test Camera',
    software: 'immich-raw e2e',
    orientation: 1,
    colorMatrix1: XYZ_TO_SRGB,
    calibrationIlluminant1: 21,
    asShotNeutral: [1, 1, 1],
    dateTime: when.text,
    exif: { dateTimeOriginal: when.text, offsetTimeOriginal: '+00:00', subSecTimeOriginal: when.subSec, exposureTime: 1 / 250, fNumber: 4, iso: 100 },
  };
  const dng = await buildDng(meta, mosaic(rgb16, entry.width, entry.height, seed));
  const path = `${dir}/${entry.name}.dng`;
  writeFileSync(path, dng);
  return path;
}
