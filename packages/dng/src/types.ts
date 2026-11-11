/**
 * Default tile size, for lossless and lossy files alike (Adobe DNG Converter uses 256 x 256 too).
 * Every function that takes a `tile` argument must get the same value for one file.
 */
export const DNG_TILE = 256;

/** Bayer or X-Trans mosaic, exactly as read from the sensor (black NOT subtracted). */
export interface CfaRaw {
  kind: 'cfa';
  width: number;
  height: number;
  /** Row-major, width * height. */
  data: Uint16Array;
  /** 2 x 2 for Bayer, 6 x 6 for X-Trans. */
  patternWidth: number;
  patternHeight: number;
  /** patternWidth * patternHeight colours (0 = R, 1 = G, 2 = B), row-major; pattern[0] is the colour of pixel (0, 0). */
  pattern: number[];
  /** Black level per pattern position (same order as `pattern`); may be fractional. */
  black: number[];
  /** Saturation level. */
  white: number;
}

/** Demosaiced camera-native RGB (not white balanced), 0..65535 with 65535 = sensor saturation, black already 0. */
export interface LinearRaw {
  kind: 'linear';
  width: number;
  height: number;
  /** Interleaved RGB, width * height * 3. */
  data: Uint16Array;
}

export interface DngExif {
  /** 'YYYY:MM:DD HH:MM:SS' */
  dateTimeOriginal?: string;
  /** '+HH:MM' or '-HH:MM' */
  offsetTimeOriginal?: string;
  /** Digits only, e.g. '25' */
  subSecTimeOriginal?: string;
  /** Seconds. */
  exposureTime?: number;
  fNumber?: number;
  iso?: number;
  /** EV */
  exposureBias?: number;
  /** mm */
  focalLength?: number;
  focalLengthIn35mm?: number;
  lensMake?: string;
  lensModel?: string;
  bodySerialNumber?: string;
}

export interface DngGps {
  /** Degrees, negative = south. */
  latitude: number;
  /** Degrees, negative = west. */
  longitude: number;
  /** Metres above sea level, negative = below. */
  altitude?: number;
}

export interface DngMetadata {
  make: string;
  model: string;
  uniqueCameraModel: string;
  software: string;
  /** TIFF Orientation 1..8. */
  orientation: number;
  /** 9 values, XYZ -> camera (Adobe ColorMatrix), row-major. */
  colorMatrix1: number[];
  /** EXIF LightSource code, e.g. 21 = D65, 17 = Standard light A. */
  calibrationIlluminant1: number;
  colorMatrix2?: number[];
  calibrationIlluminant2?: number;
  forwardMatrix1?: number[];
  forwardMatrix2?: number[];
  asShotNeutral: [number, number, number];
  /** EV */
  baselineExposure?: number;
  /** In raw pixels; the whole image when missing. */
  defaultCrop?: { x: number; y: number; width: number; height: number };
  originalRawFileName?: string;
  /** 'YYYY:MM:DD HH:MM:SS' (IFD0 DateTime). */
  dateTime?: string;
  exif?: DngExif;
  gps?: DngGps;
  /**
   * Copied verbatim from a source DNG (big-endian opcode lists as stored in tags 51008/51009/51022).
   * Lossy files drop lists 1 and 2: they describe the source's mosaic, not our 8-bit RGB codes
   * (see assembleDng).
   */
  opcodeList1?: Uint8Array;
  opcodeList2?: Uint8Array;
  opcodeList3?: Uint8Array;
  /** XMP packet for tag 700 in IFD0. */
  xmp?: string;
  /** IFD0 image, 8-bit RGB, at most 256 px on the long side. A 1 x 1 grey pixel when missing. */
  thumbnail?: { width: number; height: number; rgb: Uint8Array };
  /** Extra SubIFD with a baseline sRGB JPEG. */
  preview?: { width: number; height: number; jpeg: Uint8Array };
}

export interface TileLayout {
  across: number;
  down: number;
  count: number;
  /** Tile size actually used: `tile`, or the image size if that is smaller. */
  tileWidth: number;
  tileHeight: number;
}
