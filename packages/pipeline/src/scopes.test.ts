import { describe, expect, it } from 'vitest';
import {
  SKIN_TONE_ANGLE,
  VECTOR_TARGETS,
  chroma,
  fromChroma,
  histogramOf,
  scopeDensity,
  scopeOf,
  vectorscopeBin,
  vectorscopeOf,
  waveformOf,
  type ScopeImage,
} from './scopes.ts';

/** An RGBA8 image from a function of (x, y); alpha 255 unless the function gives a fourth value. */
function image(width: number, height: number, f: (x: number, y: number) => number[]): ScopeImage {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a = 255] = f(x, y);
      data.set([r!, g!, b!, a], (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

/** The level that holds a column's pixels (all of them in one level). */
function levelOf(bins: Uint32Array, columns: number, levels: number, col: number): number {
  for (let l = 0; l < levels; l++) if (bins[l * columns + col]) return l;
  return -1;
}

describe('histogram', () => {
  it('counts each channel and skips pixels outside the image', () => {
    const h = histogramOf(image(4, 1, (x) => (x < 3 ? [10, 20, 30] : [0, 0, 0, 0])));
    expect(h.total).toBe(3);
    expect(h.r[10]).toBe(3);
    expect(h.g[20]).toBe(3);
    expect(h.b[30]).toBe(3);
    expect(h.r[0]).toBe(0);
  });
});

describe('waveform', () => {
  it('a grey ramp from left to right gives the diagonal', () => {
    const w = waveformOf(image(256, 8, (x) => [x, x, x]), false, 64, 64);
    expect(w.total).toBe(256 * 8);
    for (let c = 0; c < 64; c++) {
      const l = levelOf(w.channels[0]!, 64, 64, c);
      expect(l).toBe(c);
      // All eight rows of the four image columns in this column land in that one level.
      expect(w.channels[0]![l * 64 + c]).toBe(32);
    }
  });

  it('uses BT.709 luma', () => {
    const w = waveformOf(image(2, 1, (x) => (x === 0 ? [255, 0, 0] : [0, 255, 0])), false, 2, 256);
    expect(levelOf(w.channels[0]!, 2, 256, 0)).toBe(Math.floor(0.2126 * 255));
    expect(levelOf(w.channels[0]!, 2, 256, 1)).toBe(Math.floor(0.7152 * 255));
  });

  it('the parade has one panel per channel', () => {
    const w = waveformOf(image(30, 2, () => [255, 128, 0]), true, 10, 16);
    expect(w.kind).toBe('parade');
    expect(w.channels).toHaveLength(3);
    expect(levelOf(w.channels[0]!, 10, 16, 5)).toBe(15);
    expect(levelOf(w.channels[1]!, 10, 16, 5)).toBe(8);
    expect(levelOf(w.channels[2]!, 10, 16, 5)).toBe(0);
  });

  it('skips pixels outside the image', () => {
    const w = waveformOf(image(4, 4, (x) => (x < 2 ? [100, 100, 100] : [255, 255, 255, 0])), false);
    expect(w.total).toBe(8);
    expect(levelOf(w.channels[0]!, 4, w.levels, 3)).toBe(-1);
  });
});

describe('vectorscope', () => {
  it('neutral greys sit in the centre', () => {
    const v = vectorscopeOf(image(16, 1, (x) => [x * 16, x * 16, x * 16]), 160);
    expect(v.bins[80 * 160 + 80]).toBe(16);
  });

  it('75 % red lands on the red target', () => {
    const v = vectorscopeOf(image(4, 4, () => [191, 0, 0]), 160);
    const red = VECTOR_TARGETS.find((t) => t.label === 'R')!;
    const [x, y] = vectorscopeBin(red.cb, red.cr, 160);
    expect(v.bins[y * 160 + x]).toBe(16);
  });

  it('BT.709 angles: red at about 103°, upper left; blue at about 355°, right', () => {
    const angle = (r: number, g: number, b: number) => {
      const [cb, cr] = chroma(r, g, b);
      return ((Math.atan2(cr, cb) * 180) / Math.PI + 360) % 360;
    };
    expect(angle(1, 0, 0)).toBeCloseTo(102.9, 0);
    expect(angle(0, 0, 1)).toBeCloseTo(354.8, 0);
    expect(SKIN_TONE_ANGLE).toBeGreaterThan(angle(1, 0, 0));
    expect(SKIN_TONE_ANGLE).toBeLessThan(angle(1, 1, 0));
  });

  it('fromChroma inverts chroma', () => {
    const [cb, cr] = chroma(0.8, 0.4, 0.2);
    const [r, g, b] = fromChroma(0.2126 * 0.8 + 0.7152 * 0.4 + 0.0722 * 0.2, cb, cr);
    expect(r).toBeCloseTo(0.8, 6);
    expect(g).toBeCloseTo(0.4, 6);
    expect(b).toBeCloseTo(0.2, 6);
  });
});

describe('scopeOf and density', () => {
  it('picks the scope by kind', () => {
    const img = image(12, 2, () => [50, 60, 70]);
    expect(scopeOf('waveform', img).kind).toBe('waveform');
    expect(scopeOf('parade', img).kind).toBe('parade');
    expect(scopeOf('vectorscope', img).kind).toBe('vectorscope');
  });

  it('density: empty bins stay dark, filled ones show, the reference is full', () => {
    const d = scopeDensity(new Uint32Array([0, 1, 10, 100, 1000]), 0.5);
    expect(d[0]).toBe(0);
    expect(d[1]).toBeGreaterThan(0.15);
    expect(d[2]).toBeLessThan(d[3]!);
    expect(d[3]).toBe(1);
    expect(d[4]).toBe(1);
  });
});
