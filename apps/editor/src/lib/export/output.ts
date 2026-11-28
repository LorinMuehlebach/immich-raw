// From the rendered photo to the exported file: size, output sharpening, watermark, file type
// and metadata, as one export preset says.
import { encodeRgbTiff } from '@immich-raw/dng';
import {
  OUTPUT_SPACE_INFO,
  SRGB8,
  addPngMetadata,
  asImageData,
  buildExifTiff,
  buildXmp,
  convertPixels,
  drawLogoWatermark,
  drawWatermark,
  encodeJpeg,
  encodePng16,
  iccProfile,
  insertExif,
  insertIcc,
  insertXmp,
  outputSharpen,
  pixelsOf,
  resizePixels,
  srgb8Converter,
  WEBP_MAX_SIDE,
  zlib,
  type ExifFields,
  type OutputColor,
  type Pixels,
} from '@immich-raw/pipeline';
import { APP_ID } from '@immich-raw/recipe';
import { fillText, outputSize, validColor, type ExportFormat, type ExportPreset } from '../state/export-settings.ts';
import { encodeOffThread } from './encoder.ts';
import { captureDate, exportMetadata, immichCopyExif, immichCopyXmp, type MetadataAsset } from './metadata.ts';

export type OutputStep = 'resize' | 'sharpen' | 'encode';

export interface ExportFile {
  bytes: Uint8Array;
  width: number;
  height: number;
  mime: string;
  /** What the file lacks that the preset asked for, as sentences for a notice (e.g. a missing logo). */
  notes: string[];
}

export const MISSING_LOGO = "The watermark logo isn't in this browser, so the photo was exported without a watermark.";

export const FORMAT_MIME: Record<ExportFormat, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  tiff: 'image/tiff',
  webp: 'image/webp',
  avif: 'image/avif',
  jxl: 'image/jxl',
};

export interface OutputOptions {
  /** Copyright template ({year}, {owner}). */
  copyright: string;
  /** Name of the photo's owner (artist, {owner}). */
  owner: string;
  /** The copy Save uploads to Immich: always JPEG, no watermark, the RAW's own metadata. */
  forImmich?: boolean;
  /** The preset's watermark logo, decoded (loadLogoBitmap); null when it isn't in this browser. */
  logo?: ImageBitmap | null;
  onStep?: (step: OutputStep) => void;
}

async function encodePng(image: ImageData): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser cannot encode PNG.');
  ctx.putImageData(image, 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return new Uint8Array(await blob.arrayBuffer());
}

function tiffMetadata(exif: ExifFields, xmp: string, ppi: number) {
  return {
    make: exif.make,
    model: exif.model,
    software: exif.software,
    artist: exif.artist,
    copyright: exif.copyright,
    description: exif.imageDescription,
    dateTime: exif.dateTimeOriginal,
    offsetTime: exif.offsetTimeOriginal,
    lensModel: exif.lensModel,
    fNumber: exif.fNumber,
    exposureTime: exif.exposureTime,
    iso: exif.iso,
    focalLength: exif.focalLength,
    gps: exif.gps,
    ppi,
    xmp: xmp || undefined,
  };
}

/** The colour space and bit depth the export is made in: the preset's, sRGB 8-bit for the Immich copy. */
export function outputColor(preset: Pick<ExportPreset, 'format' | 'color'>, forImmich = false): OutputColor {
  return forImmich ? SRGB8 : validColor(preset.format, preset.color);
}

const bitsMatch = (p: Pixels, c: OutputColor) => p.space === c.space && p.bits === c.bits;

/**
 * Turns the full-size rendered photo into the file the preset describes. `rendered` should be in
 * outputColor(preset) (a RAW renders straight into it); 8-bit sRGB pixels from elsewhere are
 * converted. The pixels are sharpened and watermarked in place and may be handed to an encoder
 * worker: don't use `rendered` afterwards.
 */
