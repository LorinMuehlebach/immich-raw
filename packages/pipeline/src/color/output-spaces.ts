// The colour spaces an export can be written in: their primaries and white, the curve their
// values are encoded with, and how a file says which space it is in (EXIF, ICC, CICP).
// The renderer works in linear ProPhoto and finishes in (extended) sRGB; an export in another
// space converts from linear sRGB with `fromSrgb` as its very last step.
import { PROPHOTO_TO_SRGB } from './spaces.ts';
import {
  type Mat3,
  type Vec3,
  PROPHOTO_TO_XYZ_D50,
  SRGB_TO_XYZ_D65,
  WHITE_D50_XYZ,
  WHITE_D65_XYZ,
  bradford,
  inv3,
  mul3,
  rgbToXyzMatrix,
} from './matrices.ts';

export type OutputSpace = 'srgb' | 'display-p3' | 'adobe-rgb' | 'prophoto';
export const OUTPUT_SPACES: readonly OutputSpace[] = ['srgb', 'display-p3', 'adobe-rgb', 'prophoto'];

/** Colour space and bits per sample of an export. */
export interface OutputColor {
  space: OutputSpace;
  bits: 8 | 16;
}

export const SRGB8: OutputColor = { space: 'srgb', bits: 8 };

/** The ICC profile connection space's white (D50 as ICC.1 rounds it). */
export const ICC_D50: Vec3 = [0.9642, 1.0, 0.8249];

export interface OutputSpaceInfo {
  /** Linear sRGB (D65) -> linear in this space, adapted to its white (Bradford). */
  fromSrgb: Mat3;
  /** Linear RGB in this space -> XYZ relative to ICC_D50; its columns are the ICC colorants. */
  toPcs: Mat3;
  /** Pure power curve exponent (value = linear^(1/gamma)); null = the sRGB curve. */
  gamma: number | null;
  /** Weights of R, G and B in this space's luminance. */
  luma: Vec3;
  /** Exif ColorSpace: 1 sRGB, 0xFFFF uncalibrated (the space is in the ICC profile). */
  exifColorSpace: 1 | 0xffff;
  /** Code points for AVIF (ISO/IEC 23091-2), where there are any. */
  cicp: { primaries: number; transfer: number } | null;
  /** The ICC profile's description. */
  description: string;
}

const xyz = (x: number, y: number) => ({ x, y });
const P3_TO_XYZ_D65 = rgbToXyzMatrix(xyz(0.68, 0.32), xyz(0.265, 0.69), xyz(0.15, 0.06), WHITE_D65_XYZ);
const ADOBE_TO_XYZ_D65 = rgbToXyzMatrix(xyz(0.64, 0.33), xyz(0.21, 0.71), xyz(0.15, 0.06), WHITE_D65_XYZ);
const D65_TO_PCS = bradford(WHITE_D65_XYZ, ICC_D50);
const D50_TO_PCS = bradford(WHITE_D50_XYZ, ICC_D50);
const lumaOf = (toXyz: Mat3): Vec3 => [toXyz[3]!, toXyz[4]!, toXyz[5]!];

export const OUTPUT_SPACE_INFO: Record<OutputSpace, OutputSpaceInfo> = {
  srgb: {
    fromSrgb: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    toPcs: mul3(D65_TO_PCS, SRGB_TO_XYZ_D65),
    gamma: null,
    luma: [0.2126, 0.7152, 0.0722],
    exifColorSpace: 1,
    cicp: { primaries: 1, transfer: 13 },
    description: 'sRGB',
  },
  'display-p3': {
    fromSrgb: mul3(inv3(P3_TO_XYZ_D65), SRGB_TO_XYZ_D65),
    toPcs: mul3(D65_TO_PCS, P3_TO_XYZ_D65),
    gamma: null,
    luma: lumaOf(P3_TO_XYZ_D65),
    exifColorSpace: 0xffff,
    cicp: { primaries: 12, transfer: 13 },
    description: 'Display P3',
  },
  'adobe-rgb': {
    fromSrgb: mul3(inv3(ADOBE_TO_XYZ_D65), SRGB_TO_XYZ_D65),
    toPcs: mul3(D65_TO_PCS, ADOBE_TO_XYZ_D65),
    // 2.2 as Adobe's profile stores it in an ICC curve: 563/256.
    gamma: 563 / 256,
    luma: lumaOf(ADOBE_TO_XYZ_D65),
    exifColorSpace: 0xffff,
    cicp: null,
    description: 'Compatible with Adobe RGB (1998)',
  },
  prophoto: {
    // The exact inverse of the renderer's own ProPhoto -> sRGB step, so a ProPhoto export
    // gets the working-space values back.
    fromSrgb: inv3(PROPHOTO_TO_SRGB),
    toPcs: mul3(D50_TO_PCS, PROPHOTO_TO_XYZ_D50),
    // 1.8 as Adobe's ProPhoto profile stores it: 461/256.
    gamma: 461 / 256,
    luma: lumaOf(PROPHOTO_TO_XYZ_D50),
    exifColorSpace: 0xffff,
    cicp: null,
    description: 'ProPhoto RGB',
  },
};

/** Linear value (0..1) -> encoded in `space`. */
export function encodeTrc(space: OutputSpace, v: number): number {
  const x = Math.min(1, Math.max(0, v));
  const g = OUTPUT_SPACE_INFO[space].gamma;
  if (g !== null) return x ** (1 / g);
  return x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
}

/** Encoded value (0..1) in `space` -> linear. */
export function decodeTrc(space: OutputSpace, v: number): number {
  const x = Math.min(1, Math.max(0, v));
  const g = OUTPUT_SPACE_INFO[space].gamma;
  if (g !== null) return x ** g;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
}

/**
 * Converts 8-bit sRGB colours (e.g. a watermark logo) to encoded values (0..1) in `space`,
 * clipped to its gamut. Identity for sRGB.
 */
export function srgb8Converter(space: OutputSpace): (r: number, g: number, b: number) => Vec3 {
  if (space === 'srgb') return (r, g, b) => [r / 255, g / 255, b / 255];
  const lut = Float64Array.from({ length: 256 }, (_, i) => decodeTrc('srgb', i / 255));
  const m = OUTPUT_SPACE_INFO[space].fromSrgb;
  return (r, g, b) => {
    const lr = lut[r]!;
    const lg = lut[g]!;
    const lb = lut[b]!;
    return [
      encodeTrc(space, m[0]! * lr + m[1]! * lg + m[2]! * lb),
      encodeTrc(space, m[3]! * lr + m[4]! * lg + m[5]! * lb),
      encodeTrc(space, m[6]! * lr + m[7]! * lg + m[8]! * lb),
    ];
  };
}
