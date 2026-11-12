import { existsSync, readFileSync } from 'node:fs';
import { env } from 'node:process';
import { describe, expect, it } from 'vitest';
import { autoScale, sourcePoint, vignetteGain } from './apply.ts';
import { dngCorrection, parseDngOpcodes, parseOpcodeList } from './dng.ts';

// ---------------------------------------------------------------------------------------
// A tiny TIFF writer for synthetic DNGs: IFD0 (preview) -> SubIFD (raw).

interface Entry {
  tag: number;
  type: number;
  count: number;
  data: Uint8Array;
}

function bytes(le: boolean, size: number, values: number[], write: (v: DataView, o: number, x: number, le: boolean) => void): Uint8Array {
  const out = new Uint8Array(size * values.length);
  const v = new DataView(out.buffer);
  values.forEach((x, i) => write(v, i * size, x, le));
  return out;
}
const SHORT = (le: boolean, ...v: number[]): Entry => ({ tag: 0, type: 3, count: v.length, data: bytes(le, 2, v, (d, o, x, l) => d.setUint16(o, x, l)) });
const LONG = (le: boolean, ...v: number[]): Entry => ({ tag: 0, type: 4, count: v.length, data: bytes(le, 4, v, (d, o, x, l) => d.setUint32(o, x, l)) });
const RATIONAL = (le: boolean, ...v: number[]): Entry => ({
  tag: 0,
  type: 5,
  count: v.length,
  data: bytes(le, 8, v, (d, o, x, l) => {
    d.setUint32(o, x * 100, l);
    d.setUint32(o + 4, 100, l);
  }),
});
const UNDEFINED = (data: Uint8Array): Entry => ({ tag: 0, type: 7, count: data.length, data });
const tagged = (tag: number, e: Entry): Entry => ({ ...e, tag });

/** Lays out header, IFD0, raw IFD, then all out-of-line values. IFD0's SubIFDs points at the raw IFD. */
function buildTiff(le: boolean, ifd0: Entry[], raw: Entry[]): Uint8Array {
  const ifdSize = (n: number) => 2 + 12 * n + 4;
  const ifd0At = 8;
  const rawAt = ifd0At + ifdSize(ifd0.length + 1);
  let dataAt = rawAt + ifdSize(raw.length);
  const ifds = [[...ifd0, tagged(330, LONG(le, rawAt))], raw].map((list) => list.sort((a, b) => a.tag - b.tag));
  const total = dataAt + ifds.flat().reduce((s, e) => s + (e.data.length > 4 ? e.data.length + (e.data.length & 1) : 0), 0);
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  v.setUint16(0, le ? 0x4949 : 0x4d4d);
  v.setUint16(2, 42, le);
  v.setUint32(4, ifd0At, le);
  [ifd0At, rawAt].forEach((at, k) => {
    const list = ifds[k]!;
    v.setUint16(at, list.length, le);
    list.forEach((e, i) => {
      const o = at + 2 + 12 * i;
      v.setUint16(o, e.tag, le);
      v.setUint16(o + 2, e.type, le);
      v.setUint32(o + 4, e.count, le);
      if (e.data.length <= 4) out.set(e.data, o + 8);
      else {
        v.setUint32(o + 8, dataAt, le);
        out.set(e.data, dataAt);
        dataAt += e.data.length + (e.data.length & 1);
      }
    });
    v.setUint32(at + 2 + 12 * list.length, 0, le);
  });
  return out;
}

// Opcode lists are big-endian whatever the file's byte order.
function params(parts: (['u32', number] | ['f64', number] | ['f32', number])[]): Uint8Array {
  const size = parts.reduce((s, [t]) => s + (t === 'f64' ? 8 : 4), 0);
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  let o = 0;
  for (const [t, x] of parts) {
    if (t === 'u32') v.setUint32(o, x, false);
    else if (t === 'f32') v.setFloat32(o, x, false);
    else v.setFloat64(o, x, false);
    o += t === 'f64' ? 8 : 4;
  }
  return out;
}

