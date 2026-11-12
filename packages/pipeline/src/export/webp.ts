// Adds metadata to a WebP from an encoder (which writes none): the extended format's VP8X chunk
// with ICCP, EXIF and XMP chunks around the image data, as the WebP container spec orders them.
// Image chunks (VP8, VP8L, ALPH, ANIM, ANMF) and unknown chunks are copied byte for byte.

export interface WebpMetadata {
  /** ICC profile, written as ICCP. */
  icc?: Uint8Array;
  /** TIFF block from buildTiff ("II*\0..."), written as EXIF. */
  exif?: Uint8Array;
  /** XMP packet, written as "XMP ". */
  xmp?: string;
}

/** The largest width and height a WebP can have. */
export const WEBP_MAX_SIDE = 16383;

const FLAG_ICC = 0x20;
const FLAG_ALPHA = 0x10;
const FLAG_EXIF = 0x08;
const FLAG_XMP = 0x04;
const FLAG_ANIMATION = 0x02;

interface Chunk {
  fourcc: string;
  /** Payload, without header and padding. */
  data: Uint8Array;
}

const fourcc = (b: Uint8Array, at: number) => String.fromCharCode(b[at]!, b[at + 1]!, b[at + 2]!, b[at + 3]!);

function readChunks(webp: Uint8Array): Chunk[] {
  if (webp.length < 12 || fourcc(webp, 0) !== 'RIFF' || fourcc(webp, 8) !== 'WEBP') throw new Error('Not a WebP (bad RIFF header).');
  const dv = new DataView(webp.buffer, webp.byteOffset, webp.byteLength);
  const end = Math.min(webp.length, 8 + dv.getUint32(4, true));
  const chunks: Chunk[] = [];
  let p = 12;
  while (p + 8 <= end) {
    const size = dv.getUint32(p + 4, true);
    if (p + 8 + size > end) throw new Error(`Corrupt WebP: chunk at ${p} runs past the end.`);
    chunks.push({ fourcc: fourcc(webp, p), data: webp.subarray(p + 8, p + 8 + size) });
    p += 8 + size + (size & 1);
  }
  return chunks;
}

/** Canvas size and alpha from the image chunks, for VP8X. */
function canvasOf(chunks: Chunk[]): { width: number; height: number; flags: number } {
  const vp8x = chunks.find((c) => c.fourcc === 'VP8X');
  if (vp8x && vp8x.data.length >= 10) {
    const d = vp8x.data;
    return {
      width: 1 + (d[4]! | (d[5]! << 8) | (d[6]! << 16)),
      height: 1 + (d[7]! | (d[8]! << 8) | (d[9]! << 16)),
      flags: d[0]! & (FLAG_ALPHA | FLAG_ANIMATION),
    };
  }
  const alpha = chunks.some((c) => c.fourcc === 'ALPH') ? FLAG_ALPHA : 0;
  const vp8 = chunks.find((c) => c.fourcc === 'VP8 ');
  if (vp8 && vp8.data.length >= 10) {
    const d = vp8.data;
    if (d[3] !== 0x9d || d[4] !== 0x01 || d[5] !== 0x2a) throw new Error('Corrupt WebP: VP8 key frame start code missing.');
    return { width: (d[6]! | (d[7]! << 8)) & 0x3fff, height: (d[8]! | (d[9]! << 8)) & 0x3fff, flags: alpha };
  }
  const vp8l = chunks.find((c) => c.fourcc === 'VP8L');
  if (vp8l && vp8l.data.length >= 5) {
    const d = vp8l.data;
    if (d[0] !== 0x2f) throw new Error('Corrupt WebP: VP8L signature missing.');
    const bits = d[1]! | (d[2]! << 8) | (d[3]! << 16) | (d[4]! << 24);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff), flags: (bits >>> 28) & 1 ? FLAG_ALPHA : alpha };
  }
  throw new Error('Corrupt WebP: no image data.');
}

const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

/**
 * Returns a new WebP in the extended format with the given ICC profile, EXIF and XMP; existing
 * VP8X, ICCP, EXIF and XMP chunks are replaced. Without any metadata the input is returned.
 */
export function addWebpMetadata(webp: Uint8Array, m: WebpMetadata): Uint8Array {
  const chunks = readChunks(webp);
  const xmp = m.xmp ? new TextEncoder().encode(m.xmp) : undefined;
  if (!m.icc?.length && !m.exif?.length && !xmp?.length) return webp;

  const canvas = canvasOf(chunks);
  const flags = canvas.flags | (m.icc?.length ? FLAG_ICC : 0) | (m.exif?.length ? FLAG_EXIF : 0) | (xmp?.length ? FLAG_XMP : 0);
  const vp8x = new Uint8Array(10);
  vp8x[0] = flags;
  const w = canvas.width - 1;
  const h = canvas.height - 1;
  vp8x.set([w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff, h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff], 4);

  const replaced = new Set(['VP8X', 'ICCP', 'EXIF', 'XMP ']);
  const kept = chunks.filter((c) => !replaced.has(c.fourcc));
  const out: Chunk[] = [{ fourcc: 'VP8X', data: vp8x }];
  if (m.icc?.length) out.push({ fourcc: 'ICCP', data: m.icc });
  out.push(...kept);
  if (m.exif?.length) out.push({ fourcc: 'EXIF', data: m.exif });
  if (xmp?.length) out.push({ fourcc: 'XMP ', data: xmp });

  const body = out.reduce((s, c) => s + 8 + c.data.length + (c.data.length & 1), 0);
  const result = new Uint8Array(12 + body);
  const dv = new DataView(result.buffer);
  result.set(ascii('RIFF'), 0);
  dv.setUint32(4, 4 + body, true);
  result.set(ascii('WEBP'), 8);
  let p = 12;
  for (const c of out) {
    result.set(ascii(c.fourcc), p);
    dv.setUint32(p + 4, c.data.length, true);
    result.set(c.data, p + 8);
    p += 8 + c.data.length + (c.data.length & 1);
  }
  return result;
}
