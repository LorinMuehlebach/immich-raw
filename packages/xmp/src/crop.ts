// Lightroom crop <-> our crop.
//
// Lightroom (crs:CropLeft/Top/Right/Bottom/Angle), as darktable's importer
// (src/develop/lightroom.c) reads it:
// - The four values are two opposite corners of the crop box, (Left, Top) and
//   (Right, Bottom), normalised to the image in SENSOR orientation (before EXIF
//   orientation), x by width and y by height.
// - The box is axis-aligned on screen; the image is rotated by CropAngle about the
//   centre underneath it. In sensor coordinates (y down) the screen frame is
//   R(a) = [[cos a, sin a], [-sin a, cos a]] applied to the image, i.e. a positive
//   CropAngle turns the image counter-clockwise. darktable feeds the value unchanged
//   into ashift, whose rotation has the same direction.
//
// Ours (packages/recipe CropParams): centre and size are fractions of the UPRIGHT
// image (camera orientation + rotate90), and a positive angle turns the image
// clockwise. Quarter turns don't change the direction of a rotation, so
// ourAngle = -CropAngle for every non-mirrored orientation.
import type { CropParams } from '@immich-raw/recipe';

export interface CropContext {
  /** LibRaw flip of the camera file (0, 3, 5, 6). */
  flip: number;
  /** Image size after the camera orientation only (crop.rotate90 = 0), any unit. */
  uprightWidth: number;
  uprightHeight: number;
}

export interface LrCrop {
  left: number;
  top: number;
  right: number;
  bottom: number;
  /** crs:CropAngle, degrees. */
  angle: number;
}

/** Sign of Lightroom's angle relative to ours (see the note above). */
const LR_ANGLE_SIGN = -1;

type Turns = 0 | 1 | 2 | 3;

export function turnsFromFlip(flip: number): Turns {
  if (flip === 3) return 2;
  if (flip === 6) return 1;
  if (flip === 5) return 3;
  return 0;
}

/** Clockwise quarter turns for an EXIF orientation; null for mirrored ones. */
export function turnsFromExifOrientation(o: number): Turns | null {
  return ({ 1: 0, 6: 1, 3: 2, 8: 3 } as Record<number, Turns>)[o] ?? null;
}

export function exifOrientationFromTurns(t: Turns): number {
  return [1, 6, 3, 8][t]!;
}

function sensorSize(ctx: CropContext): { w: number; h: number } {
  return turnsFromFlip(ctx.flip) % 2 === 1 ? { w: ctx.uprightHeight, h: ctx.uprightWidth } : { w: ctx.uprightWidth, h: ctx.uprightHeight };
}

/** upright normalised -> sensor normalised, for `t` clockwise quarter turns. */
function uprightToSensor(t: Turns, x: number, y: number): [number, number] {
  switch (t) {
    case 1:
      return [y, 1 - x];
    case 2:
      return [1 - x, 1 - y];
    case 3:
      return [1 - y, x];
    default:
      return [x, y];
  }
}

function sensorToUpright(t: Turns, x: number, y: number): [number, number] {
  switch (t) {
    case 1:
      return [1 - y, x];
    case 2:
      return [1 - x, 1 - y];
    case 3:
      return [y, 1 - x];
    default:
      return [x, y];
  }
}

export type ImportedCrop = Pick<CropParams, 'cx' | 'cy' | 'w' | 'h' | 'angle' | 'rotate90'>;

/**
 * Lightroom crop -> ours. `orientationTurns` is the orientation Lightroom used
 * (tiff:Orientation in the sidecar); it defaults to the camera's.
 */
export function lrCropToCrop(lr: LrCrop, ctx: CropContext, orientationTurns?: Turns): ImportedCrop {
  const camTurns = turnsFromFlip(ctx.flip);
  const t = orientationTurns ?? camTurns;
  const { w: Ws, h: Hs } = sensorSize(ctx);
  const a = (lr.angle * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  // corner-to-corner vector in sensor pixels, turned into the screen frame
  const dx = (lr.right - lr.left) * Ws;
  const dy = (lr.bottom - lr.top) * Hs;
  const sw = Math.abs(dx * c + dy * s);
  const sh = Math.abs(-dx * s + dy * c);
  const [ux, uy] = sensorToUpright(t, (lr.left + lr.right) / 2, (lr.top + lr.bottom) / 2);
  const odd = t % 2 === 1;
  const Wu = odd ? Hs : Ws;
  const Hu = odd ? Ws : Hs;
  return {
    cx: ux,
    cy: uy,
    w: (odd ? sh : sw) / Wu,
    h: (odd ? sw : sh) / Hu,
    angle: LR_ANGLE_SIGN * lr.angle,
    rotate90: (((t - camTurns) % 4) + 4) % 4 as Turns,
  };
}

/** Ours -> Lightroom crop, plus the EXIF orientation Lightroom should show. */
export function cropToLrCrop(crop: Pick<CropParams, 'cx' | 'cy' | 'w' | 'h' | 'angle' | 'rotate90'>, ctx: CropContext): LrCrop & { orientation: number } {
  const camTurns = turnsFromFlip(ctx.flip);
  const t = ((camTurns + crop.rotate90) % 4) as Turns;
  const { w: Ws, h: Hs } = sensorSize(ctx);
  const odd = t % 2 === 1;
  const Wu = odd ? Hs : Ws;
  const Hu = odd ? Ws : Hs;
  const bw = crop.w * Wu;
  const bh = crop.h * Hu;
  // box size along the sensor-orientation screen axes
  const sw = odd ? bh : bw;
  const sh = odd ? bw : bh;
  const [sx, sy] = uprightToSensor(t, crop.cx, crop.cy);
  const angle = crop.angle / LR_ANGLE_SIGN;
  const a = (angle * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  // screen offset of the top-left corner (-sw/2, -sh/2) back into the image: R(a)^-1
  const ox = c * (-sw / 2) - s * (-sh / 2);
  const oy = s * (-sw / 2) + c * (-sh / 2);
  return {
    left: sx + ox / Ws,
    top: sy + oy / Hs,
    right: sx - ox / Ws,
    bottom: sy - oy / Hs,
    angle,
    orientation: exifOrientationFromTurns(t),
  };
}
