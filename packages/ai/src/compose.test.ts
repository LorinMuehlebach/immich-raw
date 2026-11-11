import { describe, expect, it } from 'vitest';
import { composeRaster, coarseMap, listPeople, personRegion, refine, type Analysis } from './compose.ts';
import { LANDMARKS } from './faces.ts';
import { invertAffine } from './image.ts';
import type { Affine, PeopleMaps, RgbaImage } from './types.ts';

const ID: Affine = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** An image whose left half is dark and right half bright. */
function halves(w: number, h: number): RgbaImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.fill(x < w / 2 ? 30 : 220, (y * w + x) * 4, (y * w + x) * 4 + 3);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  return { width: w, height: h, data };
}

const bytes = (w: number, h: number, f: (x: number, y: number) => number) => {
  const d = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d[y * w + x] = Math.round(f(x / w, y / h) * 255);
  return d;
};

function faceAt(cx: number, cy: number, r: number): Float32Array {
  const lm = new Float32Array(LANDMARKS * 2);
  for (let i = 0; i < LANDMARKS; i++) {
    const a = (2 * Math.PI * i) / LANDMARKS;
    lm[2 * i] = cx + r * Math.cos(a);
    lm[2 * i + 1] = cy + r * Math.sin(a);
  }
  return lm;
}

function people(): PeopleMaps {
  const w = 40;
  const h = 20;
  // One group spanning x 0.1..0.9 with two faces, at x 0.25 and 0.75.
  const inGroup = (x: number, y: number) => (x > 0.1 && x < 0.9 && y > 0.2 ? 1 : 0);
  return {
    width: w,
    height: h,
    hair: new Uint8Array(w * h),
    bodySkin: new Uint8Array(w * h),
    faceSkin: new Uint8Array(w * h),
    clothes: bytes(w, h, (x, y) => (inGroup(x, y) && y > 0.6 ? 1 : 0)),
    anyone: bytes(w, h, inGroup),
    labels: bytes(w, h, inGroup).map((v) => (v ? 1 : 0)),
    groups: [[0.1, 0.2, 0.9, 1]],
    faces: [faceAt(0.25, 0.35, 0.05), faceAt(0.75, 0.35, 0.05)],
  };
}

describe('compose', () => {
  const image = halves(40, 20);

  it('selects the subject, or everything else as the background', () => {
    const a: Analysis = { image, subject: { width: 2, height: 1, data: new Uint8Array([0, 255]) } };
    expect(coarseMap({ target: 'subject' }, a)[39]).toBe(1);
    expect(coarseMap({ target: 'background' }, a)[0]).toBe(1);
  });

  it('adds up landscape categories and finds snow by colour', () => {
    const maps = { sky: bytes(4, 2, (_, y) => (y < 0.5 ? 1 : 0)), water: bytes(4, 2, (x, y) => (y >= 0.5 && x < 0.5 ? 1 : 0)), naturalGround: bytes(4, 2, (x, y) => (y >= 0.5 && x >= 0.5 ? 1 : 0)) };
    const a: Analysis = { image, scene: { width: 4, height: 2, maps } };
    const m = coarseMap({ target: 'landscape', classes: ['sky', 'water'] }, a);
    expect([m[5], m[39 * 0 + 15 * 40 + 5], m[15 * 40 + 35]]).toEqual([1, 1, 0]);
    // Bright neutral ground (the right half) is snow; the dark water isn't, nor is the sky.
    const snow = coarseMap({ target: 'landscape', classes: ['snow'] }, a);
    expect(snow[18 * 40 + 35]).toBeGreaterThan(0.9);
    expect(snow[18 * 40 + 5]).toBe(0);
    expect(snow[2 * 40 + 35]).toBe(0);
  });

  it('splits a group of people between their faces', () => {
    const p = people();
    const left = personRegion(p, [0.25, 0.6], 40, 20)!;
    expect(left.faces).toEqual([p.faces[0]]);
    expect(left.region[15 * 40 + 8]).toBe(1);
    expect(left.region[15 * 40 + 32]).toBe(0);
    // Just above the group still picks it; far away picks nobody.
    expect(personRegion(p, [0.5, 0.15], 40, 20)).not.toBeNull();
    expect(personRegion(p, [0.5, 0.05], 40, 20)).toBeNull();
    const a: Analysis = { image, people: p };
    const clothes = coarseMap({ target: 'people', parts: ['clothes'], person: [0.75, 0.5] }, a);
    expect([clothes[18 * 40 + 8], clothes[18 * 40 + 32]]).toEqual([0, 1]);
    expect(listPeople(p).map((x) => Math.round(x.at[0] * 100) / 100)).toEqual([0.25, 0.75]);
  });

  it('snaps edges to the photo and reports when nothing was found', () => {
    // A soft step (x 18..22) gets sharper at the photo's own edge (x 20).
    const coarse = new Float32Array(40 * 20).map((_, i) => Math.min(1, Math.max(0, ((i % 40) + 0.5 - 18) / 4)));
    const g = new Float32Array(40 * 20).map((_, i) => ((i % 40) < 20 ? 0.12 : 0.86));
    const fine = refine(coarse, g, 40, 20, { target: 'subject' });
    expect(coarse[10 * 40 + 19]! - fine[10 * 40 + 19]!).toBeGreaterThan(0.1);
    expect(fine[10 * 40 + 20]! - coarse[10 * 40 + 20]!).toBeGreaterThan(0.05);
    const none = composeRaster({ target: 'sky' }, { image, scene: { width: 1, height: 1, maps: {} } }, { width: 8, height: 4, sToT: invertAffine(ID) });
    expect(none.empty).toBe(true);
    const some = composeRaster({ target: 'subject' }, { image, subject: { width: 2, height: 1, data: new Uint8Array([0, 255]) } }, { width: 8, height: 4, sToT: ID });
    expect(some.empty).toBe(false);
    expect([some.data[0], some.data[7]]).toEqual([0, 255]);
  });
});