export async function finishExport(rendered: Pixels | ImageData, asset: MetadataAsset, preset: ExportPreset, o: OutputOptions): Promise<ExportFile> {
  const color = outputColor(preset, o.forImmich);
  let image: Pixels = 'bits' in rendered ? rendered : pixelsOf(rendered);
  if (!bitsMatch(image, color)) image = convertPixels(image, color);
  const size = outputSize(image.width, image.height, preset.size, preset.ppi);
  if (!o.forImmich && preset.format === 'webp' && (size.width > WEBP_MAX_SIDE || size.height > WEBP_MAX_SIDE)) {
    throw new Error(`WebP can't be larger than ${WEBP_MAX_SIDE} pixels a side; this export would be ${size.width} × ${size.height}. Choose a smaller size.`);
  }
  if (size.width !== image.width || size.height !== image.height) {
    o.onStep?.('resize');
    image = await resizePixels(image, size.width, size.height);
  }
  const info = OUTPUT_SPACE_INFO[color.space];
  if (preset.sharpen.for !== 'none') {
    o.onStep?.('sharpen');
    outputSharpen(image, preset.sharpen.for, preset.sharpen.amount, preset.ppi, info.luma);
  }
  const notes: string[] = [];
  const wm = preset.watermark;
  if (!o.forImmich && wm.enabled) {
    // Marks are drawn in sRGB; other spaces get their colours converted.
    const convert = color.space === 'srgb' ? undefined : srgb8Converter(color.space);
    if (wm.kind === 'image') {
      if (o.logo) drawLogoWatermark(image, o.logo, { position: wm.position, size: wm.imageSize, opacity: wm.opacity }, convert);
      else notes.push(MISSING_LOGO);
    } else {
      const text = fillText(wm.text, { owner: o.owner, date: captureDate(asset) });
      if (text) drawWatermark(image, { ...wm, text }, convert);
    }
  }
  o.onStep?.('encode');
  const { width, height } = image;

  if (o.forImmich) {
    const jpeg = insertExif(await encodeJpeg(asImageData(image), preset.quality.jpeg / 100), immichCopyExif(asset, APP_ID, width, height));
    return { bytes: insertXmp(jpeg, immichCopyXmp(asset)), width, height, mime: FORMAT_MIME.jpeg, notes };
  }

  const meta = exportMetadata(asset, preset.metadata, { copyright: o.copyright, owner: o.owner, software: APP_ID, ppi: preset.ppi, width, height });
  const wide = color.space !== 'srgb';
  meta.exif.colorSpace = wide ? 'uncalibrated' : 'sRGB';
  const icc = wide ? iccProfile(color.space) : undefined;
  const xmp = buildXmp(meta.xmp);
  let bytes: Uint8Array;
  switch (preset.format) {
    case 'jpeg':
      bytes = insertExif(await encodeJpeg(asImageData(image), preset.quality.jpeg / 100), meta.exif);
      if (xmp) bytes = insertXmp(bytes, xmp);
      if (icc) bytes = insertIcc(bytes, icc);
      break;
    case 'png': {
      const png = image.bits === 16 ? await encodePng16(image as Pixels & { data: Uint16Array }) : await encodePng(asImageData(image));
      const iccp = icc ? { name: info.description, zlib: await zlib(icc as Uint8Array<ArrayBuffer>) } : undefined;
      bytes = addPngMetadata(png, { exif: buildExifTiff(meta.exif), xmp: xmp || undefined, ppi: preset.ppi, srgb: !wide, iccp });
      break;
    }
    case 'tiff':
      bytes = await encodeRgbTiff(image, { ...tiffMetadata(meta.exif, xmp, preset.ppi), icc, colorSpace: meta.exif.colorSpace });
      break;
    case 'webp':
    case 'avif':
    case 'jxl':
      // AVIF gets no EXIF or XMP: they would be extra items in its item tables, not a chunk to
      // add; its colour space is a code (CICP) instead of a profile.
      bytes = await encodeOffThread({
        format: preset.format,
        width,
        height,
        data: image.data as Uint8ClampedArray<ArrayBuffer>,
        quality: preset.quality[preset.format],
        lossless: preset.lossless,
        exif: preset.format === 'avif' ? undefined : buildExifTiff(meta.exif),
        xmp: preset.format === 'avif' ? undefined : xmp || undefined,
        icc: preset.format === 'webp' ? icc : undefined,
        cicp: preset.format === 'avif' ? (info.cicp ?? undefined) : undefined,
      });
      break;
  }
  return { bytes, width, height, mime: FORMAT_MIME[preset.format], notes };
}
