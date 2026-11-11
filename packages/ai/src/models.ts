// The models behind the AI masks. They are downloaded from their public hosts the first time
// a mask needs them and kept in the browser (IndexedDB); the photo itself never leaves it.
// Revisions are pinned: another model would give old edits different masks, so change them
// on purpose only. Licences are listed in THIRD-PARTY-NOTICES.md.
import type { AiSpec } from './types.ts';

export type ModelId = 'subject' | 'scene' | 'objectEncoder' | 'objectDecoder' | 'peopleParts' | 'faceLandmarks';

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
};

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
