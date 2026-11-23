import { describe, expect, it } from 'vitest';
import { describeFujiCamera, rafPreviewRange, readFujiCamera, readFujiTags, readRafPreview } from './fuji-camera.ts';

type Tag = { tag: number; type: 2 | 3 | 4 | 5 | 9; values?: number[]; text?: string };

/** A Fujifilm maker note with tags of several types; values that don't fit the 4-byte field go after the IFD. */
function makerNote(tags: Tag[]): Uint8Array {
  const ifdAt = 12;
  const dataAt = ifdAt + 2 + tags.length * 12 + 4;
  const size = { 2: 1, 3: 2, 4: 4, 5: 8, 9: 4 } as const;
  let extra = 0;
  const lens = tags.map((t) => (t.type === 2 ? t.text!.length + 1 : t.values!.length));
  const total = lens.map((n, i) => n * size[tags[i]!.type]);
  total.forEach((n) => (extra += n > 4 ? n : 0));
  const b = new Uint8Array(dataAt + extra);
  const dv = new DataView(b.buffer);
  b.set([...'FUJIFILM'].map((c) => c.charCodeAt(0)));
  dv.setUint32(8, ifdAt, true);
  dv.setUint16(ifdAt, tags.length, true);
  let next = dataAt;
  tags.forEach((t, i) => {
    const e = ifdAt + 2 + i * 12;
    dv.setUint16(e, t.tag, true);
    dv.setUint16(e + 2, t.type, true);
    dv.setUint32(e + 4, lens[i]!, true);
    const at = total[i]! > 4 ? next : e + 8;
    if (total[i]! > 4) {
      dv.setUint32(e + 8, next, true);
      next += total[i]!;
    }
    if (t.type === 2) [...t.text!].forEach((c, k) => (b[at + k] = c.charCodeAt(0)));
    else
      t.values!.forEach((v, k) => {
        if (t.type === 3) dv.setUint16(at + k * 2, v & 0xffff, true);
        else if (t.type === 4) dv.setUint32(at + k * 4, v, true);
        else if (t.type === 9) dv.setInt32(at + k * 4, v, true);
        else {
          dv.setUint32(at + k * 8, Math.round(v * 100), true);
          dv.setUint32(at + k * 8 + 4, 100, true);
        }
      });
  });
  return b;
}

/** A RAF: header, then the camera's JPEG with the Exif holding the note. `cut` leaves off that many bytes at the end. */
function raf(note: Uint8Array, cut = 0): Uint8Array {
  const ifd0 = 8;
  const exif = ifd0 + 2 + 12 + 4;
  const noteAt = exif + 2 + 12 + 4;
  const tiff = new Uint8Array(noteAt + note.length);
  const t = new DataView(tiff.buffer);
  tiff.set([0x49, 0x49, 42, 0]);
  t.setUint32(4, ifd0, true);
  const entry = (at: number, tag: number, type: number, count: number, value: number) => {
    t.setUint16(at, 1, true);
    t.setUint16(at + 2, tag, true);
    t.setUint16(at + 4, type, true);
    t.setUint32(at + 6, count, true);
    t.setUint32(at + 10, value, true);
  };
  entry(ifd0, 0x8769, 4, 1, exif);
  entry(exif, 0x927c, 7, note.length, noteAt);
  tiff.set(note, noteAt);
  const app1 = 2 + 6 + tiff.length;
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, app1 >> 8, app1 & 0xff, ...[...'Exif\0\0'].map((c) => c.charCodeAt(0)), ...tiff, 0xff, 0xda, 0, 2, 1, 2, 3, 0xff, 0xd9]);
  const b = new Uint8Array(160 + jpeg.length + 1000 - cut);
  b.set([...'FUJIFILMCCD-RAW 0201'].map((c) => c.charCodeAt(0)));
  const dv = new DataView(b.buffer);
  dv.setUint32(84, 160, false);
  dv.setUint32(88, jpeg.length, false);
  b.set(jpeg.subarray(0, Math.min(jpeg.length, b.length - 160)), 160);
  return b;
}

// What an X-T30 shot at DR100 with everything at its default writes.
const DEFAULTS: Tag[] = [
  { tag: 0x1000, type: 2, text: 'NORMAL ' },
  { tag: 0x1001, type: 3, values: [3] },
  { tag: 0x1002, type: 3, values: [0] },
  { tag: 0x1003, type: 3, values: [0] },
  { tag: 0x100a, type: 9, values: [0, 0] },
  { tag: 0x100b, type: 3, values: [256] },
  { tag: 0x1040, type: 3, values: [0] },
  { tag: 0x1041, type: 3, values: [0] },
  { tag: 0x1047, type: 3, values: [0] },
  { tag: 0x1048, type: 3, values: [0] },
  { tag: 0x1401, type: 3, values: [0] },
  { tag: 0x1403, type: 3, values: [100] },
  { tag: 0x1404, type: 5, values: [23] },
  { tag: 0x1406, type: 5, values: [1.4] },
  { tag: 0x1447, type: 2, text: 'X-T30_0100' },
];

