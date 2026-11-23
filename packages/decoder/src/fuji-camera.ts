// Everything else a Fujifilm RAF says about how it was shot: all the maker note's tags, a readable
// list of the settings among them, and the camera's own JPEG that every RAF carries.
// Tag meanings: ExifTool's FujiFilm.pm. Where a value isn't known the number is shown as it is.
import { ascii, exifTiff, fujiSimFromCodes, makerNote, readIfd, type FujiSim } from './fuji.ts';

/** A maker note tag: text, or the numbers of a list (a rational is its quotient). */
export type FujiTagValue = string | number[];

/** One setting for people to read. */
export interface FujiSetting {
  tag: number;
  label: string;
  value: string;
}

/** The camera's own JPEG is at most this big (the ones seen are 4 to 5 MB). */
const MAX_PREVIEW_BYTES = 64 * 1024 * 1024;
/** Values of a tag past this many are dropped (the lists seen have 8). */
const MAX_VALUES = 64;

const TYPE_BYTES: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

/**
 * Where the camera's own JPEG sits in a RAF, from the file's first 92 bytes. `end` is how many bytes
 * of the file hold all of it; null for anything that isn't a RAF.
 */
export function rafPreviewRange(head: Uint8Array): { start: number; end: number } | null {
  if (head.length < 92 || !ascii(head, 0, 'FUJIFILMCCD-RAW')) return null;
  const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const start = dv.getUint32(84, false);
  const length = dv.getUint32(88, false);
  if (start < 92 || length < 4 || length > MAX_PREVIEW_BYTES) return null;
  return { start, end: start + length };
}

/**
 * The camera's own JPEG (its rendering with the film simulation it was set to, at about 4400 px
 * wide), from the start of a RAF. Null when the bytes don't reach its end yet, or aren't a RAF.
 */
export function readRafPreview(bytes: Uint8Array): Uint8Array | null {
  const range = rafPreviewRange(bytes);
  if (!range || bytes.length < range.end || bytes[range.start] !== 0xff || bytes[range.start + 1] !== 0xd8) return null;
  return bytes.subarray(range.start, range.end);
}

/** Every tag of the maker note, by number; null when there is none. */
export function readFujiTags(bytes: Uint8Array): Map<number, FujiTagValue> | null {
  try {
    const tiff = exifTiff(bytes);
    if (!tiff) return null;
    const note = makerNote(bytes, tiff.start, tiff.le);
    if (!note) return null;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // Fujifilm writes the note little-endian, its offsets counted from its start.
    const entries = readIfd(dv, note + dv.getUint32(note + 8, true), true);
    if (!entries) return null;
    const tags = new Map<number, FujiTagValue>();
    for (const e of entries) {
      const size = TYPE_BYTES[e.type];
      if (!size || e.count < 1) continue;
      const total = size * e.count;
      const at = total <= 4 ? e.field : note + dv.getUint32(e.field, true);
      if (at < 0 || at + total > bytes.length) continue;
      const n = Math.min(e.count, MAX_VALUES);
      if (e.type === 2) {
        let text = '';
        for (let i = 0; i < e.count && bytes[at + i] !== 0; i++) text += String.fromCharCode(bytes[at + i]!);
        tags.set(e.tag, text.trim());
        continue;
      }
      const values: number[] = [];
      for (let i = 0; i < n; i++) {
        const o = at + i * size;
        switch (e.type) {
          case 1:
          case 7:
            values.push(bytes[o]!);
            break;
          case 6:
            values.push(dv.getInt8(o));
            break;
          case 3:
            values.push(dv.getUint16(o, true));
            break;
          case 8:
            values.push(dv.getInt16(o, true));
            break;
          case 4:
            values.push(dv.getUint32(o, true));
            break;
          case 9:
            values.push(dv.getInt32(o, true));
            break;
          case 5: {
            const den = dv.getUint32(o + 4, true);
            values.push(den ? dv.getUint32(o, true) / den : 0);
            break;
          }
          case 10: {
            const den = dv.getInt32(o + 4, true);
            values.push(den ? dv.getInt32(o, true) / den : 0);
            break;
          }
          case 11:
            values.push(dv.getFloat32(o, true));
            break;
          default:
            values.push(dv.getFloat64(o, true));
        }
      }
      tags.set(e.tag, values);
    }
    return tags.size ? tags : null;
  } catch {
    return null;
  }
}

const SIM_NAMES: Record<FujiSim, string> = {
  provia: 'Provia / Standard',
  velvia: 'Velvia / Vivid',
  astia: 'Astia / Soft',
  'classic-chrome': 'Classic Chrome',
  'pro-neg-std': 'PRO Neg. Std',
  'pro-neg-hi': 'PRO Neg. Hi',
  eterna: 'Eterna / Cinema',
  'bleach-bypass': 'Eterna Bleach Bypass',
  'classic-neg': 'Classic Neg.',
  'nostalgic-neg': 'Nostalgic Neg.',
  'reala-ace': 'Reala Ace',
  monochrome: 'Monochrome',
  acros: 'Acros',
  sepia: 'Sepia',
};

