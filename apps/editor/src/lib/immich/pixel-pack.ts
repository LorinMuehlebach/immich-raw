// Packs a decoded image's 16-bit pixels for the photo cache: the low bytes of all values, then the
// high bytes, gzipped. Linear camera RGB has noisy low bytes but high bytes that repeat a lot, so
// apart they compress 1.5–1.8× (as they are, 1.2–1.4×); docs/spike-results.md has the numbers.
// Runs in pixel-pack.worker.ts, off the page's thread.

const FORMAT = 'gzip';

/** Low bytes, then high bytes. */
export function shuffle(values: Uint16Array): Uint8Array {
  const n = values.length;
  const out = new Uint8Array(2 * n);
  for (let i = 0; i < n; i++) {
    const v = values[i]!;
    out[i] = v & 0xff;
    out[n + i] = v >> 8;
  }
  return out;
}

export function unshuffle(bytes: Uint8Array): Uint16Array {
  const n = bytes.length >> 1;
  const out = new Uint16Array(n);
  for (let i = 0; i < n; i++) out[i] = bytes[i]! | (bytes[n + i]! << 8);
  return out;
}

async function pipe(data: BufferSource, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(stream)).arrayBuffer());
}

export function packPixels(values: Uint16Array): Promise<Uint8Array> {
  return pipe(shuffle(values) as Uint8Array<ArrayBuffer>, new CompressionStream(FORMAT));
}

/** The pixels back; throws if the data is damaged or doesn't hold `count` values. */
export async function unpackPixels(packed: BufferSource, count: number): Promise<Uint16Array> {
  const bytes = await pipe(packed, new DecompressionStream(FORMAT));
  if (bytes.length !== 2 * count) throw new Error('The packed pixels have the wrong size.');
  return unshuffle(bytes);
}
