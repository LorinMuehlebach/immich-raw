// Which lens correction a photo gets: the DNG's own, a Lensfun profile (matched or chosen in
// Lens Corrections), or none. Shared by the editor and the album export.
import type { RawMeta } from '@immich-raw/decoder';
import { dngCorrection, lensfunCorrection, loadLensfun, parseDngOpcodes, type LensCorrection, type LensQuery, type LensfunDb, type LensfunJson, type LensfunResult } from '@immich-raw/lens';

interface ExifLike {
  lensModel?: string | null;
  make?: string | null;
  model?: string | null;
  focalLength?: number | null;
  fNumber?: number | null;
}

/** Camera and lens to look up, from the RAW's metadata, else Immich's EXIF. */
export function lensQueryFor(meta: Pick<RawMeta, 'make' | 'model' | 'lens' | 'focalLength' | 'aperture'>, exif: ExifLike | null | undefined, size: { fullWidth: number; fullHeight: number }): LensQuery {
  return {
    cameraMake: meta.make || exif?.make || '',
    cameraModel: meta.model || exif?.model || '',
    lens: (exif?.lensModel || meta.lens || '').trim(),
    focalLength: meta.focalLength || exif?.focalLength || 0,
    aperture: meta.aperture || exif?.fNumber || 0,
    width: size.fullWidth,
    height: size.fullHeight,
  };
}

/** The correction a DNG carries in its opcode lists, or null (also for other files). */
export function dngLensFor(fileName: string | null | undefined, bytes: Uint8Array, size: { fullWidth: number; fullHeight: number }): LensCorrection | null {
  if (!/\.dng$/i.test(fileName ?? '')) return null;
  const ops = parseDngOpcodes(bytes);
  return ops ? dngCorrection(ops, { width: size.fullWidth, height: size.fullHeight }) : null;
}

let lensDb: Promise<LensfunDb | null> | null = null;

/** The Lensfun database (1.3 MB), loaded once per page. */
export function loadLensDb(): Promise<LensfunDb | null> {
  lensDb ??= fetch(`${import.meta.env.BASE_URL}lensfun/lensfun.json`)
    .then(async (res) => (res.ok ? loadLensfun((await res.json()) as LensfunJson) : null))
    .catch((e) => {
      console.warn('Lens profile lookup failed', e);
      lensDb = null;
      return null;
    });
  return lensDb;
}

export interface LensPick {
  profile: LensCorrection | null;
  /** For the Lens Corrections panel. */
  label: string | null;
  auto: LensfunResult | null;
  chosen: LensfunResult | null;
}

/** The file's own correction wins unless a lens was chosen; Lensfun then only adds missing vignetting. */
export function pickLensProfile(db: LensfunDb | null, q: LensQuery, dngLens: LensCorrection | null, lensId: string | null | undefined): LensPick {
  const auto = db ? lensfunCorrection(db, q) : null;
  const chosen = db && lensId ? lensfunCorrection(db, q, { lens: lensId }) : null;
  const lf = chosen ?? auto;
  if (dngLens && !chosen) {
    const vig = dngLens.vignetting ?? lf?.correction.vignetting ?? null;
    return {
      profile: { ...dngLens, vignetting: vig },
      label: `Built into the DNG${!dngLens.vignetting && vig && lf ? ` (vignetting from Lensfun: ${lf.lens})` : ''}`,
      auto,
      chosen,
    };
  }
  if (lf) return { profile: lf.correction, label: `Lensfun: ${lf.lens}${chosen ? '' : ` (for ${lf.camera})`}`, auto, chosen };
  return { profile: null, label: null, auto, chosen };
}
