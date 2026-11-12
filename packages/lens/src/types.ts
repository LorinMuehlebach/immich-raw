// The one lens-correction format the renderer understands. Lens profiles (Lensfun) and DNG
// opcode lists are both converted into it, so the shader has a single code path.
//
// Coordinates: normalised source coordinates s in [0,1]², sensor orientation (as decoded,
// before the camera orientation is applied), y down. The renderer maps every output pixel
// to an "ideal" (corrected) source point s, then asks this model where that point really
// is in the decoded image, per colour channel.

/** Up to r⁶: r_src = r · (c[0] + c[1]·r + c[2]·r² + … + c[6]·r⁶). Identity: [1, 0, 0, 0, 0, 0, 0]. */
export type RadialPoly = [number, number, number, number, number, number, number];

export const IDENTITY_POLY: RadialPoly = [1, 0, 0, 0, 0, 0, 0];

export interface RadialFrame {
  /** Optical centre, normalised source coordinates. */
  center: [number, number];
  /**
   * Turns a normalised offset into the model's radius units:
   * r = length((s - center) * scale). For an image of W x H pixels normalised by a
   * distance N in pixels, scale = [W / N, H / N].
   */
  scale: [number, number];
}

export interface LensCorrection {
  /** Where the profile came from, for the UI ("Lensfun: Sony FE 50mm F1.2 GM", "DNG opcodes"). */
  source: string;
  /** Distortion + lateral chromatic aberration, or null when the profile has none. */
  geometry: (RadialFrame & {
    /** Per channel R, G, B. r is the radius of the ideal (corrected) point. */
    poly: [RadialPoly, RadialPoly, RadialPoly];
  }) | null;
  /** Vignetting, or null. */
  vignetting: (RadialFrame & {
    /**
     * Gain polynomial in even powers: g(r) = 1 + k[0]·r² + k[1]·r⁴ + k[2]·r⁶ + k[3]·r⁸ + k[4]·r¹⁰,
     * evaluated at the radius of the point in the decoded image (before distortion correction).
     * 'multiply': corrected = value · g(r) (DNG FixVignetteRadial).
     * 'divide': corrected = value / g(r) (Lensfun "pa" model: g describes the falloff).
     */
    mode: 'multiply' | 'divide';
    k: [number, number, number, number, number];
  }) | null;
}

/** What is known about the camera and lens of a photo (from LibRaw and Immich's EXIF). */
export interface LensQuery {
  cameraMake: string;
  cameraModel: string;
  /** Lens name as reported by the camera / EXIF, may be empty. */
  lens: string;
  /** mm, 0 if unknown. */
  focalLength: number;
  /** f-number, 0 if unknown. */
  aperture: number;
  /** Focus distance in metres, 0 if unknown. */
  distance?: number;
  /** Size of the decoded image in pixels (sensor orientation). */
  width: number;
  height: number;
}
