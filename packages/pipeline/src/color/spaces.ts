// Working-space conversions. The pipeline works in linear ProPhoto (D50).
import {
  BRADFORD_D50_TO_D65,
  BRADFORD_D65_TO_D50,
  type Mat3,
  PROPHOTO_TO_XYZ_D50,
  SRGB_TO_XYZ_D65,
  type Vec3,
  XYZ_D50_TO_PROPHOTO,
  XYZ_D65_TO_LMS_OKLAB,
  XYZ_D65_TO_SRGB,
  fromRows,
  inv3,
  mul3,
} from './matrices.ts';

/**
 * LibRaw's rgb_cam takes white-balanced camera RGB to linear sRGB (D65).
 * Composed with sRGB -> XYZ -> Bradford -> ProPhoto it gives camera -> linear ProPhoto (D50).
 */
export function cameraToProPhoto(rgbCam: readonly (readonly number[])[]): Mat3 {
  return mul3(XYZ_D50_TO_PROPHOTO, mul3(BRADFORD_D65_TO_D50, mul3(SRGB_TO_XYZ_D65, fromRows(rgbCam))));
}

export const PROPHOTO_TO_SRGB: Mat3 = mul3(XYZ_D65_TO_SRGB, mul3(BRADFORD_D50_TO_D65, PROPHOTO_TO_XYZ_D50));

/** Luminance (Y) weights of linear ProPhoto. */
export const PROPHOTO_LUMA: Vec3 = [PROPHOTO_TO_XYZ_D50[3]!, PROPHOTO_TO_XYZ_D50[4]!, PROPHOTO_TO_XYZ_D50[5]!];

/** Linear ProPhoto -> OKLab LMS (before the cube root). */
export const PROPHOTO_TO_LMS: Mat3 = mul3(XYZ_D65_TO_LMS_OKLAB, mul3(BRADFORD_D50_TO_D65, PROPHOTO_TO_XYZ_D50));
export const LMS_TO_PROPHOTO: Mat3 = inv3(PROPHOTO_TO_LMS);
