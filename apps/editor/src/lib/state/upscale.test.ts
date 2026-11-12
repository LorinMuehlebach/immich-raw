import { describe, expect, it } from 'vitest';
import { upscaleStackIds, upscaledFilename } from '../immich/save-upscaled.ts';
import { CPU_LIMIT_S, checkUpscale, estimateSeconds, formatDuration, maxOutputPixels, priorRate, upscaledDownloadName } from './upscale.ts';

const GPU = { gpu: true, threads: 1 };
const CPU1 = { gpu: false, threads: 1 };

describe('maxOutputPixels', () => {
  it('allows less on phones and small-memory devices', () => {
    expect(maxOutputPixels({ compact: false })).toBe(200e6);
    expect(maxOutputPixels({ compact: false, deviceMemory: 8 })).toBe(200e6);
    expect(maxOutputPixels({ compact: false, deviceMemory: 4 })).toBe(50e6);
    expect(maxOutputPixels({ compact: true, deviceMemory: 16 })).toBe(50e6);
  });
});

describe('estimateSeconds', () => {
  it('counts the overlapping tiles the model really sees', () => {
    // Sharp on a GPU: 512 px tiles, 464 px each new. 6000 x 4000 -> 13 x 9 tiles.
    expect(estimateSeconds(6000, 4000, 'sharp', 2, true, 6)).toBeCloseTo((13 * 9 * 512 * 512 * 6) / 1e6);
    // Natural 4x: fixed 256 px tiles with 192 px each new.
    expect(estimateSeconds(1000, 1000, 'natural', 4, true, 30)).toBeCloseTo((6 * 6 * 256 * 256 * 30) / 1e6);
  });

  it('puts a 24 MP photo at a few minutes on a GPU and half an hour on one CPU thread', () => {
    const gpu = estimateSeconds(6000, 4000, 'sharp', 2, true, priorRate('sharp', GPU));
    const cpu = estimateSeconds(6000, 4000, 'sharp', 2, false, priorRate('sharp', CPU1));
    expect(gpu / 60).toBeGreaterThan(2);
    expect(gpu / 60).toBeLessThan(4);
    expect(cpu / 60).toBeGreaterThan(30);
  });
});

describe('checkUpscale', () => {
  const base = { style: 'sharp' as const, rate: 6, maxPixels: 120e6 };

  it('allows 2x of a 24 MP photo on a GPU', () => {
    const c = checkUpscale({ ...base, width: 6000, height: 4000, scale: 2, backend: GPU });
    expect(c).toMatchObject({ width: 12000, height: 8000, blocked: null });
  });

  it('refuses a result larger than the browser can take, and says how to fix it', () => {
    const c = checkUpscale({ ...base, width: 6000, height: 4000, scale: 4, backend: GPU });
    expect(c.blocked).toBe('4× would make 384 MP; this browser can take up to 120 MP. Crop the photo first.');
  });

  it('refuses whole photos without a GPU, but not small crops', () => {
    const rate = priorRate('sharp', CPU1);
    const full = checkUpscale({ ...base, rate, width: 6000, height: 4000, scale: 2, backend: CPU1 });
    expect(full.blocked).toMatch(/^Without a GPU this would take about \d+ min\. Full photos need WebGPU/);
    const crop = checkUpscale({ ...base, rate, width: 1500, height: 1000, scale: 2, backend: CPU1 });
    expect(crop.blocked).toBeNull();
    expect(crop.seconds).toBeLessThan(CPU_LIMIT_S);
  });

  it('checks only the size until it is known where the model runs', () => {
    const c = checkUpscale({ ...base, rate: 80, width: 6000, height: 4000, scale: 2, backend: null });
    expect(c).toMatchObject({ seconds: null, blocked: null });
    expect(checkUpscale({ ...base, width: 6000, height: 4000, scale: 4, backend: null }).blocked).toMatch(/^4× would make 384 MP/);
  });
});

describe('formatDuration', () => {
  it('rounds to minutes', () => {
    expect(formatDuration(20)).toBe('under a minute');
    expect(formatDuration(150)).toBe('about 3 min');
    expect(formatDuration(3600)).toBe('about 1 h');
    expect(formatDuration(4800)).toBe('about 1 h 20 min');
  });
});

describe('file names', () => {
  it('names the download after the RAW', () => {
    expect(upscaledDownloadName('DSC01234.ARW', 2, 'jpeg')).toBe('DSC01234-upscaled-2x.jpg');
    expect(upscaledDownloadName('IMG.1.CR3', 4, 'tiff')).toBe('IMG.1-upscaled-4x.tif');
  });

  it('names the Immich copy like an editor render, so Immich and the culler treat it as one', () => {
    expect(upscaledFilename('DSC01234.ARW', 2)).toBe('DSC01234.upscaled-2x.edit.jpg');
  });
});

describe('upscaleStackIds', () => {
  it('stacks the copy behind the current front photo', () => {
    expect(upscaleStackIds('raw', { id: 's', primaryAssetId: 'render' }, 'up', null)).toEqual(['render', 'up']);
  });

  it('stacks it behind the RAW when the RAW has no stack yet', () => {
    expect(upscaleStackIds('raw', null, 'up', null)).toEqual(['raw', 'up']);
  });

  it('does nothing when a re-upload is in the stack already', () => {
    expect(upscaleStackIds('raw', { id: 's', primaryAssetId: 'render' }, 'up', 's')).toEqual([]);
  });
});
