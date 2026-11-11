// Cutting the image into DNG tiles: lossless JPEG tiles of the CFA mosaic, and the 8-bit
// RGBA tiles the app JPEG-encodes for lossy (LinearRaw) files.
import { DNG_TILE, type CfaRaw, type LinearRaw, type TileLayout } from './types.ts';
import { encodeLosslessJpeg } from './ljpeg.ts';

/**
 * Tile grid for an image. Tiles are `tile` x `tile`, but never larger than the image: LibRaw's
 * lossless_dng_load_raw wraps a tile row at min(TileWidth, image width), so a tile wider than
 * the image would be decoded misaligned.
 */
export function tileLayout(width: number, height: number, tile: number = DNG_TILE): TileLayout {
  if (!(width > 0 && height > 0)) throw new Error(`Bad image size ${width}x${height}`);
  if (!(tile >= 16) || tile % 2) throw new Error(`Bad tile size ${tile}`);
  const tileWidth = Math.min(tile, width);
  const tileHeight = Math.min(tile, height);
  const across = Math.ceil(width / tileWidth);
  const down = Math.ceil(height / tileHeight);
  return { across, down, count: across * down, tileWidth, tileHeight };
}

/**
 * Number of interleaved components in each lossless JPEG tile. With 2 components a tile of W
 * columns becomes a W/2 x H frame, so predictor 1 predicts from the pixel two to the left,
 * which has the same colour in a Bayer mosaic (what Adobe and the cameras do too). X-Trans
 * uses 2 as well: on a Fujifilm X-T5 file it was 2 % smaller than 1 component (10.94 vs 11.17
 * bits/pixel).
 * LibRaw falls into a special case (decodes 2 * W samples per JPEG row) when
 * components * TileWidth equals the image width, so 1 component is used there.
 */
export function cfaComponents(width: number, tileWidth: number, patternWidth = 2): number {
  return patternWidth % 2 === 0 && tileWidth % 2 === 0 && 2 * tileWidth !== width ? 2 : 1;
}

// Tile pixels, reused between calls.
let tileBuf = new Uint16Array(0);

/** Copies tile `index` into `dst`, replicating the last column/row past the image edge. */
function extractTile(data: Uint16Array, width: number, height: number, layout: TileLayout, index: number, dst: Uint16Array): void {
  const { tileWidth: tw, tileHeight: th } = layout;
  const x0 = (index % layout.across) * tw;
  const y0 = Math.floor(index / layout.across) * th;
  const inside = Math.min(tw, width - x0);
  for (let r = 0; r < th; r++) {
    const src = Math.min(y0 + r, height - 1) * width + x0;
    const row = r * tw;
    dst.set(data.subarray(src, src + inside), row);
    if (inside < tw) dst.fill(data[src + inside - 1]!, row + inside, row + tw);
  }
}

/** Internal: encodeCfaTile with an explicit component count (for measurements). */
export function encodeCfaTileWith(raw: Pick<CfaRaw, 'data' | 'width' | 'height'>, index: number, tile: number, components: number): Uint8Array {
  const layout = tileLayout(raw.width, raw.height, tile);
  if (!(index >= 0 && index < layout.count)) throw new Error(`Tile ${index} out of range (0..${layout.count - 1})`);
  if (raw.data.length < raw.width * raw.height) throw new Error('CFA data is shorter than width * height');
  if (layout.tileWidth % components) throw new Error(`Tile width ${layout.tileWidth} is not a multiple of ${components} components`);
  const n = layout.tileWidth * layout.tileHeight;
  if (tileBuf.length < n) tileBuf = new Uint16Array(n);
  extractTile(raw.data, raw.width, raw.height, layout, index, tileBuf);
  return encodeLosslessJpeg(tileBuf, layout.tileWidth / components, layout.tileHeight, components, 16);
}

/**
 * Lossless JPEG (SOF3, predictor 1, precision 16) of tile `index` (row-major tiles). Edge tiles
 * are padded by replicating the last column/row.
 */
export function encodeCfaTile(raw: Pick<CfaRaw, 'data' | 'width' | 'height' | 'patternWidth'>, index: number, tile: number = DNG_TILE): Uint8Array {
  const { tileWidth } = tileLayout(raw.width, raw.height, tile);
  return encodeCfaTileWith(raw, index, tile, cfaComponents(raw.width, tileWidth, raw.patternWidth));
}

