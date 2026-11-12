// TIFF / EXIF / GPS / DNG tag numbers used by the writer and reader.

export const TAG = {
  NewSubFileType: 254,
  ImageWidth: 256,
  ImageLength: 257,
  BitsPerSample: 258,
  Compression: 259,
  PhotometricInterpretation: 262,
  ImageDescription: 270,
  Make: 271,
  Model: 272,
  StripOffsets: 273,
  Orientation: 274,
  SamplesPerPixel: 277,
  RowsPerStrip: 278,
  StripByteCounts: 279,
  XResolution: 282,
  YResolution: 283,
  PlanarConfiguration: 284,
  ResolutionUnit: 296,
  Software: 305,
  DateTime: 306,
  Artist: 315,
  Predictor: 317,
  TileWidth: 322,
  TileLength: 323,
  TileOffsets: 324,
  TileByteCounts: 325,
  SubIFDs: 330,
  YCbCrSubSampling: 530,
  XMP: 700,
  CFARepeatPatternDim: 33421,
  CFAPattern: 33422,
  Copyright: 33432,
  ExifIFD: 34665,
  GPSInfo: 34853,
  DNGVersion: 50706,
  DNGBackwardVersion: 50707,
  UniqueCameraModel: 50708,
  CFAPlaneColor: 50710,
  CFALayout: 50711,
  LinearizationTable: 50712,
  BlackLevelRepeatDim: 50713,
  BlackLevel: 50714,
  WhiteLevel: 50717,
  DefaultScale: 50718,
  DefaultCropOrigin: 50719,
  DefaultCropSize: 50720,
  ColorMatrix1: 50721,
  ColorMatrix2: 50722,
  AsShotNeutral: 50728,
  BaselineExposure: 50730,
  AntiAliasStrength: 50738,
  CalibrationIlluminant1: 50778,
  CalibrationIlluminant2: 50779,
  BestQualityScale: 50780,
  OriginalRawFileName: 50827,
  ActiveArea: 50829,
  ForwardMatrix1: 50964,
  ForwardMatrix2: 50965,
  PreviewColorSpace: 50970,
  OpcodeList1: 51008,
  OpcodeList2: 51009,
  OpcodeList3: 51022,
} as const;

export const EXIF_TAG = {
  ExposureTime: 33434,
  FNumber: 33437,
  ISOSpeedRatings: 34855,
  SensitivityType: 34864,
  ISOSpeed: 34867,
  ExifVersion: 36864,
  DateTimeOriginal: 36867,
  OffsetTimeOriginal: 36881,
  ExposureBiasValue: 37380,
  FocalLength: 37386,
  SubSecTimeOriginal: 37521,
  ColorSpace: 40961,
  PixelXDimension: 40962,
  PixelYDimension: 40963,
  FocalLengthIn35mmFilm: 41989,
  BodySerialNumber: 42033,
  LensMake: 42035,
  LensModel: 42036,
} as const;

export const GPS_TAG = {
  GPSVersionID: 0,
  GPSLatitudeRef: 1,
  GPSLatitude: 2,
  GPSLongitudeRef: 3,
  GPSLongitude: 4,
  GPSAltitudeRef: 5,
  GPSAltitude: 6,
} as const;

export const COMPRESSION_NONE = 1;
export const COMPRESSION_JPEG = 7;
/** Adobe Deflate: zlib streams. */
export const COMPRESSION_DEFLATE = 8;
export const COMPRESSION_LOSSY_JPEG = 34892;
export const PHOTOMETRIC_RGB = 2;
export const PHOTOMETRIC_YCBCR = 6;
export const PHOTOMETRIC_CFA = 32803;
export const PHOTOMETRIC_LINEAR_RAW = 34892;
export const PREDICTOR_HORIZONTAL = 2;
