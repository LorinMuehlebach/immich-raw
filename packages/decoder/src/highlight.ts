// In-camera highlight protection that under-exposes the RAW on purpose.
//
// Fujifilm DR200/DR400, Canon Highlight Tone Priority and Nikon Active D-Lighting all lower the
// exposure at the sensor, and the camera's own JPEG brightens it back. The RAW stays dark, so a
// converter that wants the camera's brightness (Lightroom does for Fujifilm; measured on a DR400
// photo) adds the stops back as a baseline exposure. This reads the setting from the maker note.
//
// The brand mappings (stops per setting) follow RapidRAW's src-tauri/src/decode/baseline_exposure.rs
// (AGPL-3.0, github.com/CyberTimon/RapidRAW). Only the settings that really change the sensor
// exposure are used: Canon's Auto Lighting Optimizer works on the JPEG only, so it adds nothing.
import { readFujiDynamicRange } from './fuji.ts';

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8 };
const MAX_ENTRIES = 1024;

interface Entry {
  type: number;
  count: number;
  /** Absolute offset of the entry's 4-byte value field. */
  field: number;
}

const ascii = (b: Uint8Array, at: number, text: string) =>
  at >= 0 && at + text.length <= b.length && [...text].every((c, i) => b[at + i] === c.charCodeAt(0));

/** A TIFF structure inside the file: where it starts, its byte order, and its IFDs. */
class Tiff {
  readonly b: Uint8Array;
  readonly start: number;
  readonly le: boolean;
  private readonly dv: DataView;

  constructor(b: Uint8Array, start: number, le: boolean) {
    this.b = b;
    this.start = start;
    this.le = le;
    this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }

  u16(at: number): number {
    return this.dv.getUint16(at, this.le);
  }

  u32(at: number): number {
    return this.dv.getUint32(at, this.le);
  }

  /** The entries of the IFD at an absolute offset; null when it doesn't fit in the file. */
  ifd(at: number): Map<number, Entry> | null {
    if (at < 0 || at + 2 > this.b.length) return null;
    const n = this.u16(at);
    if (n > MAX_ENTRIES || at + 2 + n * 12 > this.b.length) return null;
    const out = new Map<number, Entry>();
    for (let i = 0; i < n; i++) {
      const e = at + 2 + i * 12;
      out.set(this.u16(e), { type: this.u16(e + 2), count: this.u32(e + 4), field: e + 8 });
    }
    return out;
  }

  /** Where an entry's values are: in the entry, or at `base` plus its offset. */
  where(e: Entry, base: number): number {
    const size = (TYPE_SIZE[e.type] ?? 1) * e.count;
    return size <= 4 ? e.field : base + this.u32(e.field);
  }

  /** An integer array entry (BYTE, SHORT, LONG and their signed forms); null for anything else. */
  ints(e: Entry, base: number, max = 16): number[] | null {
    const size = TYPE_SIZE[e.type];
    if (!size || e.type === 2 || e.type === 5 || e.type === 10) return null;
    const at = this.where(e, base);
    const n = Math.min(e.count, max);
    if (at < 0 || at + n * size > this.b.length) return null;
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      const o = at + i * size;
      if (size === 1) out.push(e.type === 6 ? this.dv.getInt8(o) : this.b[o]!);
      else if (size === 2) out.push(e.type === 8 ? this.dv.getInt16(o, this.le) : this.u16(o));
      else out.push(e.type === 9 ? this.dv.getInt32(o, this.le) : this.u32(o));
    }
    return out;
  }
}

/** A TIFF header (II*\0 or MM\0*) at `at`, or null. */
function tiffAt(b: Uint8Array, at: number): Tiff | null {
  if (ascii(b, at, 'II*\0')) return new Tiff(b, at, true);
  if (ascii(b, at, 'MM\0*')) return new Tiff(b, at, false);
  return null;
}

/** Where the Exif IFD's MakerNote is (absolute offset), or null. */
function makerNote(t: Tiff): { at: number } | null {
  const ifd0 = t.ifd(t.start + t.u32(t.start + 4));
  const exifPtr = ifd0?.get(0x8769);
  if (!exifPtr) return null;
  const exif = t.ifd(t.start + t.u32(exifPtr.field));
  const note = exif?.get(0x927c);
  if (!note || note.count < 12) return null;
  return { at: t.where(note, t.start) };
}

