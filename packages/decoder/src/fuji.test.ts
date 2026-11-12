import { existsSync, readFileSync } from 'node:fs';
import { env } from 'node:process';
import { describe, expect, it } from 'vitest';
import { fujiSimFromCodes, readFujiFilmSim } from './fuji.ts';

/** A Fujifilm maker note: "FUJIFILM", IFD offset 12, then SHORT tags (always little-endian). */
function makerNote(tags: Record<number, number>): Uint8Array {
  const ids = Object.keys(tags).map(Number);
  const b = new Uint8Array(12 + 2 + ids.length * 12 + 4);
  const dv = new DataView(b.buffer);
  b.set([...'FUJIFILM'].map((c) => c.charCodeAt(0)));
  dv.setUint32(8, 12, true);
  dv.setUint16(12, ids.length, true);
  ids.forEach((tag, i) => {
    const e = 14 + i * 12;
    dv.setUint16(e, tag, true);
    dv.setUint16(e + 2, 3, true);
    dv.setUint32(e + 4, 1, true);
    dv.setUint16(e + 8, tags[tag]!, true);
  });
  return b;
}

/** A TIFF with IFD0 -> Exif IFD -> MakerNote. */
function exifTiff(note: Uint8Array, le = true): Uint8Array {
  const ifd0 = 8;
  const exif = ifd0 + 2 + 12 + 4;
  const noteAt = exif + 2 + 12 + 4;
  const b = new Uint8Array(noteAt + note.length);
  const dv = new DataView(b.buffer);
  b.set(le ? [0x49, 0x49, 42, 0] : [0x4d, 0x4d, 0, 42]);
  dv.setUint32(4, ifd0, le);
  const entry = (at: number, tag: number, type: number, count: number, value: number) => {
    dv.setUint16(at, 1, le);
    dv.setUint16(at + 2, tag, le);
    dv.setUint16(at + 4, type, le);
    dv.setUint32(at + 6, count, le);
    dv.setUint32(at + 10, value, le);
  };
  entry(ifd0, 0x8769, 4, 1, exif);
  entry(exif, 0x927c, 7, note.length, noteAt);
  b.set(note, noteAt);
  return b;
}

/** A RAF: header, then the embedded JPEG whose APP1 holds the Exif. */
function raf(tiff: Uint8Array, { extraSegment = false } = {}): Uint8Array {
  const segments: number[] = [0xff, 0xd8];
  if (extraSegment) segments.push(0xff, 0xe0, 0, 6, 0x4a, 0x46, 0x49, 0x46); // a short APP0 first
  const app1 = 2 + 6 + tiff.length;
  segments.push(0xff, 0xe1, app1 >> 8, app1 & 0xff, ...[...'Exif\0\0'].map((c) => c.charCodeAt(0)), ...tiff);
  segments.push(0xff, 0xda, 0, 2, 0xff, 0xd9);
  const jpeg = new Uint8Array(segments);
  const b = new Uint8Array(160 + jpeg.length);
  b.set([...'FUJIFILMCCD-RAW 0201'].map((c) => c.charCodeAt(0)));
  const dv = new DataView(b.buffer);
  dv.setUint32(84, 160, false);
  dv.setUint32(88, jpeg.length, false);
  b.set(jpeg, 160);
  return b;
}

