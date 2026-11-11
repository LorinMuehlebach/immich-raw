import { expect, it } from 'vitest';
import { assembleDng } from './dng.ts';
import { decodeRawImage, readDng } from './reader.ts';
import { encodeCfaTile, tileLayout } from './tiles.ts';
import { baseMeta, rng } from './test-utils.ts';
import type { CfaRaw } from './types.ts';

it('encodes a 6000 x 4000 noisy 14-bit Bayer mosaic in reasonable time', () => {
  const w = 6000;
  const h = 4000;
  // Smooth colour scene plus noise (~3 DN read noise + shot noise), black 512.
  const r = rng(42);
  const noise = new Float32Array(65536);
  for (let i = 0; i < noise.length; i++) noise[i] = r() + r() + r() + r() - 2;
  const sx = Float32Array.from({ length: w }, (_, x) => Math.sin(x / 300));
  const cy = Float32Array.from({ length: h }, (_, y) => Math.cos(y / 200));
  const gain = [0.5, 1, 0.65, 1];
  const data = new Uint16Array(w * h);
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i++) {
      const s = (6000 + 5000 * sx[x]! * cy[y]! + (x & 512 ? 1500 : 0)) * gain[((y & 1) << 1) | (x & 1)]!;
      const v = 512 + s + noise[(i * 7919) & 65535]! * (3 + Math.sqrt(s) * 0.6);
      data[i] = v < 0 ? 0 : v > 16383 ? 16383 : v;
    }
  }
  const raw: CfaRaw = { kind: 'cfa', width: w, height: h, data, patternWidth: 2, patternHeight: 2, pattern: [0, 1, 1, 2], black: [512, 512, 512, 512], white: 16383 };
  const { count } = tileLayout(w, h);
  const t0 = performance.now();
  const tiles: Uint8Array[] = [];
  for (let i = 0; i < count; i++) tiles.push(encodeCfaTile(raw, i));
  const t1 = performance.now();
  const bytes = assembleDng({ ...baseMeta(), defaultCrop: undefined }, raw, tiles);
  const t2 = performance.now();
  const back = decodeRawImage(readDng(bytes));
  const t3 = performance.now();
  console.log(
    `6000x4000 Bayer: ${count} tiles encoded in ${((t1 - t0) / 1000).toFixed(2)} s, assembled in ${(t2 - t1).toFixed(0)} ms, ` +
      `${(bytes.length / 1e6).toFixed(1)} MB (${((bytes.length * 8) / (w * h)).toFixed(2)} bits/pixel, ratio ${((w * h * 2) / bytes.length).toFixed(2)}:1 vs 16-bit), ` +
      `decoded in ${((t3 - t2) / 1000).toFixed(2)} s`,
  );
  expect(back.data).toEqual(data);
  expect(t1 - t0).toBeLessThan(60_000);
}, 180_000);
