// Renders RAWs other than the open one (for batch exports) on a WebGL context of its own, so
// the photo on screen keeps its renderer. Several photos can download and decode at once (each
// decode runs in a worker of its own and needs up to ~2.4 GB at 61 MP); the GPU renders them one
// at a time.
import { RawSession } from '@immich-raw/decoder';
import { estimateLateralCA } from '@immich-raw/lens';
import { Renderer, cameraInfo } from '@immich-raw/pipeline';
import type { Recipe } from '@immich-raw/recipe';
import type { AssetResponseDto } from '@immich/sdk';
import { prepareAiMasks } from '../ai.svelte.ts';
import { downloadOriginal } from '../immich/download.ts';
import { dngLensFor, lensQueryFor, loadLensDb, pickLensProfile } from '../lens-profile.ts';
import { oneAtATime } from './parallel.ts';

/** 'queued': decoded, waiting for another photo to finish rendering. */
export type RawStep = 'download' | 'decode' | 'queued' | 'render';

export class RawRenderer {
  private renderer: Renderer | null = null;
  private readonly gpu = oneAtATime();

  /** The photo with `recipe` applied at full resolution, as the editor would save it. */
  async render(asset: AssetResponseDto, recipe: Recipe, onStep: (step: RawStep, fraction?: number) => void): Promise<ImageData> {
    onStep('download', 0);
    const bytes = await downloadOriginal({ id: asset.id, checksum: asset.checksum }, (f) => onStep('download', f));
    onStep('decode');
    const session = await RawSession.open(bytes);
    const camera = cameraInfo(session.meta);
    const dngLens = dngLensFor(asset.originalFileName, bytes, camera);
    const full = await session.full();
    session.close();

    const query = lensQueryFor(session.meta, asset.exifInfo, camera);
    const { profile } = pickLensProfile(await loadLensDb(), query, dngLens, recipe.lens.lensId);
    const ca = recipe.lens.removeCA ? estimateLateralCA(full, { fullWidth: camera.fullWidth }).correction : null;
    onStep('queued');
    return this.gpu(async () => {
      const r = (this.renderer ??= new Renderer(document.createElement('canvas')));
      r.setSource(session.half, camera);
      r.setLens({ profile, ca });
      onStep('render', 0);
      // AI masks are computed from this photo (the models run once per photo and are cached).
      await prepareAiMasks(r, `${asset.id}:${asset.checksum}`, recipe);
      return r.exportImage(recipe, full, (done, total) => onStep('render', done / total));
    });
  }

  dispose(): void {
    this.renderer?.dispose();
    this.renderer = null;
  }
}
