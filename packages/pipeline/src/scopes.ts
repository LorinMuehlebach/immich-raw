// Scopes of the rendered preview: histogram, waveform, RGB parade and vectorscope.
//
// All of them read the same small RGBA8 copy of the fitted render (display values, sRGB-encoded)
// and skip the pixels outside the image (alpha < 128). Luma and chroma are BT.709 on the encoded
// values, as video scopes measure them.

export type ScopeKind = 'histogram' | 'waveform' | 'parade' | 'vectorscope';
export const SCOPE_KINDS: readonly ScopeKind[] = ['histogram', 'waveform', 'parade', 'vectorscope'];

/** A small RGBA8 copy of the render, row 0 at the top. */
export interface ScopeImage {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

export interface Histogram {
  r: Uint32Array;
  g: Uint32Array;
  b: Uint32Array;
  /** Pixels counted. */
  total: number;
}

export interface Waveform {
  kind: 'waveform' | 'parade';
  /** Columns per channel. */
  columns: number;
  levels: number;
  /** Luma for a waveform; red, green and blue for a parade. Each is columns × levels, row 0 = black. */
  channels: Uint32Array[];
  total: number;
}

export interface Vectorscope {
  kind: 'vectorscope';
  /** The plot is size × size bins: Cb from left to right, Cr from bottom to top, row 0 at the top. */
  size: number;
  bins: Uint32Array;
  total: number;
}

export type ScopeData = Waveform | Vectorscope;

/** Width of the render copy each scope reads. */
export const SCOPE_SAMPLE_WIDTH: Record<ScopeKind, number> = { histogram: 256, waveform: 512, parade: 512, vectorscope: 512 };
export const WAVEFORM_LEVELS = 128;
export const VECTORSCOPE_SIZE = 160;

const KR = 0.2126;
const KB = 0.0722;
const KG = 1 - KR - KB;

/** BT.709 luma of encoded values (any scale). */
export function luma(r: number, g: number, b: number): number {
  return KR * r + KG * g + KB * b;
}

/** BT.709 Cb and Cr (−0.5..0.5) of encoded values 0..1. */
export function chroma(r: number, g: number, b: number): [number, number] {
  const y = luma(r, g, b);
  return [(b - y) / (2 * (1 - KB)), (r - y) / (2 * (1 - KR))];
}

/** Encoded RGB (0..1, unclamped) with luma y and chroma (cb, cr). */
export function fromChroma(y: number, cb: number, cr: number): [number, number, number] {
  const r = y + 2 * (1 - KR) * cr;
  const b = y + 2 * (1 - KB) * cb;
  return [r, (y - KR * r - KB * b) / KG, b];
}

/** Bin (column, row) of a chroma point on a vectorscope of the given size. */
export function vectorscopeBin(cb: number, cr: number, size: number): [number, number] {
  // The epsilon keeps exact greys, whose chroma comes out as ±1e-17, in the centre bin.
  const clamp = (v: number) => Math.max(0, Math.min(size - 1, Math.floor(v + 1e-9)));
  return [clamp((cb + 0.5) * size), clamp((0.5 - cr) * size)];
}

/** The 75 % colour bar targets of a vectorscope graticule. */
export const VECTOR_TARGETS: readonly { label: string; cb: number; cr: number }[] = (
  [
    ['R', 0.75, 0, 0],
    ['Mg', 0.75, 0, 0.75],
    ['B', 0, 0, 0.75],
    ['Cy', 0, 0.75, 0.75],
    ['G', 0, 0.75, 0],
    ['Yl', 0.75, 0.75, 0],
  ] as const
).map(([label, r, g, b]) => {
  const [cb, cr] = chroma(r, g, b);
  return { label, cb, cr };
});

/** The skin tone line: degrees anticlockwise from the +Cb axis, as on broadcast vectorscopes. */
export const SKIN_TONE_ANGLE = 123;

export function histogramOf(img: ScopeImage): Histogram {
  const px = img.data;
  const h: Histogram = { r: new Uint32Array(256), g: new Uint32Array(256), b: new Uint32Array(256), total: 0 };
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3]! < 128) continue;
    h.r[px[i]!]!++;
    h.g[px[i + 1]!]!++;
    h.b[px[i + 2]!]!++;
    h.total++;
  }
  return h;
}

/**
 * Waveform: for each column of the image, how many of its pixels have each luma level. A parade
 * does the same for red, green and blue separately.
 */
export function waveformOf(img: ScopeImage, parade: boolean, columns = parade ? Math.floor(img.width / 3) : img.width, levels = WAVEFORM_LEVELS): Waveform {
  const { width, height, data } = img;
  const n = parade ? 3 : 1;
  const channels = Array.from({ length: n }, () => new Uint32Array(columns * levels));
  const colOf = new Int32Array(width);
  for (let x = 0; x < width; x++) colOf[x] = Math.min(columns - 1, Math.floor((x * columns) / width));
  const levelOf = (v: number) => Math.min(levels - 1, Math.floor((v * levels) / 256 + 1e-9));
  let total = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (data[i + 3]! < 128) continue;
      const col = colOf[x]!;
      const r = data[i]!;
      const g = data[i + 1]!;
      const b = data[i + 2]!;
      if (parade) {
        channels[0]![levelOf(r) * columns + col]!++;
        channels[1]![levelOf(g) * columns + col]!++;
        channels[2]![levelOf(b) * columns + col]!++;
      } else {
        channels[0]![levelOf(luma(r, g, b)) * columns + col]!++;
      }
      total++;
    }
  }
  return { kind: parade ? 'parade' : 'waveform', columns, levels, channels, total };
}

/** Vectorscope: how many pixels have each chroma (Cb, Cr), whatever their brightness. */
export function vectorscopeOf(img: ScopeImage, size = VECTORSCOPE_SIZE): Vectorscope {
  const px = img.data;
  const bins = new Uint32Array(size * size);
  let total = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3]! < 128) continue;
    const [cb, cr] = chroma(px[i]! / 255, px[i + 1]! / 255, px[i + 2]! / 255);
    const [x, y] = vectorscopeBin(cb, cr, size);
    bins[y * size + x]!++;
    total++;
  }
  return { kind: 'vectorscope', size, bins, total };
}

export function scopeOf(kind: Exclude<ScopeKind, 'histogram'>, img: ScopeImage): ScopeData {
  return kind === 'vectorscope' ? vectorscopeOf(img) : waveformOf(img, kind === 'parade');
}

/**
 * Brightness of each bin for drawing, 0..1: logarithmic, so that a few pixels still show, and
 * scaled to a high percentile of the filled bins, so that one flat area doesn't dim everything.
 */
export function scopeDensity(bins: Uint32Array, percentile = 0.99): Float32Array {
  const filled: number[] = [];
  for (const c of bins) if (c) filled.push(c);
  const out = new Float32Array(bins.length);
  if (!filled.length) return out;
  filled.sort((a, b) => a - b);
  const ref = Math.log1p(Math.max(1, filled[Math.min(filled.length - 1, Math.floor(filled.length * percentile))]!));
  for (let i = 0; i < bins.length; i++) {
    const c = bins[i]!;
    if (c) out[i] = Math.min(1, 0.15 + (0.85 * Math.log1p(c)) / ref);
  }
  return out;
}