function opcodeList(ops: { id: number; flags?: number; params: Uint8Array }[]): Uint8Array {
  const parts = [params([['u32', ops.length]])];
  for (const op of ops) {
    const head = params([['u32', op.id], ['u32', 0x01030000], ['u32', op.flags ?? 0], ['u32', op.params.length]]);
    parts.push(head, op.params);
  }
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const f64 = (...v: number[]) => v.map((x) => ['f64', x] as ['f64', number]);

const WARP = [
  [1.0004, -0.03, -0.09, 0.05],
  [1.0, -0.028, -0.092, 0.051],
  [0.9996, -0.026, -0.094, 0.052],
];
const WARP_CENTER: [number, number] = [0.47, 0.52];
const VIG = [-0.6, 0.3, -0.1, 0.02, -0.001];
const VIG_CENTER: [number, number] = [0.5, 0.49];

const warpParams = (kt: [number, number] = [0, 0]) =>
  params([['u32', 3], ...WARP.flatMap((k) => f64(...k, ...kt)), ...f64(...WARP_CENTER)]);
const vignetteParams = () => params(f64(...VIG, ...VIG_CENTER));
const gainMapParams = () =>
  params([
    ...([0, 0, 80, 120, 0, 3, 1, 1, 2, 2] as number[]).map((x) => ['u32', x] as ['u32', number]),
    ...f64(1, 1, 0, 0),
    ['u32', 1],
    ...([1, 1.1, 1.2, 1.3] as number[]).map((x) => ['f32', x] as ['f32', number]),
  ]);

// Raw image 128 x 84 with a 120 x 80 active area at (left 4, top 2).
function syntheticDng(le: boolean, list3: Uint8Array, list2 = opcodeList([{ id: 9, params: gainMapParams() }])): Uint8Array {
  return buildTiff(
    le,
    [tagged(254, LONG(le, 1)), tagged(256, LONG(le, 16)), tagged(257, LONG(le, 8)), tagged(262, SHORT(le, 2))],
    [
      tagged(254, LONG(le, 0)),
      tagged(256, LONG(le, 128)),
      tagged(257, LONG(le, 84)),
      tagged(262, SHORT(le, 32803)),
      tagged(50719, RATIONAL(le, 6, 4)),
      tagged(50720, SHORT(le, 108, 72)),
      tagged(50829, LONG(le, 2, 4, 82, 124)),
      tagged(51008, UNDEFINED(opcodeList([{ id: 4, params: params([['u32', 0], ['u32', 1]]) }]))),
      tagged(51009, UNDEFINED(list2)),
      tagged(51022, UNDEFINED(list3)),
    ],
  );
}

/** The DNG 1.6 WarpRectilinear formula (p. 91) in pixel-centre coordinates of a w x h image. */
function specWarp(k: number[], c: [number, number], w: number, h: number, x: number, y: number): [number, number] {
  const cx = c[0] * (w - 1);
  const cy = c[1] * (h - 1);
  const m = Math.hypot(Math.max(cx, w - 1 - cx), Math.max(cy, h - 1 - cy));
  const dx = (x - cx) / m;
  const dy = (y - cy) / m;
  const r2 = dx * dx + dy * dy;
  const f = k[0]! + k[1]! * r2 + k[2]! * r2 ** 2 + k[3]! * r2 ** 3;
  return [cx + m * f * dx, cy + m * f * dy];
}

function specVignette(k: number[], c: [number, number], w: number, h: number, x: number, y: number): number {
  const cx = c[0] * (w - 1);
  const cy = c[1] * (h - 1);
  const m = Math.hypot(Math.max(cx, w - 1 - cx), Math.max(cy, h - 1 - cy));
  const r2 = ((x - cx) ** 2 + (y - cy) ** 2) / (m * m);
  return 1 + k[0]! * r2 + k[1]! * r2 ** 2 + k[2]! * r2 ** 3 + k[3]! * r2 ** 4 + k[4]! * r2 ** 5;
}

describe('parseDngOpcodes', () => {
  for (const le of [true, false]) {
    it(`finds the raw SubIFD and decodes its opcode lists (${le ? 'II' : 'MM'})`, () => {
      const dng = parseDngOpcodes(syntheticDng(le, opcodeList([{ id: 3, params: vignetteParams() }, { id: 1, params: warpParams() }])))!;
      expect(dng.raw).toMatchObject({ width: 128, height: 84, activeArea: [2, 4, 82, 124], newSubfileType: 0, photometric: 32803 });
      expect(dng.raw.defaultCropOrigin).toEqual([6, 4]);
      expect(dng.raw.defaultCropSize).toEqual([108, 72]);
      expect(dng.list1.map((o) => o.name)).toEqual(['FixBadPixelsConstant']);
      expect(dng.list2.map((o) => o.name)).toEqual(['GainMap']);
      expect(dng.list3.map((o) => [o.id, o.name, o.version])).toEqual([
        [3, 'FixVignetteRadial', '1.3.0.0'],
        [1, 'WarpRectilinear', '1.3.0.0'],
      ]);
      const warp = dng.list3[1]!.warp!;
      expect(warp.planes).toHaveLength(3);
      expect(warp.planes[2]!.radial).toEqual([0.9996, 0, -0.026, 0, -0.094, 0, 0.052]);
      expect(warp.center).toEqual(WARP_CENTER);
      expect(dng.list3[0]!.vignette).toEqual({ k: VIG, center: VIG_CENTER });
      const gm = dng.list2[0]!.gainMap!;
      expect(gm).toMatchObject({ area: [0, 0, 80, 120], planes: 3, pointsV: 2, pointsH: 2, mapPlanes: 1 });
      expect(Array.from(gm.gains)).toEqual([1, 1.1, 1.2, 1.3].map(Math.fround));
    });
  }

  it('returns null for non-TIFF data and an empty list for garbage', () => {
    expect(parseDngOpcodes(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]))).toBeNull();
    expect(parseOpcodeList(new Uint8Array([0, 0, 0, 5, 0, 0]))).toEqual([]);
  });
});

