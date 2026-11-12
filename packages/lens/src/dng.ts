// Minimal TIFF/DNG reader for the lens-correction opcodes, and their conversion to the
// renderer's LensCorrection.
//
// Reference: Adobe DNG Specification 1.6.0.0, "Opcode List Processing" (pp. 89-106).
// Opcode lists are always big-endian, whatever the file's byte order.
//
// Coordinate spaces (how the opcodes relate to the image the editor decodes):
// - LibRaw 0.22.1 (libraw-wasm 1.6.0) crops a DNG to its ActiveArea (tiff.cpp, tag 50829
//   sets top/left_margin, width, height) and does NOT apply the DefaultCrop (only stored
//   in sizes.raw_inset_crops) or any opcode except a MapPolynomial in OpcodeList2 for
//   lossy DNGs (decoders/dng.cpp). The decoded image is therefore the active area,
//   uncorrected (or exactly half of it with halfSize).
// - OpcodeList2 and OpcodeList3 work on the stage 2/3 image, which is the active area
//   too, so their coordinates map 1:1 onto the decoded image. OpcodeList1 works on the
//   whole raw IFD image (masked borders included).
// - The spec measures positions at pixel centres: (x0, y0) / (x1, y1) are the top-left /
//   bottom-right *pixels*, so x1 = x0 + width - 1.
import { IDENTITY_POLY, type LensCorrection, type RadialPoly } from './types.ts';
import { fitRadialPoly, leastSquares } from './fit.ts';

export const OPCODE_NAMES: Record<number, string> = {
  1: 'WarpRectilinear',
  2: 'WarpFisheye',
  3: 'FixVignetteRadial',
  4: 'FixBadPixelsConstant',
  5: 'FixBadPixelsList',
  6: 'TrimBounds',
  7: 'MapTable',
  8: 'MapPolynomial',
  9: 'GainMap',
  10: 'DeltaPerRow',
  11: 'DeltaPerColumn',
  12: 'ScalePerRow',
  13: 'ScalePerColumn',
  14: 'WarpRectilinear2',
};

/** Radial (and tangential) warp of WarpRectilinear (1) or WarpRectilinear2 (14). */
export interface DngWarp {
  /**
   * One set per plane (1 = all planes alike, or 3 = R, G, B). `radial[p]` multiplies r^p:
   * WarpRectilinear's kr0..kr3 land on p = 0, 2, 4, 6; WarpRectilinear2 has p = 0..14.
   */
  planes: { radial: number[]; tangential: [number, number]; validRadius: [number, number] }[];
  /** Optical centre, normalised to the opcode's image (0.5, 0.5 = centre). */
  center: [number, number];
  /** WarpRectilinear2 only: r_real = r / f(r) instead of r * f(r). */
  reciprocal: boolean;
}

/** FixVignetteRadial (3): g = 1 + k0 r² + k1 r⁴ + k2 r⁶ + k3 r⁸ + k4 r¹⁰, value *= g. */
export interface DngVignette {
  k: [number, number, number, number, number];
  center: [number, number];
}

/** GainMap (9), decoded but not converted (the renderer has no gain-map stage yet). */
export interface DngGainMap {
  /** top, left, bottom, right */
  area: [number, number, number, number];
  plane: number;
  planes: number;
  rowPitch: number;
  colPitch: number;
  pointsV: number;
  pointsH: number;
  spacingV: number;
  spacingH: number;
  originV: number;
  originH: number;
  mapPlanes: number;
  gains: Float32Array;
}

export interface DngOpcode {
  id: number;
  name: string;
  /** DNG version the opcode was defined in, e.g. "1.3.0.0". */
  version: string;
  /** Bit 0: optional, bit 1: may be skipped for previews. */
  flags: number;
  /** Raw parameter bytes (big-endian). */
  params: Uint8Array;
  warp?: DngWarp;
  vignette?: DngVignette;
  gainMap?: DngGainMap;
}

