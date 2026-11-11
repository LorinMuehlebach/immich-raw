// Encodes DNG tiles off the main thread. The image is shared (SharedArrayBuffer), each
// worker encodes the tiles it is asked for and sends the bytes back.
import { encodeCfaTile, lossyTileRgba } from '@immich-raw/dng';

export type WorkerJob =
  | { type: 'cfa'; data: Uint16Array; width: number; height: number; patternWidth: number; tiles: number[] }
  | { type: 'linear'; data: Uint16Array; width: number; height: number; quality: number; tiles: number[] };

export type WorkerReply = { type: 'tile'; index: number; bytes: Uint8Array } | { type: 'done' } | { type: 'error'; message: string };

type Encode = (data: ImageData, opts: Record<string, unknown>) => Promise<ArrayBuffer>;
let mozjpeg: Promise<Encode> | null = null;

const post = (msg: WorkerReply, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

self.onmessage = async (e: MessageEvent<WorkerJob>) => {
  const job = e.data;
  try {
    for (const index of job.tiles) {
      let bytes: Uint8Array;
      if (job.type === 'cfa') {
        bytes = encodeCfaTile({ data: job.data, width: job.width, height: job.height, patternWidth: job.patternWidth }, index);
      } else {
        const px = lossyTileRgba({ data: job.data, width: job.width, height: job.height }, index);
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
      post({ type: 'tile', index, bytes }, [bytes.buffer]);
    }
    post({ type: 'done' });
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
