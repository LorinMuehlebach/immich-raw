import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TIMES,
  cameraKey,
  estimateDecodeMs,
  estimateDownloadMs,
  estimateFullMs,
  estimateShowMs,
  normalizeOpenTimes,
  recordFull,
  recordOpen,
  type OpenTimes,
} from './open-times.ts';

const empty = (): OpenTimes => ({ cameras: {} });
const MB = 1e6;

describe('open times', () => {
  it('names a camera by make, model and file type', () => {
    expect(cameraKey('SONY', 'ILCE-7RM5', 'DSC01234.ARW')).toBe('sony ilce-7rm5 arw');
    expect(cameraKey(null, undefined, 'x.CR3')).toBe('cr3');
  });

  it('starts from the defaults', () => {
    const t = empty();
    expect(estimateDownloadMs(t, 60 * MB)).toBe((60 * MB) / DEFAULT_TIMES.downloadRate);
    expect(estimateDecodeMs(t, 'sony ilce-7rm5 arw', 60 * MB)).toBe(60 * DEFAULT_TIMES.decodeMsPerMB);
    expect(estimateShowMs(t, 'x')).toBe(DEFAULT_TIMES.showMs);
  });

  it("uses the camera's own decode time once it has one", () => {
    let t = recordOpen(empty(), { camera: 'fuji x-t5 raf', bytes: 50 * MB, decodeMs: 2500, showMs: 250 }, 1);
    expect(estimateDecodeMs(t, 'fuji x-t5 raf', 50 * MB)).toBe(2500);
    expect(estimateShowMs(t, 'fuji x-t5 raf')).toBe(250);
    // Another camera: from the average per MB.
    expect(estimateDecodeMs(t, 'canon eos r5 cr3', 25 * MB)).toBe(1250);
    // A moving average: the newest open counts 40 %.
    t = recordOpen(t, { camera: 'fuji x-t5 raf', bytes: 50 * MB, decodeMs: 2000 }, 2);
    expect(estimateDecodeMs(t, 'fuji x-t5 raf', 50 * MB)).toBeCloseTo(2300);
  });

  it('learns the download speed from big downloads only', () => {
    let t = recordOpen(empty(), { camera: 'c', bytes: 1 * MB, download: { bytes: 1 * MB, ms: 1000 } });
    expect(t.downloadRate).toBeUndefined();
    t = recordOpen(t, { camera: 'c', bytes: 60 * MB, download: { bytes: 60 * MB, ms: 600 } });
    expect(estimateDownloadMs(t, 60 * MB)).toBeCloseTo(600);
  });

  it('learns the full-resolution decode per camera', () => {
    const t = recordFull(empty(), 'sony ilce-7rm5 arw', 60 * MB, 6000);
    expect(estimateFullMs(t, 'sony ilce-7rm5 arw', 60 * MB)).toBe(6000);
    expect(estimateFullMs(t, 'other', 30 * MB)).toBe(3000);
    expect(recordFull(t, 'x', 60 * MB, NaN)).toBe(t);
  });

  it('keeps the cameras used last', () => {
    let t = empty();
    for (let i = 0; i < 45; i++) t = recordOpen(t, { camera: `cam ${i}`, bytes: 10 * MB, decodeMs: 1000 }, i);
    expect(Object.keys(t.cameras)).toHaveLength(40);
    expect(t.cameras['cam 0']).toBeUndefined();
    expect(t.cameras['cam 44']).toBeDefined();
  });

  it('keeps only sensible numbers from storage', () => {
    const t = normalizeOpenTimes({ downloadRate: -1, showMs: 'x', decodeMsPerMB: 25, cameras: { a: { decodeMs: 900, fullMs: null, used: 5 }, b: 3 } });
    expect(t).toEqual({ decodeMsPerMB: 25, cameras: { a: { decodeMs: 900, used: 5 } } });
    expect(normalizeOpenTimes(null)).toEqual({ cameras: {} });
  });
});