export interface DngRawInfo {
  /** Size of the raw IFD's image in pixels (stage 1, masked borders included). */
  width: number;
  height: number;
  /** [top, left, bottom, right]; the whole image when the tag is missing. */
  activeArea: [number, number, number, number];
  /** Relative to the active area's top-left, raw pixels (before DefaultScale): [x, y]. */
  defaultCropOrigin: [number, number] | null;
  /** [width, height] */
  defaultCropSize: [number, number] | null;
  newSubfileType: number;
  photometric: number;
}

export interface DngOpcodes {
  raw: DngRawInfo;
  /** OpcodeList1 (stage 1: raw IFD image), 2 (stage 2: active area), 3 (stage 3: active area, demosaiced). */
  list1: DngOpcode[];
  list2: DngOpcode[];
  list3: DngOpcode[];
}

// ---------------------------------------------------------------------------------------
// TIFF structure

interface IfdEntry {
  tag: number;
  type: number;
  count: number;
  /** Absolute offset of the value bytes. */
  offset: number;
}

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4, 16: 8, 17: 8, 18: 8 };

class TiffReader {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  readonly little: boolean;
  readonly big: boolean;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const order = this.view.getUint16(0, false);
    if (order !== 0x4949 && order !== 0x4d4d) throw new Error('Not a TIFF file');
    this.little = order === 0x4949;
    const magic = this.u16(2);
    if (magic !== 42 && magic !== 43) throw new Error('Not a TIFF file');
    this.big = magic === 43;
  }

  u16(o: number) {
    return this.view.getUint16(o, this.little);
  }
  u32(o: number) {
    return this.view.getUint32(o, this.little);
  }
  u64(o: number) {
    return Number(this.view.getBigUint64(o, this.little));
  }

  firstIfd(): number {
    return this.big ? this.u64(8) : this.u32(4);
  }

  /** Reads the IFD at `offset`; returns its entries and the next IFD's offset (0 = none). */
  ifd(offset: number): { entries: Map<number, IfdEntry>; next: number } {
    const entries = new Map<number, IfdEntry>();
    const n = this.big ? this.u64(offset) : this.u16(offset);
    const head = this.big ? 8 : 2;
    const size = this.big ? 20 : 12;
    const inline = this.big ? 8 : 4;
    for (let i = 0; i < n; i++) {
      const e = offset + head + i * size;
      const tag = this.u16(e);
      const type = this.u16(e + 2);
      const count = this.big ? this.u64(e + 4) : this.u32(e + 4);
      const valueAt = e + (this.big ? 12 : 8);
      const bytes = (TYPE_SIZE[type] ?? 1) * count;
      const at = bytes <= inline ? valueAt : this.big ? this.u64(valueAt) : this.u32(valueAt);
      if (at + bytes <= this.bytes.length) entries.set(tag, { tag, type, count, offset: at });
    }
    const nextAt = offset + head + n * size;
    const next = nextAt + inline <= this.bytes.length ? (this.big ? this.u64(nextAt) : this.u32(nextAt)) : 0;
    return { entries, next };
  }

  /** Numeric values of an entry (integers, rationals and floats). */
  numbers(e: IfdEntry | undefined): number[] {
    if (!e) return [];
    const out: number[] = [];
    const v = this.view;
    const le = this.little;
    for (let i = 0; i < e.count; i++) {
      switch (e.type) {
        case 1: case 7: out.push(v.getUint8(e.offset + i)); break;
        case 6: out.push(v.getInt8(e.offset + i)); break;
        case 3: out.push(v.getUint16(e.offset + 2 * i, le)); break;
        case 8: out.push(v.getInt16(e.offset + 2 * i, le)); break;
        case 4: case 13: out.push(v.getUint32(e.offset + 4 * i, le)); break;
        case 9: out.push(v.getInt32(e.offset + 4 * i, le)); break;
        case 5: out.push(v.getUint32(e.offset + 8 * i, le) / v.getUint32(e.offset + 8 * i + 4, le)); break;
        case 10: out.push(v.getInt32(e.offset + 8 * i, le) / v.getInt32(e.offset + 8 * i + 4, le)); break;
        case 11: out.push(v.getFloat32(e.offset + 4 * i, le)); break;
        case 12: out.push(v.getFloat64(e.offset + 8 * i, le)); break;
        case 16: case 18: out.push(Number(v.getBigUint64(e.offset + 8 * i, le))); break;
        case 17: out.push(Number(v.getBigInt64(e.offset + 8 * i, le))); break;
        default: return out;
      }
    }
    return out;
  }

  raw(e: IfdEntry): Uint8Array {
    return this.bytes.subarray(e.offset, e.offset + (TYPE_SIZE[e.type] ?? 1) * e.count);
  }
}

