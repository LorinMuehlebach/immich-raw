import { describe, expect, it } from 'vitest';
import { mul3, mulVec3 } from './matrices.ts';
import { OUTPUT_SPACES, OUTPUT_SPACE_INFO, decodeTrc, encodeTrc, srgb8Converter } from './output-spaces.ts';
import { PROPHOTO_TO_SRGB } from './spaces.ts';

const close = (a: readonly number[], b: readonly number[], tol: number) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, tol));

describe('output colour spaces', () => {
  it('convert linear sRGB like the published matrices', () => {
    close(OUTPUT_SPACE_INFO['display-p3'].fromSrgb, [0.8225, 0.1774, 0, 0.0332, 0.9669, 0, 0.0171, 0.0724, 0.9108], 3);
    close(OUTPUT_SPACE_INFO['adobe-rgb'].fromSrgb, [0.7152, 0.2848, 0, 0, 1, 0, 0, 0.0412, 0.9588], 3);
    close(OUTPUT_SPACE_INFO.srgb.fromSrgb, [1, 0, 0, 0, 1, 0, 0, 0, 1], 12);
  });

  it('keep white white', () => {
    for (const s of OUTPUT_SPACES) close(mulVec3(OUTPUT_SPACE_INFO[s].fromSrgb, [1, 1, 1]), [1, 1, 1], 4);
  });

  it('take ProPhoto back to the working-space values exactly', () => {
    close(mul3(OUTPUT_SPACE_INFO.prophoto.fromSrgb, PROPHOTO_TO_SRGB), [1, 0, 0, 0, 1, 0, 0, 0, 1], 10);
  });

  it('have colorants that add up to the ICC white, and luma weights that add up to 1', () => {
    for (const s of OUTPUT_SPACES) {
      const m = OUTPUT_SPACE_INFO[s].toPcs;
      close([m[0]! + m[1]! + m[2]!, m[3]! + m[4]! + m[5]!, m[6]! + m[7]! + m[8]!], [0.9642, 1, 0.8249], 4);
      const l = OUTPUT_SPACE_INFO[s].luma;
      expect(l[0] + l[1] + l[2]).toBeCloseTo(1, 4);
    }
  });

  it('encode and decode their curves', () => {
    for (const s of OUTPUT_SPACES) {
      for (const v of [0, 0.001, 0.02, 0.18, 0.5, 1]) expect(decodeTrc(s, encodeTrc(s, v))).toBeCloseTo(v, 9);
    }
    expect(encodeTrc('srgb', 0.18)).toBeCloseTo(0.46136, 4);
    expect(encodeTrc('display-p3', 0.18)).toBeCloseTo(0.46136, 4);
    expect(encodeTrc('adobe-rgb', 0.18)).toBeCloseTo(0.18 ** (256 / 563), 9);
    expect(encodeTrc('prophoto', 0.18)).toBeCloseTo(0.18 ** (256 / 461), 9);
    expect(encodeTrc('srgb', -0.5)).toBe(0);
    expect(encodeTrc('srgb', 2)).toBeCloseTo(1, 12);
  });

  it('convert 8-bit sRGB colours into each space', () => {
    expect(srgb8Converter('srgb')(255, 128, 0)).toEqual([1, 128 / 255, 0]);
    for (const s of OUTPUT_SPACES) {
      close(srgb8Converter(s)(255, 255, 255), [1, 1, 1], 4);
      close(srgb8Converter(s)(0, 0, 0), [0, 0, 0], 9);
    }
    // sRGB red is inside P3: less red, a little green and blue there.
    const [r, g, b] = srgb8Converter('display-p3')(255, 0, 0);
    expect(r).toBeCloseTo(0.9175, 3);
    expect(g).toBeCloseTo(0.2003, 3);
    expect(b).toBeCloseTo(0.1386, 3);
  });
});
