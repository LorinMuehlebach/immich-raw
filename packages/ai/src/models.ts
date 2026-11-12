// The models behind the AI masks and AI Upscale. They are downloaded from their public hosts the
// first time they are needed and kept in the browser (IndexedDB); the photo itself never leaves it.
// Revisions are pinned: another model would give old edits different masks, so change them
// on purpose only. Licences are listed in THIRD-PARTY-NOTICES.md.
import type { AiSpec } from './types.ts';

export type ModelId =
  | 'subject'
  | 'scene'
  | 'objectEncoder'
  | 'objectDecoder'
  | 'peopleParts'
  | 'faceLandmarks'
  | 'upscaleSharp'
  | 'upscaleNatural2'
  | 'upscaleNatural4';

export interface ModelInfo {
  id: ModelId;
  /** Shown while it downloads. */
  label: string;
  url: string;
  bytes: number;
  licence: string;
}

const HF = 'https://huggingface.co';
const MP = 'https://storage.googleapis.com/mediapipe-models';

export const MODELS: Record<ModelId, ModelInfo> = {
  // IS-Net (DIS), general use, int8. Input 1024 x 1024.
  subject: {
    id: 'subject',
    label: 'subject model',
    url: `${HF}/xrds/isnet-general-onnx-int8/resolve/71eff2372ec9c8edbc6ca637ded591423d23b65a/onnx/model_quantized.onnx`,
    bytes: 44229662,
    licence: 'MIT',
  },
  // UperNet + ConvNeXt-Tiny trained on ADE20K (150 classes). Input 512 x 512.
  scene: {
    id: 'scene',
    label: 'scene model',
    url: `${HF}/JElvis/upernet-convnext-tiny-ade-onnx/resolve/a8e2807c3479bc617b37d8ed53e68660b3fa1ebb/model.onnx`,
    bytes: 238434293,
    licence: 'MIT',
  },
  // SlimSAM (Segment Anything, pruned), int8: image encoder and prompt decoder.
  objectEncoder: {
    id: 'objectEncoder',
    label: 'object model',
    url: `${HF}/Xenova/slimsam-77-uniform/resolve/5850ab45f587c112167512ffef949107115e26a0/onnx/vision_encoder_quantized.onnx`,
    bytes: 8882165,
    licence: 'Apache-2.0',
  },
  objectDecoder: {
    id: 'objectDecoder',
    label: 'object model',
    url: `${HF}/Xenova/slimsam-77-uniform/resolve/5850ab45f587c112167512ffef949107115e26a0/onnx/prompt_encoder_mask_decoder_quantized.onnx`,
    bytes: 4903810,
    licence: 'Apache-2.0',
  },
  // MediaPipe: hair, body skin, face skin and clothes; and face landmarks (eyes, lips, brows).
  peopleParts: {
    id: 'peopleParts',
    label: 'people model',
    url: `${MP}/image_segmenter/selfie_multiclass_256x256/float32/1/selfie_multiclass_256x256.tflite`,
    bytes: 16371837,
    licence: 'Apache-2.0',
  },
  faceLandmarks: {
    id: 'faceLandmarks',
    label: 'face model',
    url: `${MP}/face_landmarker/face_landmarker/float16/1/face_landmarker.task`,
    bytes: 3758596,
    licence: 'Apache-2.0',
  },
  // AI Upscale. Real-ESRGAN general x4v3 (SRVGGNetCompact, 4x, any input size): sharp and fast.
  upscaleSharp: {
    id: 'upscaleSharp',
    label: 'upscale model',
    url: `${HF}/jonathanst29/tinier-upscale-models/resolve/899dc1e4b22bbf1955c2f1739c085edc080cb366/realesr-general-x4v3.onnx`,
    bytes: 4866396,
    licence: 'BSD-3-Clause',
  },
  // RealPLKSR (darktable's upscaler), MSSIM-trained: natural, about 5x slower. Fixed input size.
  upscaleNatural2: {
    id: 'upscaleNatural2',
    label: 'natural upscale model',
    url: `${HF}/darktable-org/upscale-realplksr-onnx/resolve/0bb636eeeed5fffd256571c3cc440d9fdf62467e/onnx/model_x2.onnx`,
    bytes: 29627920,
    licence: 'MIT',
  },
  upscaleNatural4: {
    id: 'upscaleNatural4',
    label: 'natural upscale model',
    url: `${HF}/darktable-org/upscale-realplksr-onnx/resolve/0bb636eeeed5fffd256571c3cc440d9fdf62467e/onnx/model_x4.onnx`,
    bytes: 29711010,
    licence: 'MIT',
  },
};

export type UpscaleStyle = 'sharp' | 'natural';
export type UpscaleScale = 2 | 4;

/** How a model is run for one AI Upscale setting. */
export interface Upscaler {
  model: ModelId;
  /** The model's own factor; a 4x model makes 2x by averaging 2x2 blocks. */
  nativeScale: UpscaleScale;
  /** Input side the model takes (fixed-size models), or null for any size. */
  fixedSide: number | null;
  /** Context on each side of a tile that is cut off again (input pixels). */
  pad: number;
  /** Width over which a tile blends into the tiles above and left of it (input pixels, at most pad). */
  band: number;
}

/**
 * Pads were measured against one big run (docs/spike-results.md): Real-ESRGAN matches exactly from
 * 24 px; RealPLKSR differs by a few levels from tile to tile whatever the pad, so its tiles blend.
 */
export function upscaler(style: UpscaleStyle, scale: UpscaleScale): Upscaler {
  if (style === 'sharp') return { model: 'upscaleSharp', nativeScale: 4, fixedSide: null, pad: 24, band: 8 };
  return scale === 2
    ? { model: 'upscaleNatural2', nativeScale: 2, fixedSide: 512, pad: 32, band: 16 }
    : { model: 'upscaleNatural4', nativeScale: 4, fixedSide: 256, pad: 32, band: 16 };
}

/**
 * Input side of a tile: the fixed size, or for any-size models 512 on a GPU (fewer, bigger tiles
 * are faster there) and 256 on the CPU (progress and Cancel stay responsive).
 */
export function tileSide(u: Upscaler, gpu: boolean): number {
  return u.fixedSide ?? (gpu ? 512 : 256);
}

/** The models a component needs. */
export function modelsFor(spec: Pick<AiSpec, 'target' | 'box'>): ModelId[] {
  switch (spec.target) {
    case 'subject':
    case 'background':
      return ['subject'];
    case 'sky':
    case 'landscape':
      return ['scene'];
    case 'people':
      return ['scene', 'peopleParts', 'faceLandmarks'];
    case 'object':
      // A box: the subject model looks inside it. Brushed points: Segment Anything.
      return spec.box ? ['subject'] : ['objectEncoder', 'objectDecoder'];
  }
}

/**
 * Bump when anything changes what an analysis contains (a model revision, the analysis
 * image, the maths that turns model output into maps): cached analyses are then recomputed.
 */
export const ANALYSIS_VERSION = 1;