const TAG = {
  NewSubfileType: 254,
  ImageWidth: 256,
  ImageLength: 257,
  Photometric: 262,
  SubIFDs: 330,
  DefaultCropOrigin: 50719,
  DefaultCropSize: 50720,
  ActiveArea: 50829,
  OpcodeList1: 51008,
  OpcodeList2: 51009,
  OpcodeList3: 51022,
} as const;

/** All IFDs reachable from IFD0: the IFD0 chain and SubIFD trees, depth first. */
function collectIfds(r: TiffReader): Map<number, IfdEntry>[] {
  const out: Map<number, IfdEntry>[] = [];
  const seen = new Set<number>();
  const visit = (offset: number, depth: number) => {
    while (offset > 0 && offset < r.bytes.length && !seen.has(offset) && depth < 8 && out.length < 64) {
      seen.add(offset);
      const { entries, next } = r.ifd(offset);
      out.push(entries);
      for (const sub of r.numbers(entries.get(TAG.SubIFDs))) visit(sub, depth + 1);
      offset = next;
    }
  };
  visit(r.firstIfd(), 0);
  return out;
}

const RAW_PHOTOMETRIC = new Set([32803 /* CFA */, 34892 /* LinearRaw */]);

/**
 * Finds the full-resolution raw IFD (NewSubfileType 0, CFA or LinearRaw if there is a
 * choice) and decodes its opcode lists. Returns null for files that are not TIFF-based
 * or have no raw IFD.
 */
export function parseDngOpcodes(bytes: Uint8Array): DngOpcodes | null {
  let r: TiffReader;
  try {
    r = new TiffReader(bytes);
  } catch {
    return null;
  }
  const ifds = collectIfds(r);
  const first = (e: Map<number, IfdEntry>, tag: number, fallback: number) => r.numbers(e.get(tag))[0] ?? fallback;
  const candidates = ifds
    .filter((e) => first(e, TAG.NewSubfileType, 0) === 0 && e.has(TAG.ImageWidth))
    .sort((a, b) => {
      const ra = RAW_PHOTOMETRIC.has(first(a, TAG.Photometric, 0)) ? 1 : 0;
      const rb = RAW_PHOTOMETRIC.has(first(b, TAG.Photometric, 0)) ? 1 : 0;
      if (ra !== rb) return rb - ra;
      return first(b, TAG.ImageWidth, 0) * first(b, TAG.ImageLength, 0) - first(a, TAG.ImageWidth, 0) * first(a, TAG.ImageLength, 0);
    });
  const ifd = candidates[0];
  if (!ifd) return null;

  const width = first(ifd, TAG.ImageWidth, 0);
  const height = first(ifd, TAG.ImageLength, 0);
  const aa = r.numbers(ifd.get(TAG.ActiveArea));
  const activeArea: [number, number, number, number] = aa.length === 4 ? [aa[0]!, aa[1]!, aa[2]!, aa[3]!] : [0, 0, height, width];
  const co = r.numbers(ifd.get(TAG.DefaultCropOrigin));
  const cs = r.numbers(ifd.get(TAG.DefaultCropSize));

  // Opcodes belong on the raw IFD; some writers put them on IFD0 when that is not the raw.
  const listOf = (tag: number) => {
    const e = ifd.get(tag) ?? ifds[0]?.get(tag);
    return e ? parseOpcodeList(r.raw(e)) : [];
  };

  return {
    raw: {
      width,
      height,
      activeArea,
      defaultCropOrigin: co.length === 2 ? [co[0]!, co[1]!] : null,
      defaultCropSize: cs.length === 2 ? [cs[0]!, cs[1]!] : null,
      newSubfileType: first(ifd, TAG.NewSubfileType, 0),
      photometric: first(ifd, TAG.Photometric, 0),
    },
    list1: listOf(TAG.OpcodeList1),
    list2: listOf(TAG.OpcodeList2),
    list3: listOf(TAG.OpcodeList3),
  };
}