// ---------------------------------------------------------------------------------------
// Lossy encoding curve

/**
 * f(x) = x/64 + x²/4 + x³/2 + 15x⁴/64 maps an 8-bit code x = code/255 to linear 0..1.
 * Written into the file as a MapPolynomial opcode (OpcodeList2), which both Adobe and LibRaw
 * apply. Roughly gamma 2.4 with a linear toe: relative step per code is ~1.2 % at white, 1.9 %
 * at -2.5 EV, 4.3 % at -6 EV, 7.5 % at -8 EV, 15 % at -10 EV; the first code is 4.3/65535.
 * (sRGB: 0.9 %, 1.8 %, 5 %, 9 %, 31 %, first code 20/65535.)
 * All coefficients are positive (monotonic, no cancellation when the DNG SDK evaluates them in
 * float32) and exact binary fractions summing to exactly 1, so f(1) = 1 in any evaluation
 * order and LibRaw's truncating (ushort)(f * 65535) gives exactly 65535 for code 255.
 */
export const LOSSY_POLY: readonly number[] = Object.freeze([0, 1 / 64, 1 / 4, 1 / 2, 15 / 64]);

/** f(x) for LOSSY_POLY (Horner). */
export function lossyCurve(x: number): number {
  let y = 0;
  for (let j = LOSSY_POLY.length - 1; j >= 0; j--) y = y * x + LOSSY_POLY[j]!;
  return y;
}

let lossyLut: Uint8Array | null = null;

/**
 * 65536-entry table linear 16-bit -> code, code = round(255 * f⁻¹(v / 65535)): v gets code c
 * when f((c - 0.5) / 255) <= v / 65535 < f((c + 0.5) / 255).
 */
export function lossyEncodeLut(): Uint8Array {
  if (lossyLut) return lossyLut;
  const lut = new Uint8Array(65536);
  let v = 0;
  for (let c = 1; c <= 255; c++) {
    const threshold = Math.ceil(lossyCurve((c - 0.5) / 255) * 65535);
    lut.fill(c - 1, v, threshold);
    v = Math.max(v, threshold);
  }
  lut.fill(255, v);
  lossyLut = lut;
  return lut;
}

/**
 * 8-bit RGBA pixels (alpha 255) of tile `index` of a LinearRaw, mapped through the lossy curve
 * and padded like encodeCfaTile. The app JPEG-encodes these (baseline, not progressive) and
 * passes the JPEGs to assembleDng.
 */
export function lossyTileRgba(
  raw: Pick<LinearRaw, 'data' | 'width' | 'height'>,
  index: number,
  tile: number = DNG_TILE,
): { data: Uint8ClampedArray; width: number; height: number } {
  const { width, height, data } = raw;
  const layout = tileLayout(width, height, tile);
  if (!(index >= 0 && index < layout.count)) throw new Error(`Tile ${index} out of range (0..${layout.count - 1})`);
  if (data.length < width * height * 3) throw new Error('LinearRaw data is shorter than width * height * 3');
  const { tileWidth: tw, tileHeight: th } = layout;
  const x0 = (index % layout.across) * tw;
  const y0 = Math.floor(index / layout.across) * th;
  const lut = lossyEncodeLut();
  const out = new Uint8ClampedArray(tw * th * 4);
  const inside = Math.min(tw, width - x0);
  for (let r = 0; r < th; r++) {
    let s = (Math.min(y0 + r, height - 1) * width + x0) * 3;
    let d = r * tw * 4;
    for (let x = 0; x < inside; x++, s += 3, d += 4) {
      out[d] = lut[data[s]!]!;
      out[d + 1] = lut[data[s + 1]!]!;
      out[d + 2] = lut[data[s + 2]!]!;
      out[d + 3] = 255;
    }
    // Replicate the last pixel of the row.
    for (let x = inside; x < tw; x++, d += 4) {
      out[d] = out[d - 4]!;
      out[d + 1] = out[d - 3]!;
      out[d + 2] = out[d - 2]!;
      out[d + 3] = 255;
    }
  }
  return { data: out, width: tw, height: th };
}