/** The Make of a TIFF-based file ("Canon", "NIKON CORPORATION", ...), or ''. */
function makeOf(t: Tiff): string {
  const ifd0 = t.ifd(t.start + t.u32(t.start + 4));
  const make = ifd0?.get(0x010f);
  if (!make || make.type !== 2) return '';
  const at = t.where(make, t.start);
  const n = Math.min(make.count, 32);
  return at >= 0 && at + n <= t.b.length ? String.fromCharCode(...t.b.subarray(at, at + n)).replace(/\0.*$/, '') : '';
}

// --- Canon ----------------------------------------------------------------------------

/** What was read from the maker note, and the stops it stands for. */
export interface HighlightMode {
  brand: 'fujifilm' | 'canon' | 'nikon';
  /** The tag's value as the camera wrote it (DR 100/200/400, Highlight Tone Priority 0/1, Active D-Lighting 0..). */
  raw: number;
  ev: number;
}

/**
 * Highlight Tone Priority (LightingOpt, tag 0x4018, element 3): it lowers the exposure by about
 * a stop. `note` is the Canon maker note's IFD entries and `base` what its offsets count from.
 */
function canon(t: Tiff, note: Map<number, Entry>, base: number): HighlightMode | null {
  const lighting = note.get(0x4018);
  const values = lighting ? t.ints(lighting, base, 8) : null;
  if (!values || values.length < 4) return null;
  return { brand: 'canon', raw: values[3]!, ev: values[3]! > 0 ? 1 : 0 };
}

/** Canon CR3: a box file whose CMT3 box holds the maker note as a TIFF (found by its box type). */
function canonCr3(b: Uint8Array): HighlightMode | null {
  if (!ascii(b, 4, 'ftypcrx ')) return null;
  const limit = Math.min(b.length - 8, 1 << 20);
  for (let i = 8; i < limit; i++) {
    if (b[i] === 0x43 && b[i + 1] === 0x4d && b[i + 2] === 0x54 && b[i + 3] === 0x33) {
      const t = tiffAt(b, i + 4);
      const note = t?.ifd(t.start + t.u32(t.start + 4));
      return t && note ? canon(t, note, t.start) : null;
    }
  }
  return null;
}

// --- Nikon ----------------------------------------------------------------------------

/** Active D-Lighting (tag 0x0022) in stops: the camera under-exposes more the stronger it is. */
const NIKON_ACTIVE_D_LIGHTING: Record<number, number> = { 3: 0.33, 5: 0.66, 7: 1, 8: 1.1, 9: 1.2, 10: 1.3, 11: 1.33 };

function nikon(b: Uint8Array, noteAt: number): HighlightMode | null {
  // "Nikon\0", a version and two padding bytes, then a TIFF structure the offsets count from.
  if (!ascii(b, noteAt, 'Nikon\0')) return null;
  const inner = tiffAt(b, noteAt + 10);
  const note = inner?.ifd(inner.start + inner.u32(inner.start + 4));
  const adl = note?.get(0x0022);
  const v = inner && adl ? inner.ints(adl, inner.start, 1) : null;
  return v ? { brand: 'nikon', raw: v[0]!, ev: NIKON_ACTIVE_D_LIGHTING[v[0]!] ?? 0 } : null;
}

// --- Entry points ---------------------------------------------------------------------

/**
 * The in-camera highlight protection setting of a RAW and the stops it under-exposes by; null for
 * brands not covered and for anything that can't be read. DNG files are left alone: they carry
 * their own BaselineExposure.
 */
export function readHighlightMode(bytes: Uint8Array): HighlightMode | null {
  try {
    const dr = readFujiDynamicRange(bytes);
    if (dr) return { brand: 'fujifilm', raw: dr, ev: Math.log2(dr / 100) };
    const cr3 = canonCr3(bytes);
    if (cr3) return cr3;
    const t = tiffAt(bytes, 0);
    if (!t) return null;
    const ifd0 = t.ifd(t.start + t.u32(t.start + 4));
    if (!ifd0 || ifd0.has(0xc612)) return null; // DNGVersion: a DNG has its own baseline
    const note = makerNote(t);
    if (!note) return null;
    const make = makeOf(t).toUpperCase();
    if (make.startsWith('CANON')) {
      const entries = t.ifd(note.at);
      return entries ? canon(t, entries, t.start) : null;
    }
    if (make.startsWith('NIKON')) return nikon(bytes, note.at);
    return null;
  } catch {
    return null;
  }
}

/** Stops the RAW is under-exposed by design (0 when there is none or it can't be read). */
export function highlightModeEv(bytes: Uint8Array): number {
  return readHighlightMode(bytes)?.ev ?? 0;
}
