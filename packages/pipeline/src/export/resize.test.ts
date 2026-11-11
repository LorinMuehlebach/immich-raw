import { describe, expect, it } from 'vitest';
import { fitLongEdge } from './resize.ts';

describe('fitLongEdge', () => {
  it('scales the long edge of a landscape image', () => {
    expect(fitLongEdge(6000, 4000, 3840)).toEqual({ width: 3840, height: 2560 });
  });

  it('scales the long edge of a portrait image', () => {
    expect(fitLongEdge(4000, 6000, 2048)).toEqual({ width: 1365, height: 2048 });
  });

  it('never upscales', () => {
    expect(fitLongEdge(1600, 1200, 3840)).toEqual({ width: 1600, height: 1200 });
  });

  it('keeps the size for null (full size)', () => {
    expect(fitLongEdge(8256, 5504, null)).toEqual({ width: 8256, height: 5504 });
  });

  it('rounds and keeps at least one pixel', () => {
    expect(fitLongEdge(6001, 3999, 2048)).toEqual({ width: 2048, height: 1365 });
    expect(fitLongEdge(10000, 1, 100)).toEqual({ width: 100, height: 1 });
  });
});