describe('dngCorrection', () => {
  const W = 120;
  const H = 80;
  const at = (x: number, y: number) => [(x + 0.5) / W, (y + 0.5) / H] as const;

  it('maps WarpRectilinear and FixVignetteRadial exactly onto the active area', () => {
    const dng = parseDngOpcodes(syntheticDng(true, opcodeList([{ id: 3, params: vignetteParams() }, { id: 1, params: warpParams() }])))!;
    // Works for the full decode and for LibRaw's half-size decode alike.
    for (const decoded of [{ width: 120, height: 80 }, { width: 60, height: 40 }]) {
      const corr = dngCorrection(dng, decoded)!;
      expect(corr.source).toBe('DNG opcodes');
      expect(corr.vignetting!.mode).toBe('multiply');
      for (const [x, y] of [[0, 0], [119, 79], [60, 10], [3, 70], [56.4, 41.6]] as const) {
        for (const c of [0, 1, 2] as const) {
          const [ex, ey] = specWarp(WARP[c]!, WARP_CENTER, W, H, x, y);
          const [sx, sy] = sourcePoint(corr, ...at(x, y), c);
          expect(sx * W - 0.5).toBeCloseTo(ex, 9);
          expect(sy * H - 0.5).toBeCloseTo(ey, 9);
        }
        expect(vignetteGain(corr, ...at(x, y))).toBeCloseTo(specVignette(VIG, VIG_CENTER, W, H, x, y), 12);
      }
      // The farthest pixel centre is at r = 1.
      expect(autoScale(corr)).toBeGreaterThan(0.5);
    }
  });

  it('flags non-zero tangential terms, which the model cannot hold', () => {
    const dng = parseDngOpcodes(syntheticDng(true, opcodeList([{ id: 1, params: warpParams([1e-4, 0]) }])))!;
    expect(dngCorrection(dng, { width: 120, height: 80 })!.source).toBe('DNG opcodes (tangential terms ignored)');
  });

  it('refuses a decoded image that is not the active area', () => {
    const dng = parseDngOpcodes(syntheticDng(true, opcodeList([{ id: 1, params: warpParams() }])))!;
    expect(dngCorrection(dng, { width: 128, height: 70 })).toBeNull();
  });

  it('re-expresses a vignette that runs after the warp in decoded coordinates', () => {
    const dng = parseDngOpcodes(syntheticDng(true, opcodeList([{ id: 1, params: warpParams() }, { id: 3, params: params(f64(...VIG, ...WARP_CENTER)) }])))!;
    const corr = dngCorrection(dng, { width: 120, height: 80 })!;
    // The gain of output pixel p is applied at its warped position; its source pixel gets it.
    for (const [x, y] of [[0, 0], [119, 79], [60, 10], [30, 50]] as const) {
      const [sx, sy] = sourcePoint(corr, ...at(x, y), 1);
      expect(vignetteGain(corr, sx, sy)).toBeCloseTo(specVignette(VIG, WARP_CENTER, W, H, x, y), 4);
    }
  });

  it('applies the WarpRectilinear2 skip rule and evaluates its polynomial', () => {
    const kr = [1, 0.01, -0.05, 0, 0.002, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const wr2 = params([['u32', 1], ...f64(...kr, 0, 0, 0, 1), ...f64(0.5, 0.5), ['u32', 0]]);
    const dng = parseDngOpcodes(syntheticDng(true, opcodeList([{ id: 14, flags: 1, params: wr2 }, { id: 1, params: warpParams() }])))!;
    const corr = dngCorrection(dng, { width: 120, height: 80 })!;
    expect(corr.geometry!.poly[0]).toEqual([1, 0.01, -0.05, 0, 0.002, 0, 0]);
  });

  it('fits a reciprocal WarpRectilinear2 (r_real = r / f(r))', () => {
    const kr = [1, 0, 0.08, 0, 0, 0, 0, 0, 0.01, 0, 0, 0, 0, 0, 0];
    const wr2 = params([['u32', 1], ...f64(...kr, 0, 0, 0, 1), ...f64(0.5, 0.5), ['u32', 1]]);
    const dng = parseDngOpcodes(syntheticDng(true, opcodeList([{ id: 14, params: wr2 }])))!;
    const corr = dngCorrection(dng, { width: 120, height: 80 })!;
    const g = corr.geometry!;
    for (let i = 0; i <= 50; i++) {
      const r = i / 50;
      const f = 1 + 0.08 * r ** 2 + 0.01 * r ** 8;
      const [sx, sy] = sourcePoint(corr, g.center[0] + r / g.scale[0], g.center[1], 1);
      expect(Math.hypot((sx - g.center[0]) * g.scale[0], (sy - g.center[1]) * g.scale[1])).toBeCloseTo(r / f, 6);
    }
  });
});

// Real file: set RAW_SAMPLES_DIR to the folder from spikes/decode-bench/fetch-samples.mjs.
const leica = env.RAW_SAMPLES_DIR ? `${env.RAW_SAMPLES_DIR}/leica-q2.DNG` : '';

describe.skipIf(!leica || !existsSync(leica))('Leica Q2 DNG', () => {
  it('has a 3-plane WarpRectilinear in OpcodeList3 over the active area LibRaw decodes', () => {
    const dng = parseDngOpcodes(readFileSync(leica))!;
    // LibRaw 0.22.1 decodes this file to 8392 x 5632 (docs/spike-results.md bench) = the active area.
    expect(dng.raw).toMatchObject({ width: 8424, height: 5632, activeArea: [0, 0, 5632, 8392] });
    expect(dng.raw.defaultCropOrigin).toEqual([12, 24]);
    expect(dng.raw.defaultCropSize).toEqual([8368, 5584]);
    expect(dng.list1.map((o) => o.name)).toEqual(['FixBadPixelsConstant']);
    expect(dng.list2).toEqual([]);
    expect(dng.list3.map((o) => o.name)).toEqual(['WarpRectilinear']);
    const warp = dng.list3[0]!.warp!;
    expect(warp.planes).toHaveLength(3);
    expect(warp.center).toEqual([0.5, 0.5]);
    for (const p of warp.planes) expect(p.tangential).toEqual([0, 0]);

    const corr = dngCorrection(dng, { width: 8392, height: 5632 })!;
    expect(corr.vignetting).toBeNull();
    // Strong barrel distortion: the corner samples well inside the image.
    const [sx] = sourcePoint(corr, 0, 0, 1);
    expect(sx).toBeGreaterThan(0.02);
    expect(autoScale(corr)).toBeLessThan(1);
  });
});
