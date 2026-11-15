// Opens a developed photo (JPEG, PNG, WebP, HEIC, ...) for editing, and says what to warn about.
// The browser decodes the original; a format it can't read (HEIC outside Safari, TIFF, ...) is
// edited from Immich's full-size JPEG of it instead, which may be smaller than the original.
import { ImageSession } from '@immich-raw/decoder';
import type { AssetResponseDto } from '@immich/sdk';
import { downloadFullsizePreview } from './immich/download.ts';

type ImageAsset = Pick<AssetResponseDto, 'id' | 'originalFileName' | 'originalMimeType' | 'exifInfo'>;

export interface OpenedImage {
  session: ImageSession;
  /** Opened from Immich's JPEG of the photo: the browser can't read the original. */
  fromPreview: boolean;
}

/** The file format for messages: "JPEG", "HEIC", "PNG", ... ("Photo" without an extension). */
export function formatName(fileName: string | null | undefined): string {
  const name = fileName ?? '';
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toUpperCase() : '';
  if (ext === 'JPG' || ext === 'JPE' || ext === 'JFIF') return 'JPEG';
  if (ext === 'TIF') return 'TIFF';
  return ext || 'Photo';
}

export async function openImageSession(asset: ImageAsset, bytes: Uint8Array, signal?: AbortSignal): Promise<OpenedImage> {
  const exif = asset.exifInfo;
  try {
    const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: asset.originalMimeType ?? '' });
    return { session: await ImageSession.open(blob, exif), fromPreview: false };
  } catch (e) {
    signal?.throwIfAborted();
    console.warn(`The browser can't read ${asset.originalFileName}; opening Immich's full-size JPEG of it`, e);
  }
  const preview = await downloadFullsizePreview(asset.id, signal);
  try {
    return { session: await ImageSession.open(new Blob([preview as Uint8Array<ArrayBuffer>]), exif), fromPreview: true };
  } catch (e) {
    signal?.throwIfAborted();
    console.warn('Immich\'s full-size JPEG could not be read either', e);
    throw new Error(`This browser can't read ${formatName(asset.originalFileName)} files, and Immich has no copy of this photo it can read.`);
  }
}

/** The tag next to the file name, e.g. "JPEG, not a RAW". */
export function notRawTag(fileName: string | null | undefined): string {
  return `${formatName(fileName)}, not a RAW`;
}

/** Why a photo that isn't a RAW won't edit as well (the title tag's tooltip, the banner). */
export function notRawExplanation(fileName: string | null | undefined): string {
  return (
    `You can edit this ${formatName(fileName)}, but it won't come out as well as a RAW: the camera has already set its ` +
    'white balance, contrast and sharpening and kept only 8 bits per colour, so big changes can show banding and blown-out highlights.'
  );
}

/** The banner's extra line when the editor works on Immich's JPEG of the photo. */
export function previewExplanation(fileName: string | null | undefined, opened: { width: number; height: number }, original?: { width?: number | null; height?: number | null }): string {
  const size = `${opened.width} × ${opened.height}`;
  const orig = original?.width && original.height ? ` (the original is ${original.width} × ${original.height})` : '';
  return `This browser can't read ${formatName(fileName)} files, so you are editing Immich's ${size} JPEG of it${orig}.`;
}
