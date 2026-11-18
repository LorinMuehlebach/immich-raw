// Camera profiles from Adobe's DNG Camera Profile files (.dcp), as Lightroom installs them.
//
// Adobe's profiles are Adobe's, so none is shipped with the editor: a profile is converted from the
// user's own copy (packages/pipeline/scripts/convert-camera-profiles.mjs) into a compact JSON file
// that stays out of git, and the editor loads it for the camera that took the photo.
//
// What is used: the hue/saturation map (the editor's Standard) and the look table that Lightroom's "Adobe
// Color" adds on top of it (the editor's Color). The DCP has one map per calibration illuminant; the two are blended by the photo's
// colour temperature, as the DNG specification describes. Adobe's matrices are left out: on their
// own they are colourimetric, and the colour of an Adobe profile is in these tables.
import { applyLookCpu, dngHsvToRgb, dngRgbToHsv, type HueSatTable } from './dcp.ts';

export interface CameraProfileTable {
  /** Hue, saturation and value divisions. */
  dims: [number, number, number];
  /** The value axis is sRGB-encoded (DNG table encoding 1); otherwise linear. */
  srgbValues: boolean;
  /** Per node: hue shift (degrees), saturation scale, value scale. DNG order: ((v*H + h)*S + s)*3. */
  data: Float32Array;
}

export interface CameraProfileData {
  schema: 1;
  /** The DCP's UniqueCameraModel, e.g. "Fujifilm X-T30". */
  model: string;
  /** The DCP's profile name, e.g. "Adobe Standard". */
  name: string;
  /** EXIF light source codes the two hue/saturation maps were made for (17 = Standard A, 21 = D65). */
  illuminants: [number, number];
  /** The hue/saturation map for each illuminant (the second is null for a single-illuminant profile). */
  hueSat: { first: CameraProfileTable; second: CameraProfileTable | null } | null;
  /** The profile's look table: what "Adobe Color" adds to the hue/saturation map. */
  look: CameraProfileTable | null;
}

export type CameraProfileKind = 'standard' | 'color';

/** Colour temperature (K) of the EXIF light source codes a DCP uses. */
const ILLUMINANT_KELVIN: Record<number, number> = {
  17: 2856, // Standard light A
  18: 4874, // B
  19: 6774, // C
  20: 5503, // D55
  21: 6504, // D65
  22: 7504, // D75
  23: 5003, // D50
};

// --- The binary DCP ---------------------------------------------------------------------

const TAG = {
  UniqueCameraModel: 50708,
  CalibrationIlluminant1: 50778,
  CalibrationIlluminant2: 50779,
  ProfileName: 50936,
  HueSatMapDims: 50937,
  HueSatMapData1: 50938,
  HueSatMapData2: 50939,
  LookTableDims: 50981,
  LookTableData: 50982,
  HueSatMapEncoding: 51107,
  LookTableEncoding: 51108,
};

const USED_TAGS = new Set(Object.values(TAG));
const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };
const MAX_ENTRIES = 512;
/** Sanity limit on a table's nodes (Adobe's are about 100,000). */
const MAX_NODES = 2_000_000;

interface RawEntry {
  type: number;
  count: number;
  at: number;
}

