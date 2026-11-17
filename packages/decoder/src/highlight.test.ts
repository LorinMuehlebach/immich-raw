import { existsSync, readFileSync } from 'node:fs';
import { env } from 'node:process';
import { describe, expect, it } from 'vitest';
import { highlightModeEv, readHighlightMode } from './highlight.ts';

interface Entry {
  tag: number;
  type: number;
  count: number;
  /** The value's bytes, little-endian: stored in the entry when 4 or fewer, else after the IFD. */
  data: number[];
}

const u16 = (n: number) => [n & 255, (n >> 8) & 255];
const u32 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
const text = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** An IFD placed at file offset `at`, then its out-of-line data; offsets count from `base`. */
function ifd(entries: Entry[], at: number, base: number): number[] {
  const head = 2 + entries.length * 12 + 4;
  const out = [...u16(entries.length)];
  const extra: number[] = [];
  for (const e of entries) {
    out.push(...u16(e.tag), ...u16(e.type), ...u32(e.count));
    if (e.data.length <= 4) out.push(...e.data, ...new Array<number>(4 - e.data.length).fill(0));
    else {
      out.push(...u32(at + head + extra.length - base));
      extra.push(...e.data);
    }
  }
  return [...out, 0, 0, 0, 0, ...extra];
}

const shorts = (values: number[]): Entry['data'] => values.flatMap(u16);

/** A little-endian TIFF (CR2, NEF, ...): IFD0 with Make and Exif pointer, an Exif IFD with the maker note. */
function tiffFile(make: string, note: (noteAt: number) => number[]): Uint8Array {
  const makeBytes = [...text(make), 0];
  const ifd0 = (exifAt: number) =>
    ifd([{ tag: 0x010f, type: 2, count: makeBytes.length, data: makeBytes }, { tag: 0x8769, type: 4, count: 1, data: u32(exifAt) }], 8, 0);
  const exifAt = 8 + ifd0(0).length;
  const noteAt = exifAt + 2 + 12 + 4;
  const noteBytes = note(noteAt);
  const exif = ifd([{ tag: 0x927c, type: 7, count: noteBytes.length, data: noteBytes }], exifAt, 0);
  return Uint8Array.from([0x49, 0x49, 0x2a, 0, ...u32(8), ...ifd0(exifAt), ...exif]);
}

/** Canon's maker note: an IFD whose offsets count from the start of the TIFF. */
const canonNote = (lighting: number[] | null) => (noteAt: number) =>
  lighting ? ifd([{ tag: 0x4018, type: 3, count: lighting.length, data: shorts(lighting) }], noteAt, 0) : ifd([{ tag: 0x0001, type: 3, count: 1, data: u16(1) }, { tag: 0x0002, type: 3, count: 1, data: u16(2) }], noteAt, 0).concat(new Array<number>(12).fill(0));

/** Nikon's: "Nikon", a version, then its own TIFF header the offsets count from. */
const nikonNote = (adl: number | null) => (noteAt: number) => {
  const inner = noteAt + 10;
  const entries: Entry[] = adl === null ? [{ tag: 0x0001, type: 3, count: 1, data: u16(1) }] : [{ tag: 0x0022, type: 3, count: 1, data: u16(adl) }];
  return [...text('Nikon'), 0, 2, 0x10, 0, 0, 0x49, 0x49, 0x2a, 0, ...u32(8), ...ifd(entries, inner + 8, inner)];
};

/** A CR3: an ftyp box, then a CMT3 box whose payload is a TIFF with the Canon tags as IFD0. */
function cr3File(lighting: number[]): Uint8Array {
  const payload = 16 + 8;
  const tiff = [0x49, 0x49, 0x2a, 0, ...u32(8), ...ifd([{ tag: 0x4018, type: 3, count: lighting.length, data: shorts(lighting) }], payload + 8, payload)];
  const box = [...[0, 0, 0, 8 + tiff.length].map((x) => x), ...text('CMT3'), ...tiff];
  return Uint8Array.from([0, 0, 0, 16, ...text('ftypcrx '), 0, 0, 0, 1, ...box]);
}

