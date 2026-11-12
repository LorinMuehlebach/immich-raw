// From the rendered photo to the exported file: size, output sharpening, watermark, file type
// and metadata, as one export preset says.
import { encodeRgbTiff } from '@immich-raw/dng';
import {
  addPngMetadata,
  buildExifTiff,
  buildXmp,
  drawWatermark,
  encodeJpeg,
  insertExif,
  insertXmp,
  outputSharpen,
  resizeImage,
  WEBP_MAX_SIDE,
  type ExifFields,
} from '@immich-raw/pipeline';
import { APP_ID } from '@immich-raw/recipe';
import { fillText, outputSize, type ExportFormat, type ExportPreset } from '../state/export-settings.ts';
import { encodeOffThread } from './encoder.ts';
import { captureDate, exportMetadata, immichCopyExif, immichCopyXmp, type MetadataAsset } from './metadata.ts';

export type OutputStep = 'resize' | 'sharpen' | 'encode';

export interface ExportFile {
  bytes: Uint8Array;
  width: number;
  height: number;
  mime: string;
}

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

/**
 * Turns the full-size rendered photo into the file the preset describes. The rendered pixels
 * may be handed to an encoder worker: don't use `rendered` afterwards.
 */
export async function finishExport(rendered: ImageData, asset: MetadataAsset, preset: ExportPreset, o: OutputOptions): Promise<ExportFile> {
  const size = outputSize(rendered.width, rendered.height, preset.size, preset.ppi);
  if (!o.forImmich && preset.format === 'webp' && (size.width > WEBP_MAX_SIDE || size.height > WEBP_MAX_SIDE)) {
    throw new Error(`WebP can't be larger than ${WEBP_MAX_SIDE} pixels a side; this export would be ${size.width} × ${size.height}. Choose a smaller size.`);
  }
  let image = rendered;
  if (size.width !== image.width || size.height !== image.height) {
    o.onStep?.('resize');
    image = await resizeImage(image, size.width, size.height);
  }
  if (preset.sharpen.for !== 'none') {
    o.onStep?.('sharpen');
    if (image === rendered) image = new ImageData(new Uint8ClampedArray(image.data), image.width, image.height);
    outputSharpen(image, preset.sharpen.for, preset.sharpen.amount, preset.ppi);
  }
  if (!o.forImmich && preset.watermark.enabled) {
    const text = fillText(preset.watermark.text, { owner: o.owner, date: captureDate(asset) });
    if (text) image = drawWatermark(image, { ...preset.watermark, text });
  }
  o.onStep?.('encode');
  const { width, height } = image;

  if (o.forImmich) {
    const jpeg = insertExif(await encodeJpeg(image, preset.quality.jpeg / 100), immichCopyExif(asset, APP_ID, width, height));
    return { bytes: insertXmp(jpeg, immichCopyXmp(asset)), width, height, mime: FORMAT_MIME.jpeg };
  }

  const meta = exportMetadata(asset, preset.metadata, { copyright: o.copyright, owner: o.owner, software: APP_ID, ppi: preset.ppi, width, height });
  const xmp = buildXmp(meta.xmp);
  let bytes: Uint8Array;
  switch (preset.format) {
    case 'jpeg':
      bytes = insertExif(await encodeJpeg(image, preset.quality.jpeg / 100), meta.exif);
      if (xmp) bytes = insertXmp(bytes, xmp);
      break;
    case 'png':
      bytes = addPngMetadata(await encodePng(image), { exif: buildExifTiff(meta.exif), xmp: xmp || undefined, ppi: preset.ppi, srgb: true });
      break;
    case 'tiff':
      bytes = await encodeRgbTiff(image, tiffMetadata(meta.exif, xmp, preset.ppi));
      break;
    case 'webp':
    case 'avif':
    case 'jxl':
      // AVIF gets no EXIF or XMP: they would be extra items in its item tables, not a chunk to add.
      bytes = await encodeOffThread({
        format: preset.format,
        width,
        height,
        data: image.data,
        quality: preset.quality[preset.format],
        lossless: preset.lossless,
        exif: preset.format === 'avif' ? undefined : buildExifTiff(meta.exif),
        xmp: preset.format === 'avif' ? undefined : xmp || undefined,
      });
      break;
  }
  return { bytes, width, height, mime: FORMAT_MIME[preset.format] };
}