/** Reads a .dcp (a TIFF-like file starting "II" and 0x4352). Throws when it isn't one or has no tables. */
export function parseDcp(bytes: Uint8Array): CameraProfileData {
  if (bytes.length < 16 || bytes[0] !== 0x49 || bytes[1] !== 0x49) throw new Error('Not a camera profile (.dcp).');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint16(2, true) !== 0x4352) throw new Error('Not a camera profile (.dcp).');
  const ifd = dv.getUint32(4, true);
  if (ifd + 2 > bytes.length) throw new Error('The camera profile is cut off.');
  const n = dv.getUint16(ifd, true);
  if (n > MAX_ENTRIES || ifd + 2 + n * 12 > bytes.length) throw new Error('The camera profile is damaged.');
  const tags = new Map<number, RawEntry>();
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    const type = dv.getUint16(e + 2, true);
    const count = dv.getUint32(e + 4, true);
    const size = (TYPE_SIZE[type] ?? 1) * count;
    const at = size <= 4 ? e + 8 : dv.getUint32(e + 8, true);
    const tag = dv.getUint16(e, true);
    if (at + size > bytes.length) {
      // A tag we use that points outside the file means it was cut off; others don't matter.
      if (USED_TAGS.has(tag)) throw new Error('The camera profile is cut off.');
      continue;
    }
    tags.set(tag, { type, count, at });
  }

  const text = (tag: number): string => {
    const e = tags.get(tag);
    if (!e || e.type !== 2) return '';
    return String.fromCharCode(...bytes.subarray(e.at, e.at + e.count)).replace(/\0.*$/s, '').trim();
  };
  const ints = (tag: number): number[] | null => {
    const e = tags.get(tag);
    if (!e || (e.type !== 3 && e.type !== 4)) return null;
    return Array.from({ length: e.count }, (_, i) => (e.type === 3 ? dv.getUint16(e.at + i * 2, true) : dv.getUint32(e.at + i * 4, true)));
  };
  const floats = (tag: number, expected: number): Float32Array | null => {
    const e = tags.get(tag);
    if (!e || e.type !== 11 || e.count !== expected) return null;
    const out = new Float32Array(expected);
    for (let i = 0; i < expected; i++) out[i] = dv.getFloat32(e.at + i * 4, true);
    return out;
  };
  const table = (dimsTag: number, dataTag: number, encodingTag: number): CameraProfileTable | null => {
    const dims = ints(dimsTag);
    if (!dims || dims.length !== 3) return null;
    const [h, s, v] = dims as [number, number, number];
    const nodes = h * s * v;
    if (h < 1 || s < 2 || v < 1 || nodes > MAX_NODES) return null;
    const data = floats(dataTag, nodes * 3);
    return data ? { dims: [h, s, v], srgbValues: ints(encodingTag)?.[0] === 1, data } : null;
  };

  const first = table(TAG.HueSatMapDims, TAG.HueSatMapData1, TAG.HueSatMapEncoding);
  let second: CameraProfileTable | null = null;
  if (first) {
    const data2 = floats(TAG.HueSatMapData2, first.data.length);
    if (data2) second = { ...first, data: data2 };
  }
  const look = table(TAG.LookTableDims, TAG.LookTableData, TAG.LookTableEncoding);
  if (!first && !look) throw new Error('This camera profile has no hue/saturation map or look table.');
  return {
    schema: 1,
    model: text(TAG.UniqueCameraModel),
    name: text(TAG.ProfileName),
    illuminants: [ints(TAG.CalibrationIlluminant1)?.[0] ?? 17, ints(TAG.CalibrationIlluminant2)?.[0] ?? 21],
    hueSat: first ? { first, second } : null,
    look,
  };
}

// --- The converted file -----------------------------------------------------------------