/** Tags worth carrying over when a DNG is re-encoded as a new DNG (Convert to DNG). */
export interface DngCarryOver {
  /** Raw opcode list bytes (big-endian, as stored). */
  opcodeList1?: Uint8Array;
  opcodeList2?: Uint8Array;
  opcodeList3?: Uint8Array;
  /** The raw IFD's active area starts here; opcode lists 2 and 3 are relative to it. */
  activeAreaOrigin: [number, number];
  colorMatrix1?: number[];
  colorMatrix2?: number[];
  forwardMatrix1?: number[];
  forwardMatrix2?: number[];
  calibrationIlluminant1?: number;
  calibrationIlluminant2?: number;
  baselineExposure?: number;
}

const COLOR_TAG = {
  ColorMatrix1: 50721,
  ColorMatrix2: 50722,
  CalibrationIlluminant1: 50778,
  CalibrationIlluminant2: 50779,
  BaselineExposure: 50730,
  ForwardMatrix1: 50964,
  ForwardMatrix2: 50965,
} as const;

/** Reads the colour and opcode tags of a DNG; null if it isn't one. */
export function readDngCarryOver(bytes: Uint8Array): DngCarryOver | null {
  let r: TiffReader;
  try {
    r = new TiffReader(bytes);
  } catch {
    return null;
  }
  const ifds = collectIfds(r);
  const ifd0 = ifds[0];
  const parsed = parseDngOpcodes(bytes);
  if (!ifd0 || !parsed) return null;
  const rawIfd = ifds.find((e) => r.numbers(e.get(TAG.NewSubfileType))[0] === 0 && RAW_PHOTOMETRIC.has(r.numbers(e.get(TAG.Photometric))[0] ?? 0)) ?? ifd0;
  const list = (tag: number) => {
    const e = rawIfd.get(tag) ?? ifd0.get(tag);
    return e ? r.raw(e).slice() : undefined;
  };
  const nums = (tag: number, n: number) => {
    const v = r.numbers(ifd0.get(tag) ?? rawIfd.get(tag));
    return v.length === n && v.every(Number.isFinite) ? v : undefined;
  };
  return {
    opcodeList1: list(TAG.OpcodeList1),
    opcodeList2: list(TAG.OpcodeList2),
    opcodeList3: list(TAG.OpcodeList3),
    activeAreaOrigin: [parsed.raw.activeArea[0], parsed.raw.activeArea[1]],
    colorMatrix1: nums(COLOR_TAG.ColorMatrix1, 9),
    colorMatrix2: nums(COLOR_TAG.ColorMatrix2, 9),
    forwardMatrix1: nums(COLOR_TAG.ForwardMatrix1, 9),
    forwardMatrix2: nums(COLOR_TAG.ForwardMatrix2, 9),
    calibrationIlluminant1: nums(COLOR_TAG.CalibrationIlluminant1, 1)?.[0],
    calibrationIlluminant2: nums(COLOR_TAG.CalibrationIlluminant2, 1)?.[0],
    baselineExposure: nums(COLOR_TAG.BaselineExposure, 1)?.[0],
  };
}

// ---------------------------------------------------------------------------------------
// Opcode lists

