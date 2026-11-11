// AI masks, editor side: the worker (shared by the editor and the album export), asking before
// models are downloaded, and turning a recipe's AI components into maps for the renderer.
import {
  AiClient,
  ANALYSIS_IMAGE_VERSION,
  MODELS,
  analysisRecipe,
  applyAffine,
  invertAffine,
  modelsFor,
  specFor,
  type Affine,
  type AiSpec,
} from '@immich-raw/ai';
import type { AiMaskMap, Renderer } from '@immich-raw/pipeline';
import { aiComponents, type AiComponent, type Recipe } from '@immich-raw/recipe';

const BASE = import.meta.env.BASE_URL;

export const aiClient = new AiClient({
  createWorker: () => new Worker(new URL('./ai.worker.ts', import.meta.url), { type: 'module' }),
  ortBase: `${BASE}ort/`,
  mediapipeBase: `${BASE}mediapipe/`,
});

/** Size of all models together (shown when asking). */
export const ALL_MODEL_BYTES = Object.values(MODELS).reduce((n, m) => n + m.bytes, 0);
/** Longer side of an AI map (like a brush map). */
const RASTER_SIDE = 2048;
/** Longer side of the image the models look at. */
const ANALYSIS_SIDE = 2048;
const CONSENT_KEY = 'raw-editor.aiDownloads';
export const DECLINED = 'The AI models were not downloaded.';

/** Asks once before AI models are downloaded (the photo itself never leaves the browser). */
class AiConsent {
  /** Set while the question is shown: bytes to download now. */
  asking = $state<{ bytes: number } | null>(null);
  private waiting: ((ok: boolean) => void)[] = [];
  private allowed = (() => {
    try {
      return localStorage.getItem(CONSENT_KEY) === 'yes';
    } catch {
      return false;
    }
  })();
  private declined = false;

  /** Resolves when the models `spec` needs may be downloaded (or are there); throws if not. */
  async permit(spec: Pick<AiSpec, 'target' | 'box'>): Promise<void> {
    if (this.allowed) return;
    const bytes = await aiClient.missingBytes(modelsFor(spec));
    if (!bytes) return;
    if (this.declined) throw new Error(DECLINED);
    const ok = await new Promise<boolean>((resolve) => {
      this.waiting.push(resolve);
      this.asking = { bytes: Math.max(this.asking?.bytes ?? 0, bytes) };
    });
    if (!ok) throw new Error(DECLINED);
  }

  answer(ok: boolean): void {
    if (ok) {
      this.allowed = true;
      try {
        localStorage.setItem(CONSENT_KEY, 'yes');
      } catch {
        // Not remembered: asked again next time.
      }
    } else this.declined = true;
    this.asking = null;
    for (const w of this.waiting.splice(0)) w(ok);
  }

  /** After "Not now": allow asking again (the user clicked Retry). */
  again(): void {
    this.declined = false;
  }
}

export const aiConsent = new AiConsent();

/** The image the models look at for one photo, and how it maps to the decoded image. */
export interface AiPhoto {
  key: string;
  image: ImageData;
  /** Analysis image (0..1) -> decoded image (0..1), and back. */
  tToS: Affine;
  sToT: Affine;
  /** Mask frame scale (see the renderer's maskFrame). */
  frame: [number, number];
}

/** Renders the analysis image for the photo loaded in `renderer`. key: asset id and checksum. */
export function preparePhoto(renderer: Renderer, key: string): AiPhoto {
  const { image, tToS } = renderer.renderSmall(analysisRecipe(), ANALYSIS_SIDE);
  return { key: `${key}:a${ANALYSIS_IMAGE_VERSION}`, image, tToS: tToS as Affine, sToT: invertAffine(tToS as Affine), frame: renderer.maskFrame() };
}

/** What the worker computes for component `c` of `recipe` (its points go through the lens corrections). */
export function componentSpec(c: AiComponent, photo: AiPhoto, renderer: Renderer, recipe: Recipe): AiSpec {
  return specFor(c, (mx, my) => {
    const s = renderer.maskToSource(mx, my, recipe);
    return applyAffine(photo.sToT, s[0], s[1]);
  });
}

/** Analysis image point (0..1) -> mask frame (close enough for picking a person). */
export function imageToMask(photo: AiPhoto, at: [number, number]): { x: number; y: number } {
  const s = applyAffine(photo.tToS, at[0], at[1]);
  return { x: Math.round(s[0] * photo.frame[0] * 1e5) / 1e5, y: Math.round(s[1] * photo.frame[1] * 1e5) / 1e5 };
}

export function rasterOut(photo: AiPhoto): { width: number; height: number; sToT: Affine } {
  return { width: Math.max(1, Math.round(photo.frame[0] * RASTER_SIDE)), height: Math.max(1, Math.round(photo.frame[1] * RASTER_SIDE)), sToT: photo.sToT };
}

/**
 * Computes every AI map of `recipe` for the photo in `renderer` and hands them to it
 * (the album export, which renders photos that aren't open).
 */
export async function prepareAiMasks(renderer: Renderer, key: string, recipe: Recipe): Promise<void> {
  const comps = aiComponents(recipe.masks);
  const maps = new Map<string, AiMaskMap>();
  if (comps.length) {
    const photo = preparePhoto(renderer, key);
    aiClient.setPhoto(photo.key, photo.image);
    for (const c of comps) {
      const spec = componentSpec(c, photo, renderer, recipe);
      await aiConsent.permit(spec);
      const r = await aiClient.raster(photo.key, spec, rasterOut(photo));
      maps.set(c.id, { width: r.width, height: r.height, data: r.data, version: `${photo.key}:${c.id}` });
    }
  }
  renderer.setAiMasks(maps);
}