const toBase64 = (f: Float32Array): string => {
  const bytes = new Uint8Array(f.length * 4);
  const dv = new DataView(bytes.buffer);
  f.forEach((v, i) => dv.setFloat32(i * 4, v, true));
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

const fromBase64 = (s: string, expected: number): Float32Array => {
  const bin = atob(s);
  if (bin.length !== expected * 4) throw new Error('A camera profile table has the wrong size.');
  const dv = new DataView(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) dv.setUint8(i, bin.charCodeAt(i));
  const out = new Float32Array(expected);
  for (let i = 0; i < expected; i++) out[i] = dv.getFloat32(i * 4, true);
  return out;
};

type TableJson = { dims: [number, number, number]; srgb: boolean; data: string };
interface CameraProfileJson {
  schema: 1;
  model: string;
  name: string;
  illuminants: [number, number];
  hueSat: { first: TableJson; second: string | null } | null;
  look: TableJson | null;
}

const tableToJson = (t: CameraProfileTable): TableJson => ({ dims: t.dims, srgb: t.srgbValues, data: toBase64(t.data) });
const tableFromJson = (t: TableJson): CameraProfileTable => {
  const [h, s, v] = t.dims;
  if (![h, s, v].every((d) => Number.isInteger(d) && d >= 1) || h * s * v > MAX_NODES) throw new Error('A camera profile table has bad dimensions.');
  return { dims: t.dims, srgbValues: t.srgb === true, data: fromBase64(t.data, h * s * v * 3) };
};

export function cameraProfileToJson(p: CameraProfileData): string {
  const json: CameraProfileJson = {
    schema: 1,
    model: p.model,
    name: p.name,
    illuminants: p.illuminants,
    hueSat: p.hueSat ? { first: tableToJson(p.hueSat.first), second: p.hueSat.second ? toBase64(p.hueSat.second.data) : null } : null,
    look: p.look ? tableToJson(p.look) : null,
  };
  return JSON.stringify(json);
}

/** The inverse of cameraProfileToJson; throws on anything that isn't a converted profile. */
export function cameraProfileFromJson(text: string): CameraProfileData {
  const j = JSON.parse(text) as Partial<CameraProfileJson> | null;
  if (!j || j.schema !== 1 || typeof j.model !== 'string' || typeof j.name !== 'string' || !Array.isArray(j.illuminants)) throw new Error('Not a converted camera profile.');
  const first = j.hueSat ? tableFromJson(j.hueSat.first) : null;
  return {
    schema: 1,
    model: j.model,
    name: j.name,
    illuminants: [Number(j.illuminants[0]), Number(j.illuminants[1])],
    hueSat: first ? { first, second: j.hueSat?.second ? { ...first, data: fromBase64(j.hueSat.second, first.data.length) } : null } : null,
    look: j.look ? tableFromJson(j.look) : null,
  };
}

// --- Rendering tables -------------------------------------------------------------------

/** How much of the first illuminant's map a photo at `kelvin` gets (0..1), blending by inverse temperature. */
export function illuminantWeight(p: Pick<CameraProfileData, 'illuminants'>, kelvin: number): number {
  const t1 = ILLUMINANT_KELVIN[p.illuminants[0]];
  const t2 = ILLUMINANT_KELVIN[p.illuminants[1]];
  if (!t1 || !t2 || t1 === t2 || !(kelvin > 0)) return 1;
  const w = (1 / kelvin - 1 / t2) / (1 / t1 - 1 / t2);
  return Math.min(1, Math.max(0, w));
}

const asTable = (t: CameraProfileTable, data = t.data): HueSatTable => ({
  hueDivisions: t.dims[0],
  satDivisions: t.dims[1],
  valDivisions: t.dims[2],
  srgbValues: t.srgbValues,
  data,
});

/** The hue/saturation map at a colour temperature: the two illuminants' maps blended. */
function blendedHueSat(p: CameraProfileData, kelvin: number): HueSatTable | null {
  if (!p.hueSat) return null;
  const { first, second } = p.hueSat;
  if (!second) return asTable(first);
  const w = illuminantWeight(p, kelvin);
  const data = new Float32Array(first.data.length);
  for (let i = 0; i < data.length; i++) data[i] = w * first.data[i]! + (1 - w) * second.data[i]!;
  return asTable(first, data);
}

/**
 * The look table to render a profile with at the photo's colour temperature, or null when the
 * profile has nothing for it. "Standard" is the hue/saturation map alone; "color" is that map
 * followed by the look table, folded into one table on the look table's grid (the renderer applies
 * one table).
 */
export function cameraLookTable(p: CameraProfileData, kind: CameraProfileKind, kelvin: number): HueSatTable | null {
  const base = blendedHueSat(p, kelvin);
  if (kind === 'standard' || !p.look) return base;
  const look = asTable(p.look);
  const [H, S, V] = p.look.dims;
  const data = new Float32Array(H * S * V * 3);
  const decode = (x: number) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
  for (let v = 0; v < V; v++) {
    for (let h = 0; h < H; h++) {
      for (let s = 0; s < S; s++) {
        const hue = (h * 6) / H;
        const sat = s / (S - 1);
        const vEnc = V > 1 ? v / (V - 1) : 1;
        const val = look.srgbValues ? decode(vEnc) : vEnc;
        const k = ((v * H + h) * S + s) * 3;
        if (!(sat > 0) || !(val > 0)) {
          data[k] = 0;
          data[k + 1] = 1;
          data[k + 2] = 1;
          continue;
        }
        let rgb = dngHsvToRgb([hue, sat, val]);
        if (base) rgb = applyLookCpu(base, rgb);
        rgb = applyLookCpu(look, rgb);
        const [h2, s2, v2] = dngRgbToHsv(rgb);
        let dh = h2 - hue;
        dh -= 6 * Math.round(dh / 6);
        data[k] = dh * (360 / 6);
        data[k + 1] = Math.min(s2 / sat, 4);
        data[k + 2] = v2 / val;
      }
    }
  }
  return asTable(p.look, data);
}
