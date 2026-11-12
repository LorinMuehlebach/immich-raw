// What an exported file says about the photo, for each metadata choice. The copy Save puts in
// Immich keeps its own, smaller set (immichCopyExif, immichCopyXmp): Immich turns what a file
// lists as keywords into tags, so that copy lists exactly the RAW's tags and no other keywords.
import { buildXmp, exifFromImmich, type ExifFields, type ImmichExifLike, type XmpFields } from '@immich-raw/pipeline';
import { fillText, type MetadataMode } from '../state/export-settings.ts';

/** Tags the culler adds (Culling/Best, Culling/Rejected/Blur, ...): bookkeeping, not keywords. */
const CULL_TAG_ROOT = 'Culling';

export interface MetadataAsset {
  exifInfo?: (ImmichExifLike & { rating?: number | null; city?: string | null; state?: string | null; country?: string | null }) | null;
  tags?: { value: string }[] | null;
  localDateTime?: string | null;
  fileCreatedAt?: string | null;
}

export interface MetadataOptions {
  /** Copyright template ({year}, {owner}). */
  copyright: string;
  /** The photographer: the asset owner's name. */
  owner: string;
  software: string;
  ppi: number;
  width: number;
  height: number;
}

/**
 * When the photo was taken, as a Date whose local fields are the photo's wall-clock time
 * (Immich's localDateTime is that time written as UTC).
 */
export function captureDate(asset: Pick<MetadataAsset, 'localDateTime' | 'fileCreatedAt'>): Date | null {
  const local = Date.parse(asset.localDateTime ?? '');
  if (Number.isFinite(local)) {
    const d = new Date(local);
    return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
  }
  const created = Date.parse(asset.fileCreatedAt ?? '');
  return Number.isFinite(created) ? new Date(created) : null;
}

/** Immich tags as keywords ("Places/Europe/Paris"), without the culler's. */
export function keywordsOf(tags: MetadataAsset['tags']): string[] {
  const out = new Set<string>();
  for (const t of tags ?? []) {
    const v = t.value?.trim();
    if (!v || v === CULL_TAG_ROOT || v.startsWith(`${CULL_TAG_ROOT}/`)) continue;
    out.add(v);
  }
  return [...out];
}

/** 'YYYY:MM:DD HH:MM:SS' + '+01:00' -> '2022-12-17T16:03:36+01:00'. */
function isoDate(exifDate: string | undefined, offset: string | undefined): string | undefined {
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(exifDate ?? '');
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}${offset ?? ''}` : undefined;
}

export function exportMetadata(asset: MetadataAsset, mode: MetadataMode, o: MetadataOptions): { exif: ExifFields; xmp: XmpFields } {
  const copyright = fillText(o.copyright, { owner: o.owner, date: captureDate(asset) }) || undefined;
  const owner = o.owner.trim() || undefined;
  const base: ExifFields = { software: o.software, resolution: o.ppi, colorSpace: 'sRGB', pixelWidth: o.width, pixelHeight: o.height, artist: owner, copyright };
  const xmp: XmpFields = { creator: owner, rights: copyright, creatorTool: o.software };
  if (mode === 'copyright') return { exif: base, xmp };

  const fields = exifFromImmich(asset.exifInfo);
  if (mode === 'noLocation') delete fields.gps;
  const e = asset.exifInfo;
  const rating = e?.rating;
  const keywords = keywordsOf(asset.tags);
  Object.assign(xmp, {
    description: fields.imageDescription,
    keywords: keywords.length ? keywords : undefined,
    rating: typeof rating === 'number' && (rating === -1 || (rating >= 1 && rating <= 5)) ? rating : undefined,
    createDate: isoDate(fields.dateTimeOriginal, fields.offsetTimeOriginal),
  } satisfies XmpFields);
  if (mode === 'all') {
    Object.assign(xmp, { city: e?.city || undefined, state: e?.state || undefined, country: e?.country || undefined } satisfies XmpFields);
  }
  return { exif: { ...fields, ...base }, xmp };
}

/** EXIF for the copy Save uploads to Immich: what the RAW has, nothing Immich would turn into tags. */
export function immichCopyExif(asset: MetadataAsset, software: string, width: number, height: number): ExifFields {
  return { ...exifFromImmich(asset.exifInfo), software, colorSpace: 'sRGB', pixelWidth: width, pixelHeight: height };
}

/**
 * XMP for the copy Save uploads to Immich: every tag of the RAW, the culler's too, as
 * digiKam:TagsList. Save also tags the copy through the API; Immich's metadata job may run after
 * that and set the tags from the file, and this list makes it set the same ones. '' without tags.
 */
export function immichCopyXmp(asset: Pick<MetadataAsset, 'tags'>): string {
  const tags = (asset.tags ?? []).map((t) => t.value?.trim()).filter((v): v is string => !!v);
  return tags.length ? buildXmp({ tagsList: tags }) : '';
}