const SHARPNESS: Record<number, string> = { 0: 'Softest', 1: 'Very soft', 2: 'Soft', 3: 'Normal', 4: 'Hard', 5: 'Very hard', 0x82: 'Medium soft', 0x84: 'Medium hard', 0x8000: 'From the film simulation', 0xffff: 'Off' };
const WHITE_BALANCE: Record<number, string> = {
  0: 'Auto', 1: 'Auto, white priority', 2: 'Auto, ambience priority', 0x100: 'Daylight', 0x200: 'Cloudy', 0x300: 'Daylight fluorescent', 0x301: 'Day white fluorescent',
  0x302: 'White fluorescent', 0x303: 'Warm white fluorescent', 0x304: 'Living room warm white fluorescent', 0x400: 'Incandescent', 0x500: 'Flash', 0xf00: 'Custom',
  0xf01: 'Custom 2', 0xf02: 'Custom 3', 0xf03: 'Custom 4', 0xf04: 'Custom 5', 0xff0: 'Kelvin',
};
const COLOUR: Record<number, string> = { 0: 'Normal', 0x80: 'Medium high', 0x100: 'High', 0x180: 'Medium low', 0x200: 'Low', 0x8000: 'From the film simulation' };
/** 0x100 is what bodies without the setting write. */
const NOISE_REDUCTION: Record<number, string> = { 0x40: 'Low', 0x80: 'Normal' };
const EFFECT: Record<number, string> = { 0: 'Off', 32: 'Weak', 64: 'Strong' };
const GRAIN_SIZE: Record<number, string> = { 0: 'Off', 16: 'Small', 32: 'Large' };
const SHUTTER: Record<number, string> = { 0: 'Mechanical', 1: 'Electronic', 2: 'Electronic, long exposure', 3: 'Electronic front curtain' };

const int16 = (v: number) => (v > 32767 ? v - 65536 : v);

/** Highlight and Shadow tone are stored as minus sixteen times the setting (+1 is -16, -0.5 is 8). */
const tone = (v: number) => {
  const t = -int16(v) / 16;
  return t === 0 ? '0' : `${t > 0 ? '+' : ''}${t}`;
};

/** The settings among the tags, in the order a person would look for them; only those the file has. */
export function describeFujiCamera(tags: ReadonlyMap<number, FujiTagValue>): FujiSetting[] {
  const out: FujiSetting[] = [];
  const num = (tag: number): number | null => {
    const v = tags.get(tag);
    return Array.isArray(v) && v.length ? v[0]! : null;
  };
  const add = (tag: number, label: string, text: string | null) => {
    if (text !== null && text !== '') out.push({ tag, label, value: text });
  };
  const pick = (tag: number, label: string, names: Record<number, string>) => {
    const v = num(tag);
    if (v !== null) add(tag, label, names[v] ?? String(v));
  };

  const sim = fujiSimFromCodes(num(0x1401), num(0x1003));
  if (sim) add(0x1401, 'Film simulation', SIM_NAMES[sim.sim] + (sim.filter ? ` (${sim.filter} filter)` : ''));
  const dr = num(0x1403) ?? num(0x140b);
  if (dr) add(0x1403, 'Dynamic range', `DR${dr}`);
  pick(0x1002, 'White balance', WHITE_BALANCE);
  const kelvin = num(0x1005);
  if (kelvin) add(0x1005, 'Colour temperature', `${kelvin} K`);
  const shift = tags.get(0x100a);
  if (Array.isArray(shift) && shift.length >= 2 && (shift[0] || shift[1])) add(0x100a, 'White balance shift', `red ${shift[0]! / 20}, blue ${shift[1]! / 20}`);
  pick(0x1001, 'Sharpness', SHARPNESS);
  const hl = num(0x1041);
  if (hl !== null) add(0x1041, 'Highlight tone', tone(hl));
  const sh = num(0x1040);
  if (sh !== null) add(0x1040, 'Shadow tone', tone(sh));
  if (!sim || (sim.sim !== 'monochrome' && sim.sim !== 'acros' && sim.sim !== 'sepia')) pick(0x1003, 'Colour', COLOUR);
  if (num(0x100b) !== 0x100) pick(0x100b, 'Noise reduction', NOISE_REDUCTION);
  const grain = num(0x1047);
  if (grain !== null) {
    const size = num(0x104c);
    add(0x1047, 'Grain effect', (EFFECT[grain] ?? String(grain)) + (grain && size ? `, ${GRAIN_SIZE[size] ?? size}` : ''));
  }
  pick(0x1048, 'Color Chrome Effect', EFFECT);
  pick(0x104e, 'Color Chrome FX Blue', EFFECT);
  const lmo = num(0x1045);
  if (lmo !== null) add(0x1045, 'Lens modulation optimizer', lmo ? 'On' : 'Off');
  pick(0x1050, 'Shutter type', SHUTTER);
  const rating = num(0x1431);
  if (rating) add(0x1431, 'Rating', String(rating));
  const count = num(0x1438);
  if (count) add(0x1438, 'Image count', String(count));
  return out;
}

/** The camera's settings of a RAF (or a DNG that kept the maker note), or null without them. */
export function readFujiCamera(bytes: Uint8Array): { tags: Map<number, FujiTagValue>; settings: FujiSetting[] } | null {
  const tags = readFujiTags(bytes);
  return tags ? { tags, settings: describeFujiCamera(tags) } : null;
}