/** Decodes one opcode list (big-endian). Stops at the first truncated opcode. */
export function parseOpcodeList(data: Uint8Array): DngOpcode[] {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length < 4) return [];
  const count = v.getUint32(0, false);
  const out: DngOpcode[] = [];
  let o = 4;
  for (let i = 0; i < count && o + 16 <= data.length; i++) {
    const id = v.getUint32(o, false);
    const version = [0, 1, 2, 3].map((k) => data[o + 4 + k]).join('.');
    const flags = v.getUint32(o + 8, false);
    const size = v.getUint32(o + 12, false);
    if (o + 16 + size > data.length) break;
    const params = data.subarray(o + 16, o + 16 + size);
    const op: DngOpcode = { id, name: OPCODE_NAMES[id] ?? `Unknown(${id})`, version, flags, params };
    try {
      if (id === 1 || id === 14) op.warp = decodeWarp(params, id);
      else if (id === 3) op.vignette = decodeVignette(params);
      else if (id === 9) op.gainMap = decodeGainMap(params);
    } catch {
      // Malformed parameters: keep the opcode, without decoded values.
    }
    out.push(op);
    o += 16 + size;
  }
  return out;
}

function decodeWarp(p: Uint8Array, id: 1 | 14): DngWarp {
  const v = new DataView(p.buffer, p.byteOffset, p.byteLength);
  const n = v.getUint32(0, false);
  if (n !== 1 && n !== 3) throw new Error('bad plane count');
  const perPlane = id === 1 ? 6 : 19;
  const d = (i: number) => v.getFloat64(4 + 8 * i, false);
  const planes: DngWarp['planes'] = [];
  for (let k = 0; k < n; k++) {
    const b = k * perPlane;
    if (id === 1) {
      planes.push({ radial: [d(b), 0, d(b + 1), 0, d(b + 2), 0, d(b + 3)], tangential: [d(b + 4), d(b + 5)], validRadius: [0, Infinity] });
    } else {
      const radial = Array.from({ length: 15 }, (_, i) => d(b + i));
      planes.push({ radial, tangential: [d(b + 15), d(b + 16)], validRadius: [d(b + 17), d(b + 18)] });
    }
  }
  const c = n * perPlane;
  const reciprocal = id === 14 ? v.getUint32(4 + 8 * (c + 2), false) !== 0 : false;
  return { planes, center: [d(c), d(c + 1)], reciprocal };
}

function decodeVignette(p: Uint8Array): DngVignette {
  const v = new DataView(p.buffer, p.byteOffset, p.byteLength);
  const d = (i: number) => v.getFloat64(8 * i, false);
  return { k: [d(0), d(1), d(2), d(3), d(4)], center: [d(5), d(6)] };
}

function decodeGainMap(p: Uint8Array): DngGainMap {
  const v = new DataView(p.buffer, p.byteOffset, p.byteLength);
  const u = (i: number) => v.getUint32(4 * i, false);
  const d = (i: number) => v.getFloat64(40 + 8 * i, false);
  const pointsV = u(8);
  const pointsH = u(9);
  const mapPlanes = v.getUint32(72, false);
  const n = pointsV * pointsH * mapPlanes;
  if (76 + 4 * n > p.length) throw new Error('truncated gain map');
  const gains = new Float32Array(n);
  for (let i = 0; i < n; i++) gains[i] = v.getFloat32(76 + 4 * i, false);
  return {
    area: [u(0), u(1), u(2), u(3)],
    plane: u(4),
    planes: u(5),
    rowPitch: u(6),
    colPitch: u(7),
    pointsV,
    pointsH,
    spacingV: d(0),
    spacingH: d(1),
    originV: d(2),
    originH: d(3),
    mapPlanes,
    gains,
  };
}

// ---------------------------------------------------------------------------------------
// Conversion

/** Opcodes in processing order, with the WarpRectilinear2 skip rule (spec p. 105) applied. */
function effectiveOpcodes(dng: DngOpcodes): { op: DngOpcode; list: 1 | 2 | 3 }[] {
  const out: { op: DngOpcode; list: 1 | 2 | 3 }[] = [];
  for (const [list, ops] of [[1, dng.list1], [2, dng.list2], [3, dng.list3]] as const) {
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i]!;
      out.push({ op, list });
      const next = ops[i + 1];
      if (op.id === 14 && op.warp && op.flags & 1 && next && (next.id === 1 || next.id === 2)) i++;
    }
  }
  return out;
}

