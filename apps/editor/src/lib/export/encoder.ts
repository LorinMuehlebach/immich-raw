// Runs WebP, AVIF and JPEG XL encodes in a worker each (encode.worker.ts). A batch export works
// on several photos at once; AVIF and JPEG XL take far more memory and time than WebP, so only
// one of each encodes at a time, and two WebPs. Each worker ends with its encode, which gives
// the encoder's memory back.
import type { CodecFormat, CodecJob } from '@immich-raw/pipeline/codecs';
import type { EncodeReply } from './encode.worker.ts';
import { atMost } from './parallel.ts';

const LABEL: Record<CodecFormat, string> = { webp: 'WebP', avif: 'AVIF', jxl: 'JPEG XL' };
const gates: Record<CodecFormat, <T>(task: () => Promise<T>) => Promise<T>> = { webp: atMost(2), avif: atMost(1), jxl: atMost(1) };

/** The encoded file. Transfers `job.data`: the pixels can't be used afterwards. */
export function encodeOffThread(job: CodecJob): Promise<Uint8Array> {
  return gates[job.format](
    () =>
      new Promise<Uint8Array>((resolve, reject) => {
        const worker = new Worker(new URL('./encode.worker.ts', import.meta.url), { type: 'module' });
        const fail = (message: string) => {
          worker.terminate();
          reject(new Error(`Encoding the ${LABEL[job.format]} failed: ${message}`));
        };
        worker.onmessage = (e: MessageEvent<EncodeReply>) => {
          const reply = e.data;
          if (!reply.ok) return fail(reply.message);
          worker.terminate();
          resolve(reply.bytes);
        };
        worker.onerror = (e) => fail(e.message || 'the encoder could not start');
        worker.postMessage(job, [job.data.buffer]);
      }),
  );
}
