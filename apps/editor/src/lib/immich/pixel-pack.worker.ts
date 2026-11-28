// Packs and unpacks the photo cache's pixels (pixel-pack.ts) off the page's thread: compressing a
// 61 MP photo's half-size image takes seconds, and unpacking it would hold up opening a photo.
import { packPixels, unpackPixels } from './pixel-pack.ts';

export type PackWork = { op: 'pack'; values: Uint16Array } | { op: 'unpack'; packed: ArrayBuffer; count: number };
export type PackJob = PackWork & { id: number };
export type PackReply = { id: number; ok: true; result: Uint8Array | Uint16Array } | { id: number; ok: false; message: string };

const post = (msg: PackReply, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

self.onmessage = async (e: MessageEvent<PackJob>) => {
  const job = e.data;
  try {
    const result = job.op === 'pack' ? await packPixels(job.values) : await unpackPixels(job.packed, job.count);
    post({ id: job.id, ok: true, result }, [result.buffer]);
  } catch (err) {
    post({ id: job.id, ok: false, message: err instanceof Error ? err.message : String(err) });
  }
};