/**
 * Pixel bounds of the image an opcode list works on, relative to the active area
 * (= the decoded image): OpcodeList1 sees the whole raw IFD image.
 */
function listBounds(dng: DngOpcodes, list: 1 | 2 | 3) {
  const [top, left, bottom, right] = dng.raw.activeArea;
  const aw = right - left;
  const ah = bottom - top;
  if (list === 1) return { x0: -left, y0: -top, w: dng.raw.width, h: dng.raw.height, aw, ah };
  return { x0: 0, y0: 0, w: aw, h: ah, aw, ah };
}

/**
 * The radial frame of an opcode with optical centre `c` (normalised to its image), in
 * the decoded image's normalised coordinates. Per the spec, positions are pixel centres:
 * cx = x0 + ĉx (x1 - x0) with x1 = x0 + w - 1, and m is the distance from the centre to
 * the farthest pixel centre.
 */
function opcodeFrame(dng: DngOpcodes, list: 1 | 2 | 3, c: [number, number]) {
  const b = listBounds(dng, list);
  const cx = b.x0 + c[0] * (b.w - 1);
  const cy = b.y0 + c[1] * (b.h - 1);
  const mx = Math.max(Math.abs(b.x0 - cx), Math.abs(b.x0 + b.w - 1 - cx));
  const my = Math.max(Math.abs(b.y0 - cy), Math.abs(b.y0 + b.h - 1 - cy));
  const m = Math.hypot(mx, my);
  // Decoded pixel i covers [i, i+1) / size in normalised coordinates, its centre is i + 0.5.
  return {
    center: [(cx + 0.5) / b.aw, (cy + 0.5) / b.ah] as [number, number],
    scale: [b.aw / m, b.ah / m] as [number, number],
  };
}

/**
 * Radius range for fitting a warp the polynomial cannot hold exactly: the image ends at
 * r = 1 by construction of m; the margin covers auto-scale zooming out a little.
 */
const WARP_FIT_RANGE = 1.05;

function warpPoly(plane: DngWarp['planes'][number], reciprocal: boolean): RadialPoly {
  const [lo, hi] = plane.validRadius;
  const exact = !reciprocal && plane.radial.slice(7).every((k) => k === 0) && lo <= 0 && hi >= 1;
  if (exact) {
    const p = [...IDENTITY_POLY] as RadialPoly;
    for (let i = 0; i < 7; i++) p[i] = plane.radial[i] ?? 0;
    return p;
  }
  const f = (r: number) => {
    const rc = Math.min(hi, Math.max(lo, r));
    let s = 0;
    for (let p = plane.radial.length - 1; p >= 0; p--) s = s * rc + plane.radial[p]!;
    return reciprocal ? 1 / s : s;
  };
  // Not across the clamp at max_valid_radius when it sits at the border: the kink would
  // cost accuracy inside the image.
  return fitRadialPoly((r) => r * f(r), Math.max(1, Math.min(WARP_FIT_RANGE, hi)));
}

/**
 * Converts the WarpRectilinear(2) and FixVignetteRadial opcodes of a DNG into a
 * LensCorrection for the decoded (LibRaw) image of `decoded.width` x `decoded.height`
 * pixels, which must be the active area or a uniform scale of it (half-size decodes).
 *
 * - Tangential warp terms (kt0, kt1) have no place in the contract and are ignored; the
 *   `source` string says so when they are non-zero.
 * - A FixVignetteRadial that runs after the warp (later in the same list, or in a later
 *   list) measures its radius in corrected coordinates. It is re-expressed in decoded
 *   coordinates by a least-squares fit, which is exact enough for a smooth falloff.
 * - WarpFisheye is not rectilinear and is not converted.
 */
