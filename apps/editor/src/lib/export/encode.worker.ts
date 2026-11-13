// Encodes one WebP, AVIF or JPEG XL off the main thread, so the page stays responsive during the
// seconds a full-size encode takes. The pixels are transferred in and the file transferred back;
// no shared memory is needed, so this also works on plain HTTP.
import { encodeWithCodec, type CodecJob } from '@immich-raw/pipeline/codecs';

export type EncodeReply = { ok: true; bytes: Uint8Array } | { ok: false; message: string };

const post = (msg: EncodeReply, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

self.onmessage = async (e: MessageEvent<CodecJob>) => {
  try {
    const bytes = await encodeWithCodec(e.data);
    post({ ok: true, bytes }, [bytes.buffer]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The WebAssembly encoders abort when they can't grow their memory.
    post({ ok: false, message: /OOM|out of memory|Aborted|Cannot enlarge memory/i.test(message) ? `ran out of memory (${message}); choose a smaller size` : message });
  }
};
