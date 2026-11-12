// 16-bit RGB PNG encoder (a canvas only encodes 8 bits): IHDR, the image data and IEND; the other
// chunks come from addPngMetadata. Rows are Paeth-filtered and streamed through the zlib
// compressor a batch at a time, so beyond the input only the compressed data is held.
import { chunk } from './png.ts';

const SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
/** Uncompressed bytes handed to the compressor at a time. */
const BATCH_BYTES = 1 << 20;
/** Compressed bytes per IDAT chunk. */
const IDAT_BYTES = 1 << 20;
/** Bytes per pixel: R, G and B, two bytes each. */
const BPP = 6;

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * A 16-bit RGB PNG of `img` (alpha dropped). `img.data` holds RGBA or RGB samples, 0-65535;
 * they are written big-endian, as PNG stores them.
 */
export async function encodePng16(img: { data: Uint16Array; width: number; height: number }): Promise<Uint8Array> {
  const { data, width, height } = img;
  if (!(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0)) throw new Error(`Bad image size ${width}x${height}`);
  const channels = data.length === width * height * 4 ? 4 : data.length === width * height * 3 ? 3 : 0;
  if (!channels) throw new Error(`Expected ${width * height * 4} (RGBA) or ${width * height * 3} (RGB) samples for ${width}x${height}, got ${data.length}`);

  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr.set([16, 2, 0, 0, 0], 8); // bit depth, colour type RGB, deflate, adaptive filtering, no interlace

  const stream = new CompressionStream('deflate');
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const idats: Uint8Array[] = [];
  let group: Uint8Array[] = [];
  let groupBytes = 0;
  const flush = () => {
    if (!groupBytes) return;
    const body = new Uint8Array(groupBytes);
    let o = 0;
    for (const g of group) {
      body.set(g, o);
      o += g.length;
    }
    idats.push(chunk('IDAT', body));
    group = [];
    groupBytes = 0;
  };
  const reading = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      group.push(value);
      groupBytes += value.length;
      if (groupBytes >= IDAT_BYTES) flush();
    }
  })();

  const rowLen = width * BPP;
  const rowsPerBatch = Math.max(1, Math.floor(BATCH_BYTES / (rowLen + 1)));
  let prev = new Uint8Array(rowLen);
  let cur = new Uint8Array(rowLen);
  for (let y0 = 0; y0 < height; y0 += rowsPerBatch) {
    const rows = Math.min(rowsPerBatch, height - y0);
    const batch = new Uint8Array(rows * (rowLen + 1));
    for (let r = 0; r < rows; r++) {
      let s = (y0 + r) * width * channels;
      for (let x = 0, i = 0; x < width; x++, s += channels) {
        for (let c = 0; c < 3; c++, i += 2) {
          const v = data[s + c]!;
          cur[i] = v >> 8;
          cur[i + 1] = v & 0xff;
        }
      }
      const at = r * (rowLen + 1);
      batch[at] = 4; // Paeth
      for (let i = 0; i < rowLen; i++) {
        const a = i >= BPP ? cur[i - BPP]! : 0;
        const c = i >= BPP ? prev[i - BPP]! : 0;
        batch[at + 1 + i] = cur[i]! - paeth(a, prev[i]!, c);
      }
      [prev, cur] = [cur, prev];
    }
    await writer.write(batch);
  }
  await writer.close();
  await reading;
  flush();

  const parts = [SIGNATURE, chunk('IHDR', ihdr), ...idats, chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