export function dngCorrection(dng: DngOpcodes, decoded: { width: number; height: number }): LensCorrection | null {
  const [top, left, bottom, right] = dng.raw.activeArea;
  const aw = right - left;
  const ah = bottom - top;
  if (!(aw > 0 && ah > 0) || Math.abs(decoded.width / decoded.height - aw / ah) > 0.01 * (aw / ah)) return null;

  const ops = effectiveOpcodes(dng);
  const warpAt = ops.findIndex(({ op }) => (op.id === 1 || op.id === 14) && op.warp);
  const vigAt = ops.findIndex(({ op }) => op.id === 3 && op.vignette);
  const notes: string[] = [];

  let geometry: LensCorrection['geometry'] = null;
  if (warpAt >= 0) {
    const { op, list } = ops[warpAt]!;
    const warp = op.warp!;
    const planes = warp.planes.length === 3 ? warp.planes : [warp.planes[0]!, warp.planes[0]!, warp.planes[0]!];
    if (planes.some((p) => p.tangential[0] !== 0 || p.tangential[1] !== 0)) notes.push('tangential terms ignored');
    const poly = planes.map((p) => warpPoly(p, warp.reciprocal)) as [RadialPoly, RadialPoly, RadialPoly];
    geometry = { ...opcodeFrame(dng, list, warp.center), poly };
  }

  let vignetting: LensCorrection['vignetting'] = null;
  if (vigAt >= 0) {
    const { op, list } = ops[vigAt]!;
    const vig = op.vignette!;
    const frame = opcodeFrame(dng, list, vig.center);
    if (geometry && vigAt > warpAt && vig.k.some((k) => k !== 0)) {
      vignetting = { ...frame, mode: 'multiply', k: vignetteAfterWarp(geometry, frame, vig.k) };
    } else {
      vignetting = { ...frame, mode: 'multiply', k: [...vig.k] };
    }
  }

  if (!geometry && !vignetting) return null;
  return { source: notes.length ? `DNG opcodes (${notes.join(', ')})` : 'DNG opcodes', geometry, vignetting };
}

/**
 * Gain coefficients in decoded coordinates for a vignette that the DNG applies after the
 * warp. Samples decoded radii along the diagonal, finds the corrected point that lands
 * there (green channel) and fits g in even powers of the decoded radius.
 */
function vignetteAfterWarp(
  geometry: NonNullable<LensCorrection['geometry']>,
  frame: { center: [number, number]; scale: [number, number] },
  k: [number, number, number, number, number],
): [number, number, number, number, number] {
  const g = (r: number) => {
    const r2 = r * r;
    return k[0] * r2 + k[1] * r2 ** 2 + k[2] * r2 ** 3 + k[3] * r2 ** 4 + k[4] * r2 ** 5;
  };
  const green = geometry.poly[1];
  const dist = (r: number) => {
    let s = 0;
    for (let i = 6; i >= 0; i--) s = s * r + green[i]!;
    return r * s;
  };
  // Assumes geometry and vignette share their centre, which is how cameras write them.
  // Radii convert between the two frames through their scales (both are pixels / m).
  const toVig = frame.scale[0] / geometry.scale[0];
  const samples: [number, number][] = [];
  for (let i = 0; i <= 200; i++) {
    const rSrcV = (i / 200) * 1.05;
    const rSrcG = rSrcV / toVig;
    // Invert the warp along the ray by Newton iteration.
    let ru = rSrcG;
    for (let it = 0; it < 30; it++) {
      const h = 1e-6;
      const d = (dist(ru + h) - dist(ru - h)) / (2 * h);
      const step = (dist(ru) - rSrcG) / (d || 1);
      ru -= step;
      if (Math.abs(step) < 1e-12) break;
    }
    samples.push([rSrcV, g(ru * toVig)]);
  }
  return fitEvenGain(samples);
}

/** Least-squares fit of y ≈ k0 r² + … + k4 r¹⁰. */
function fitEvenGain(samples: [number, number][]): [number, number, number, number, number] {
  const rows = samples.map(([r]) => [r ** 2, r ** 4, r ** 6, r ** 8, r ** 10]);
  const k = leastSquares(rows, samples.map(([, y]) => y));
  return [k[0]!, k[1]!, k[2]!, k[3]!, k[4]!];
}