describe('fujiSimFromCodes', () => {
  it('maps FilmMode values', () => {
    expect(fujiSimFromCodes(0x000, 0)).toEqual({ sim: 'provia', filter: null });
    expect(fujiSimFromCodes(0x120, 0)?.sim).toBe('astia');
    expect(fujiSimFromCodes(0x200, 0)?.sim).toBe('velvia');
    expect(fujiSimFromCodes(0x400, 0)?.sim).toBe('velvia');
    expect(fujiSimFromCodes(0x500, 0)?.sim).toBe('pro-neg-std');
    expect(fujiSimFromCodes(0x501, 0)?.sim).toBe('pro-neg-hi');
    expect(fujiSimFromCodes(0x600, 0)?.sim).toBe('classic-chrome');
    expect(fujiSimFromCodes(0x700, 0)?.sim).toBe('eterna');
    expect(fujiSimFromCodes(0x800, 0)?.sim).toBe('classic-neg');
    expect(fujiSimFromCodes(0x900, 0)?.sim).toBe('bleach-bypass');
    expect(fujiSimFromCodes(0xa00, 0)?.sim).toBe('nostalgic-neg');
    expect(fujiSimFromCodes(0xb00, 0)?.sim).toBe('reala-ace');
  });

  it('treats the old studio-portrait and unknown modes as Provia', () => {
    expect(fujiSimFromCodes(0x100, null)?.sim).toBe('provia');
    expect(fujiSimFromCodes(0x300, null)?.sim).toBe('provia');
    expect(fujiSimFromCodes(0xf00, null)?.sim).toBe('provia');
  });

  it('reads the monochrome simulations from Saturation, ahead of FilmMode', () => {
    expect(fujiSimFromCodes(null, 0x300)).toEqual({ sim: 'monochrome', filter: null });
    expect(fujiSimFromCodes(null, 0x301)).toEqual({ sim: 'monochrome', filter: 'red' });
    expect(fujiSimFromCodes(null, 0x302)).toEqual({ sim: 'monochrome', filter: 'yellow' });
    expect(fujiSimFromCodes(null, 0x303)).toEqual({ sim: 'monochrome', filter: 'green' });
    expect(fujiSimFromCodes(null, 0x310)).toEqual({ sim: 'sepia', filter: null });
    expect(fujiSimFromCodes(null, 0x500)).toEqual({ sim: 'acros', filter: null });
    expect(fujiSimFromCodes(0x600, 0x501)).toEqual({ sim: 'acros', filter: 'red' });
    expect(fujiSimFromCodes(null, 0x503)).toEqual({ sim: 'acros', filter: 'green' });
  });

  it('returns null without either tag', () => {
    expect(fujiSimFromCodes(null, null)).toBeNull();
  });
});

describe('readFujiFilmSim', () => {
  it('reads a RAF', () => {
    expect(readFujiFilmSim(raf(exifTiff(makerNote({ 0x1003: 0, 0x1401: 0x600 }))))).toEqual({
      sim: 'classic-chrome',
      filter: null,
      filmMode: 0x600,
      saturation: 0,
    });
    expect(readFujiFilmSim(raf(exifTiff(makerNote({ 0x1401: 0 })), { extraSegment: true }))?.sim).toBe('provia');
  });

  it('reads Acros with a red filter when FilmMode is absent', () => {
    expect(readFujiFilmSim(raf(exifTiff(makerNote({ 0x1003: 0x501 }))))).toMatchObject({ sim: 'acros', filter: 'red', filmMode: null });
  });

  it('reads B&W with a yellow filter and Sepia', () => {
    expect(readFujiFilmSim(raf(exifTiff(makerNote({ 0x1003: 0x302 })))))?.toMatchObject({ sim: 'monochrome', filter: 'yellow' });
    expect(readFujiFilmSim(raf(exifTiff(makerNote({ 0x1003: 0x310 }))))?.sim).toBe('sepia');
  });

  it('reads a TIFF/DNG that kept the maker note, in either byte order', () => {
    expect(readFujiFilmSim(exifTiff(makerNote({ 0x1401: 0x800 })))?.sim).toBe('classic-neg');
    expect(readFujiFilmSim(exifTiff(makerNote({ 0x1401: 0xb00 }), false))?.sim).toBe('reala-ace');
  });

  it('returns null for other files and broken data', () => {
    expect(readFujiFilmSim(new Uint8Array(0))).toBeNull();
    expect(readFujiFilmSim(new Uint8Array(200))).toBeNull();
    const good = raf(exifTiff(makerNote({ 0x1401: 0x600 })));
    for (const cut of [20, 90, 170, good.length - 30]) expect(readFujiFilmSim(good.slice(0, cut))).toBeNull();
    const notFuji = makerNote({ 0x1401: 0x600 });
    notFuji.set([...'NIKON\0\0\0'].map((c) => c.charCodeAt(0)));
    expect(readFujiFilmSim(raf(exifTiff(notFuji)))).toBeNull();
    // A maker note claiming a huge entry count.
    const huge = makerNote({ 0x1401: 0x600 });
    new DataView(huge.buffer).setUint16(12, 60000, true);
    expect(readFujiFilmSim(raf(exifTiff(huge)))).toBeNull();
  });

  // samples/ is git-ignored; RAW_SAMPLES_DIR points elsewhere (e.g. from a worktree).
  const sample = env.RAW_SAMPLES_DIR ? `${env.RAW_SAMPLES_DIR}/fuji-xt5.RAF` : new URL('../../../samples/fuji-xt5.RAF', import.meta.url);
  it.skipIf(!existsSync(sample))('reads Provia from the X-T5 sample', () => {
    expect(readFujiFilmSim(new Uint8Array(readFileSync(sample)))).toMatchObject({ sim: 'provia', filmMode: 0 });
  });
});
