import { parseXmp, type CrsSettings } from './parse.ts';

export { parseXmp, CRS_NS, IRE_NS, RDF_NS, TIFF_NS, type CrsSettings, type XmpStruct, type XmpValue } from './parse.ts';
export { importMasks, MASK_CONTAINERS, LOCAL_ROWS, type MaskImport } from './masks.ts';
export { crsToPatch, parseCurve, parseNumber, profileFromName, BOOL_ROWS, CURVE_KEYS, ENUM_ROWS, NUMBER_ROWS, type AppliedSetting, type ImportResult, type NumberRow } from './map.ts';
export { patchToXmp, recipeToXmp, formatNumber, CRS_VERSION, PROCESS_VERSION, type ExportOptions } from './export.ts';
export { cropToLrCrop, lrCropToCrop, turnsFromFlip, turnsFromExifOrientation, exifOrientationFromTurns, type CropContext, type LrCrop, type ImportedCrop } from './crop.ts';

/** crs: keys that say nothing about how the photo looks. */
const BOOKKEEPING = new Set(['Version', 'ProcessVersion', 'CompatibleVersion', 'HasSettings', 'AlreadyApplied', 'RawFileName', 'CameraProfileDigest', 'HasCrop']);

export function hasDevelopSettings(crs: CrsSettings | null): boolean {
  if (!crs) return false;
  if (Object.keys(crs.lists).length > 0) return true;
  return Object.keys(crs.values).some((k) => !BOOKKEEPING.has(k));
}

/**
 * True when the XMP holds Lightroom / Camera Raw develop settings. Immich writes its own
 * sidecars (date, rating, location) without them, and those return false.
 */
export function isLightroomSidecar(text: string): boolean {
  return hasDevelopSettings(parseXmp(text));
}
