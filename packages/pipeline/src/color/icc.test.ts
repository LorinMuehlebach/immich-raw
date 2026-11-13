import { describe, expect, it } from 'vitest';
import { iccProfile } from './icc.ts';
import { OUTPUT_SPACE_INFO, type OutputSpace } from './output-spaces.ts';

const WIDE: OutputSpace[] = ['display-p3', 'adobe-rgb', 'prophoto'];
const str = (b: Uint8Array, at: number, n = 4) => String.fromCharCode(...b.subarray(at, at + n));

function tagsOf(p: Uint8Array): Map<string, Uint8Array> {
  const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
  const tags = new Map<string, Uint8Array>();
  for (let i = 0, n = dv.getUint32(128); i < n; i++) {
    const e = 132 + i * 12;
    const off = dv.getUint32(e + 4);
    const size = dv.getUint32(e + 8);
    expect(off % 4).toBe(0);
    expect(off + size).toBeLessThanOrEqual(p.length);
    tags.set(str(p, e), p.subarray(off, off + size));
  }
  return tags;
}

const xyz = (t: Uint8Array) => {
  const dv = new DataView(t.buffer, t.byteOffset, t.byteLength);
  expect(str(t, 0)).toBe('XYZ ');
  return [0, 1, 2].map((i) => dv.getInt32(8 + i * 4) / 65536);
};

describe('iccProfile', () => {
  it.each(WIDE)('%s: a valid version 2 RGB display profile', (space) => {
    const p = iccProfile(space);
    const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
    expect(dv.getUint32(0)).toBe(p.length);
    expect(p.length % 4).toBe(0);
    expect(dv.getUint32(8)).toBe(0x02400000);
    expect([str(p, 12), str(p, 16), str(p, 20), str(p, 36)]).toEqual(['mntr', 'RGB ', 'XYZ ', 'acsp']);
    const tags = tagsOf(p);
    expect([...tags.keys()]).toEqual(['desc', 'cprt', 'wtpt', 'rXYZ', 'gXYZ', 'bXYZ', 'rTRC', 'gTRC', 'bTRC']);
    expect(str(tags.get('desc')!, 12, OUTPUT_SPACE_INFO[space].description.length)).toBe(OUTPUT_SPACE_INFO[space].description);
  });

  it.each(WIDE)('%s: colorants from the space, adding up to D50', (space) => {
    const tags = tagsOf(iccProfile(space));
    const [r, g, b] = ['rXYZ', 'gXYZ', 'bXYZ'].map((k) => xyz(tags.get(k)!));
    const m = OUTPUT_SPACE_INFO[space].toPcs;
    for (let i = 0; i < 3; i++) {
      expect(r![i]).toBeCloseTo(m[i * 3]!, 4);
      expect(g![i]).toBeCloseTo(m[i * 3 + 1]!, 4);
      expect(b![i]).toBeCloseTo(m[i * 3 + 2]!, 4);
    }
    const sum = [0, 1, 2].map((i) => r![i]! + g![i]! + b![i]!);
    [0.9642, 1, 0.8249].forEach((v, i) => expect(sum[i]).toBeCloseTo(v, 3));
    expect(xyz(tags.get('wtpt')!).map((v) => Math.round(v * 1e4) / 1e4)).toEqual([0.9642, 1, 0.8249]);
  });

  it('writes pure gamma curves for Adobe RGB and ProPhoto, and the sRGB curve for Display P3', () => {
    const curve = (space: OutputSpace) => {
      const t = tagsOf(iccProfile(space)).get('rTRC')!;
      const dv = new DataView(t.buffer, t.byteOffset, t.byteLength);
      expect(str(t, 0)).toBe('curv');
      return { count: dv.getUint32(8), first: dv.getUint16(12), at: (i: number) => dv.getUint16(12 + i * 2) };
    };
    expect(curve('adobe-rgb')).toMatchObject({ count: 1, first: 563 });
    expect(curve('prophoto')).toMatchObject({ count: 1, first: 461 });
    const p3 = curve('display-p3');
    expect(p3.count).toBe(1024);
    expect(p3.at(0)).toBe(0);
    expect(p3.at(1023)).toBe(65535);
    // Encoded 0.5 is linear 0.214 on the sRGB curve.
    expect(p3.at(Math.round(0.5 * 1023)) / 65535).toBeCloseTo(0.2140, 2);
  });

  it('shares one curve between the three channels and gives the same bytes every time', () => {
    const p = iccProfile('display-p3');
    const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
    const offsets = [6, 7, 8].map((i) => dv.getUint32(132 + i * 12 + 4));
    expect(new Set(offsets).size).toBe(1);
    expect(iccProfile('display-p3')).toBe(p);
    expect([...iccProfile('adobe-rgb')]).not.toEqual([...p]);
  });
});