describe('Canon Highlight Tone Priority', () => {
  // LightingOpt: [size, peripheral illumination, Auto Lighting Optimizer, Highlight Tone Priority, ...]
  const lighting = (alo: number, htp: number) => [16, 0, alo, htp, 0, 0, 0, 0];

  it('adds a stop when Highlight Tone Priority is on (CR2-style TIFF)', () => {
    expect(readHighlightMode(tiffFile('Canon', canonNote(lighting(3, 1))))).toEqual({ brand: 'canon', raw: 1, ev: 1 });
    expect(highlightModeEv(tiffFile('Canon', canonNote(lighting(3, 1))))).toBe(1);
  });

  it('adds nothing when it is off, whatever Auto Lighting Optimizer does (that only touches the JPEG)', () => {
    for (const alo of [0, 1, 2, 3]) expect(readHighlightMode(tiffFile('Canon', canonNote(lighting(alo, 0))))).toEqual({ brand: 'canon', raw: 0, ev: 0 });
  });

  it('reads a CR3', () => {
    expect(readHighlightMode(cr3File(lighting(3, 1)))).toEqual({ brand: 'canon', raw: 1, ev: 1 });
    expect(highlightModeEv(cr3File(lighting(0, 0)))).toBe(0);
  });

  it('is null when the tag is missing', () => {
    expect(readHighlightMode(tiffFile('Canon', canonNote(null)))).toBeNull();
  });
});

describe('Nikon Active D-Lighting', () => {
  it('adds the stops the camera took off the exposure', () => {
    const ev = (adl: number) => highlightModeEv(tiffFile('NIKON CORPORATION', nikonNote(adl)));
    expect(ev(0)).toBe(0);
    expect(ev(3)).toBe(0.33);
    expect(ev(5)).toBe(0.66);
    expect(ev(7)).toBe(1);
    expect(ev(11)).toBe(1.33);
    expect(ev(4)).toBe(0); // not a setting it knows
  });

  it('reports the value it read', () => {
    expect(readHighlightMode(tiffFile('NIKON', nikonNote(7)))).toEqual({ brand: 'nikon', raw: 7, ev: 1 });
    expect(readHighlightMode(tiffFile('NIKON', nikonNote(null)))).toBeNull();
  });
});

describe('files it leaves alone', () => {
  it('skips a DNG, which has its own BaselineExposure', () => {
    const dng = Uint8Array.from([0x49, 0x49, 0x2a, 0, ...u32(8), ...ifd([{ tag: 0xc612, type: 1, count: 4, data: [1, 4, 0, 0] }], 8, 0)]);
    expect(readHighlightMode(dng)).toBeNull();
  });

  it('skips brands it does not cover', () => {
    expect(readHighlightMode(tiffFile('SONY', canonNote([16, 0, 0, 1, 0, 0, 0, 0])))).toBeNull();
  });

  it('never throws on broken data', () => {
    expect(highlightModeEv(new Uint8Array(0))).toBe(0);
    expect(highlightModeEv(new Uint8Array(100))).toBe(0);
    const good = tiffFile('Canon', canonNote([16, 0, 0, 1, 0, 0, 0, 0]));
    for (const cut of [4, 12, 40, 60, good.length - 8]) expect(() => highlightModeEv(good.slice(0, cut))).not.toThrow();
    expect(highlightModeEv(Uint8Array.from([0x49, 0x49, 0x2a, 0, 0xff, 0xff, 0xff, 0xff]))).toBe(0);
  });
});

// samples/ is git-ignored; RAW_SAMPLES_DIR points elsewhere (e.g. from a worktree).
const sample = (name: string) => (env.RAW_SAMPLES_DIR ? `${env.RAW_SAMPLES_DIR}/${name}` : new URL(`../../../samples/${name}`, import.meta.url));
const read = (name: string) => new Uint8Array(readFileSync(sample(name)));

describe('real files', () => {
  it.skipIf(!existsSync(sample('fuji-xt5.RAF')))('reads DR100 from the X-T5', () => {
    expect(readHighlightMode(read('fuji-xt5.RAF'))).toEqual({ brand: 'fujifilm', raw: 100, ev: 0 });
  });

  it.skipIf(!existsSync(sample('canon-r5.CR3')))('finds the Canon R5 setting (Highlight Tone Priority off)', () => {
    expect(readHighlightMode(read('canon-r5.CR3'))).toEqual({ brand: 'canon', raw: 0, ev: 0 });
  });

  it.skipIf(!existsSync(sample('nikon-z7.NEF')))('finds the Nikon Z7 setting (Active D-Lighting off)', () => {
    expect(readHighlightMode(read('nikon-z7.NEF'))).toEqual({ brand: 'nikon', raw: 0, ev: 0 });
  });

  it.skipIf(!existsSync(sample('sony-a7rv.ARW')) || !existsSync(sample('leica-q2.DNG')))('leaves a Sony ARW and a DNG alone', () => {
    expect(readHighlightMode(read('sony-a7rv.ARW'))).toBeNull();
    expect(readHighlightMode(read('leica-q2.DNG'))).toBeNull();
  });
});
