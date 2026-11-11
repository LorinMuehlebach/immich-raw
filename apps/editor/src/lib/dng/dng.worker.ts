// Encodes DNG tiles off the main thread. The main thread cuts the tiles out of the image
// (extractTile) and transfers them here, so no shared memory is needed: this also works on
// pages that aren't cross-origin isolated (plain HTTP). The encoded bytes go back the same way.
import { encodeCfaTileData, lossyTileRgba } from '@immich-raw/dng';

/** One tile: tileWidth x tileHeight pixels, 1 sample each (CFA) or 3 (linear RGB). */
export interface WorkerTile {
  index: number;
  data: Uint16Array;
}

export type WorkerJob =
  | { type: 'cfa'; tileWidth: number; tileHeight: number; components: number; tiles: WorkerTile[] }
  | { type: 'linear'; tileWidth: number; tileHeight: number; quality: number; tiles: WorkerTile[] };

export type WorkerReply = { type: 'tile'; index: number; bytes: Uint8Array } | { type: 'done' } | { type: 'error'; message: string };

type Encode = (data: ImageData, opts: Record<string, unknown>) => Promise<ArrayBuffer>;
let mozjpeg: Promise<Encode> | null = null;

const post = (msg: WorkerReply, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

self.onmessage = async (e: MessageEvent<WorkerJob>) => {
  const job = e.data;
  try {
    for (const tile of job.tiles) {
      let bytes: Uint8Array;
      if (job.type === 'cfa') {
        bytes = encodeCfaTileData(tile.data, job.tileWidth, job.tileHeight, job.components);
      } else {
        const px = lossyTileRgba({ data: tile.data, width: job.tileWidth, height: job.tileHeight }, 0);
        // MozJPEG with 4:4:4: the codes are linear-ish camera RGB, chroma subsampling would
        // smear colour edges for good.
        mozjpeg ??= import('@jsquash/jpeg/encode').then((m) => m.default as unknown as Encode);
        const encode = await mozjpeg;
        const buf = await encode(new ImageData(new Uint8ClampedArray(px.data), px.width, px.height), {
          quality: Math.round(job.quality * 100),
          baseline: true,
          progressive: false,
          optimize_coding: true,
          auto_subsample: false,
          chroma_subsample: 1,
        });
        bytes = new Uint8Array(buf);
      }
      post({ type: 'tile', index: tile.index, bytes }, [bytes.buffer]);
    }
    post({ type: 'done' });
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
