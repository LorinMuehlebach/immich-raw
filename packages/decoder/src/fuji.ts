// The film simulation a Fujifilm camera was set to, read from the maker note.
//
// LibRaw reads FilmMode (tag 0x1401) but not tag 0x1003, where the monochrome simulations
// (Acros, B&W, Sepia) live, so this reads both itself. A RAF keeps its Exif in the embedded
// JPEG; a DNG (from Adobe's converter) may keep the maker note in its own Exif IFD.
// Tag values: ExifTool's FujiFilm.pm.

export type FujiSim =
  | 'provia'
  | 'velvia'
  | 'astia'
  | 'classic-chrome'
  | 'pro-neg-std'
  | 'pro-neg-hi'
  | 'eterna'
  | 'bleach-bypass'
  | 'classic-neg'
  | 'nostalgic-neg'
  | 'reala-ace'
  | 'monochrome'
  | 'acros'
  | 'sepia';

export type FujiFilter = 'red' | 'yellow' | 'green';

export interface FujiFilmSim {
  sim: FujiSim;
  /** Colour filter of a monochrome simulation. */
  filter: FujiFilter | null;
  /** Raw tag values, for diagnostics. */
  filmMode: number | null;
  saturation: number | null;
}

const FILM_MODES: Record<number, FujiSim> = {
  0x000: 'provia',
  0x120: 'astia',
  0x200: 'velvia',
  0x400: 'velvia',
  0x500: 'pro-neg-std',
  0x501: 'pro-neg-hi',
  0x600: 'classic-chrome',
  0x700: 'eterna',
  0x800: 'classic-neg',
  0x900: 'bleach-bypass',
  0xa00: 'nostalgic-neg',
  0xb00: 'reala-ace',
};

const FILTERS: (FujiFilter | null)[] = [null, 'red', 'yellow', 'green'];

/** Which simulation the two tags describe; null when neither is present. */
export function fujiSimFromCodes(filmMode: number | null, saturation: number | null): Pick<FujiFilmSim, 'sim' | 'filter'> | null {
  if (saturation !== null) {
    if (saturation >= 0x300 && saturation <= 0x303) return { sim: 'monochrome', filter: FILTERS[saturation - 0x300]! };
    if (saturation === 0x310) return { sim: 'sepia', filter: null };
    if (saturation >= 0x500 && saturation <= 0x503) return { sim: 'acros', filter: FILTERS[saturation - 0x500]! };
  }
  if (filmMode === null) return saturation === null ? null : { sim: 'provia', filter: null };
  // The old "Studio Portrait" modes (F1, F1a, F1c, F3) have no look of their own here.
  return { sim: FILM_MODES[filmMode] ?? 'provia', filter: null };
}

const MAX_ENTRIES = 1024;
const ascii = (b: Uint8Array, at: number, text: string) =>
  at >= 0 && at + text.length <= b.length && [...text].every((c, i) => b[at + i] === c.charCodeAt(0));

/** Reads the in-camera film simulation from a RAF (or a DNG/TIFF that kept the maker note). */
export function readFujiFilmSim(bytes: Uint8Array): FujiFilmSim | null {
  try {
    const tiff = exifTiff(bytes);
    if (!tiff) return null;
    const note = makerNote(bytes, tiff.start, tiff.le);
    if (!note) return null;
    const tags = fujiTags(bytes, note);
    if (!tags) return null;
    const filmMode = tags.get(0x1401) ?? null;
    const saturation = tags.get(0x1003) ?? null;
    const found = fujiSimFromCodes(filmMode, saturation);
    return found ? { ...found, filmMode, saturation } : null;
  } catch {
    return null;
  }
}

/** Where the Exif TIFF structure starts, and its byte order. */
function exifTiff(b: Uint8Array): { start: number; le: boolean } | null {
  if (ascii(b, 0, 'II*\0')) return { start: 0, le: true };
  if (ascii(b, 0, 'MM\0*')) return { start: 0, le: false };
  if (!ascii(b, 0, 'FUJIFILMCCD-RAW')) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length < 92) return null;
  const jpeg = dv.getUint32(84, false);
  const length = dv.getUint32(88, false);
  if (jpeg + 4 > b.length || b[jpeg] !== 0xff || b[jpeg + 1] !== 0xd8) return null;
  const end = Math.min(b.length, jpeg + length);
  // Walk the JPEG's marker segments up to the image data, looking for APP1 "Exif\0\0".
  let at = jpeg + 2;
  while (at + 4 <= end) {
    if (b[at] !== 0xff) return null;
    const marker = b[at + 1]!;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      at += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) return null;
    const size = dv.getUint16(at + 2, false);
    if (size < 2) return null;
    if (marker === 0xe1 && ascii(b, at + 4, 'Exif\0\0')) {
      const start = at + 10;
      if (ascii(b, start, 'II*\0')) return { start, le: true };
      if (ascii(b, start, 'MM\0*')) return { start, le: false };
      return null;
    }
    at += 2 + size;
  }
  return null;
}

interface Entry {
  tag: number;
  type: number;
  count: number;
  /** Absolute offset of the value field (4 bytes in the entry). */
  field: number;
}

function readIfd(dv: DataView, at: number, le: boolean): Entry[] | null {
  if (at < 0 || at + 2 > dv.byteLength) return null;
  const n = dv.getUint16(at, le);
  if (n > MAX_ENTRIES || at + 2 + n * 12 > dv.byteLength) return null;
  const entries: Entry[] = [];
  for (let i = 0; i < n; i++) {
    const e = at + 2 + i * 12;
    entries.push({ tag: dv.getUint16(e, le), type: dv.getUint16(e + 2, le), count: dv.getUint32(e + 4, le), field: e + 8 });
  }
  return entries;
}

/** Absolute offset of the Fujifilm maker note ("FUJIFILM" + IFD offset). */
function makerNote(b: Uint8Array, tiff: number, le: boolean): number | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const ifd0 = readIfd(dv, tiff + dv.getUint32(tiff + 4, le), le);
  const exifPtr = ifd0?.find((e) => e.tag === 0x8769);
  if (!exifPtr) return null;
  const exif = readIfd(dv, tiff + dv.getUint32(exifPtr.field, le), le);
  const note = exif?.find((e) => e.tag === 0x927c);
  if (!note || note.count < 12) return null;
  const at = tiff + dv.getUint32(note.field, le);
  if (at + note.count > b.length || !ascii(b, at, 'FUJIFILM')) return null;
  return at;
}

/** The maker note's SHORT tags. Fujifilm writes it little-endian, offsets relative to its start. */
function fujiTags(b: Uint8Array, note: number): Map<number, number> | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const entries = readIfd(dv, note + dv.getUint32(note + 8, true), true);
  if (!entries) return null;
  const tags = new Map<number, number>();
  for (const e of entries) {
    // SHORT, one value: stored in the entry itself.
    if (e.type === 3 && e.count >= 1) tags.set(e.tag, dv.getUint16(e.field, true));
  }
  return tags;
}
