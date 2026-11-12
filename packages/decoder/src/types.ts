/** Linear camera RGB (as-shot white balance applied, normalised so nothing clips), 16-bit. */
export interface LinearImage {
  width: number;
  height: number;
  /** Interleaved RGB, 0..65535. Not rotated: orientation is applied by the renderer. */
  data: Uint16Array;
  halfSize: boolean;
}

export interface RawMeta {
  /** Full-resolution size, sensor orientation. */
  width: number;
  height: number;
  /** LibRaw flip: 0 none, 3 = 180°, 5 = 90° counter-clockwise, 6 = 90° clockwise. */
  flip: number;
  /** As-shot multipliers [R, G, B, G2] as LibRaw reports them. */
  camMul: number[];
  preMul: number[];
  /** Camera (white balanced) -> linear sRGB, 3x4. */
  rgbCam: number[][];
  /** XYZ -> camera, 4x3 (Adobe ColorMatrix). */
  camXyz: number[][];
  black: number;
  maximum: number;
  /** DNG BaselineExposure in EV (0 for non-DNG files). */
  baselineExposure: number;
  isXTrans: boolean;
  make: string;
  model: string;
  lens: string;
  iso: number;
  /** Seconds. */
  shutter: number;
  aperture: number;
  focalLength: number;
}

export interface DecoderInfo {
  name: string;
  version: string;
  libraw: string;
  demosaic: string;
}

/** The sensor mosaic and what is needed to store it as a DNG (see readSensor). */
export interface SensorData {
  /** The visible area (what LibRaw decodes), sensor orientation. */
  width: number;
  height: number;
  /** Raw values of the visible area, row-major, black level not subtracted. */
  data: Uint16Array;
  /** Colour filter pattern: 2x2 (Bayer) or 6x6 (X-Trans), 0 = R, 1 = G, 2 = B, from pixel (0, 0). */
  patternWidth: number;
  patternHeight: number;
  pattern: number[];
  /** Black level per pattern position (the values LibRaw subtracts). */
  black: number[];
  white: number;
  /** The camera's default crop inside the visible area, if it reports one. */
  defaultCrop: { x: number; y: number; width: number; height: number } | null;
  meta: RawMeta;
  lensMake: string;
  bodySerial: string;
}