describe('the camera\'s own JPEG', () => {
  it('is found from the header', () => {
    const file = raf(makerNote(DEFAULTS));
    const range = rafPreviewRange(file)!;
    expect(range.start).toBe(160);
    const jpeg = readRafPreview(file)!;
    expect(jpeg.length).toBe(range.end - range.start);
    expect([jpeg[0], jpeg[1], jpeg[jpeg.length - 2], jpeg[jpeg.length - 1]]).toEqual([0xff, 0xd8, 0xff, 0xd9]);
  });

  it('is only returned once the bytes reach its end', () => {
    const file = raf(makerNote(DEFAULTS));
    const range = rafPreviewRange(file)!;
    expect(readRafPreview(file.subarray(0, range.end - 1))).toBeNull();
    expect(readRafPreview(file.subarray(0, range.end))).not.toBeNull();
    // The first 92 bytes are enough to know where it is.
    expect(rafPreviewRange(file.subarray(0, 92))).toEqual(range);
  });

  it('is null for what is not a RAF, or has odd offsets', () => {
    expect(readRafPreview(new Uint8Array(200))).toBeNull();
    expect(rafPreviewRange(new Uint8Array(10))).toBeNull();
    const bad = raf(makerNote(DEFAULTS));
    new DataView(bad.buffer).setUint32(88, 0x7fffffff, false);
    expect(rafPreviewRange(bad)).toBeNull();
    const notJpeg = raf(makerNote(DEFAULTS));
    notJpeg[160] = 0;
    expect(readRafPreview(notJpeg)).toBeNull();
  });
});

describe('readFujiTags', () => {
  it('reads every tag, whatever its type', () => {
    const tags = readFujiTags(raf(makerNote(DEFAULTS)))!;
    expect(tags.size).toBe(DEFAULTS.length);
    expect(tags.get(0x1000)).toBe('NORMAL');
    expect(tags.get(0x1447)).toBe('X-T30_0100');
    expect(tags.get(0x1403)).toEqual([100]);
    expect(tags.get(0x100a)).toEqual([0, 0]);
    expect(tags.get(0x1404)).toEqual([23]);
    expect(tags.get(0x1406)![0]).toBeCloseTo(1.4, 5);
  });

  it('reads signed values and lists', () => {
    const tags = readFujiTags(raf(makerNote([{ tag: 0x100a, type: 9, values: [-40, 60] }, { tag: 0x1023, type: 3, values: [1590, 1472] }, { tag: 0x1430, type: 4, values: [1, 2, 3] }])))!;
    expect(tags.get(0x100a)).toEqual([-40, 60]);
    expect(tags.get(0x1023)).toEqual([1590, 1472]);
    expect(tags.get(0x1430)).toEqual([1, 2, 3]);
  });

  it('is null without a maker note, for non-RAFs and for broken data', () => {
    expect(readFujiTags(new Uint8Array(0))).toBeNull();
    expect(readFujiTags(new Uint8Array(500))).toBeNull();
    const file = raf(makerNote(DEFAULTS));
    expect(readFujiTags(file.subarray(0, 200))).toBeNull();
  });
});

describe('describeFujiCamera', () => {
  const settings = (tags: Tag[]) => Object.fromEntries(describeFujiCamera(readFujiTags(raf(makerNote(tags)))!).map((s) => [s.label, s.value]));

  it('reads the defaults of an X-T30', () => {
    expect(settings(DEFAULTS)).toEqual({
      'Film simulation': 'Provia / Standard',
      'Dynamic range': 'DR100',
      'White balance': 'Auto',
      Sharpness: 'Normal',
      'Highlight tone': '0',
      'Shadow tone': '0',
      Colour: 'Normal',
      'Grain effect': 'Off',
      'Color Chrome Effect': 'Off',
    });
  });

  it('reads tones, grain, white balance and the colour effects that were set', () => {
    const s = settings([
      { tag: 0x1041, type: 3, values: [-16] }, // +1
      { tag: 0x1040, type: 3, values: [8] }, // -0.5
      { tag: 0x1047, type: 3, values: [32] },
      { tag: 0x104c, type: 3, values: [32] },
      { tag: 0x1048, type: 3, values: [64] },
      { tag: 0x104e, type: 3, values: [32] },
      { tag: 0x1002, type: 3, values: [0xff0] },
      { tag: 0x1005, type: 3, values: [5600] },
      { tag: 0x100a, type: 9, values: [-40, 60] },
      { tag: 0x1401, type: 3, values: [0x600] },
      { tag: 0x1403, type: 3, values: [400] },
    ]);
    expect(s['Highlight tone']).toBe('+1');
    expect(s['Shadow tone']).toBe('-0.5');
    expect(s['Grain effect']).toBe('Weak, Large');
    expect(s['Color Chrome Effect']).toBe('Strong');
    expect(s['Color Chrome FX Blue']).toBe('Weak');
    expect(s['White balance']).toBe('Kelvin');
    expect(s['Colour temperature']).toBe('5600 K');
    expect(s['White balance shift']).toBe('red -2, blue 3');
    expect(s['Film simulation']).toBe('Classic Chrome');
    expect(s['Dynamic range']).toBe('DR400');
  });

  it('names a monochrome simulation with its filter and leaves out Colour', () => {
    const s = settings([{ tag: 0x1003, type: 3, values: [0x501] }, { tag: 0x1401, type: 3, values: [0] }]);
    expect(s['Film simulation']).toBe('Acros (red filter)');
    expect(s.Colour).toBeUndefined();
  });

  it('shows a value it does not know as the number', () => {
    expect(settings([{ tag: 0x1001, type: 3, values: [77] }]).Sharpness).toBe('77');
  });

  it('gives tags and settings together', () => {
    const camera = readFujiCamera(raf(makerNote(DEFAULTS)))!;
    expect(camera.tags.size).toBe(DEFAULTS.length);
    expect(camera.settings.length).toBeGreaterThan(5);
    expect(readFujiCamera(new Uint8Array(40))).toBeNull();
  });
});
