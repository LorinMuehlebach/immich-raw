import { describe, expect, it } from 'vitest';
import type { AssetResponseDto } from '@immich/sdk';
import { findBracket, parseExposureTime, referenceShot, shotOf, type Shot } from './brackets.ts';

const T0 = Date.parse('2026-06-01T10:00:00.000Z');

let n = 0;
/** A shot `ms` after T0 at `ev` stops from 1/100 s (by shutter speed), same camera unless overridden. */
function shot(ms: number, ev: number, over: Partial<Shot> = {}): Shot {
  const exposureTime = 0.01 * 2 ** ev;
  return {
    id: `id${++n}`,
    fileName: `DSC${String(n).padStart(5, '0')}.ARW`,
    time: T0 + ms,
    camera: 'sony ilce-7m3',
    lens: 'fe 24-105mm f4 g oss',
    focalLength: 24,
    width: 6000,
    height: 4000,
    exposureTime,
    fNumber: 8,
    iso: 100,
    ev: Math.log2((exposureTime * 100) / 64),
    ...over,
  };
}

const ids = (s: Shot[]) => s.map((x) => x.id);

describe('parseExposureTime', () => {
  it('reads fractions, decimals and whole seconds', () => {
    expect(parseExposureTime('1/250')).toBeCloseTo(0.004);
    expect(parseExposureTime('1/250 s')).toBeCloseTo(0.004);
    expect(parseExposureTime('0.5')).toBe(0.5);
    expect(parseExposureTime('2')).toBe(2);
    expect(parseExposureTime(0.01)).toBe(0.01);
    expect(parseExposureTime('')).toBeNull();
    expect(parseExposureTime('fast')).toBeNull();
    expect(parseExposureTime(null)).toBeNull();
  });
});

describe('findBracket', () => {
  it('finds a 0 / - / + bracket from any of its shots', () => {
    const b = [shot(0, 0), shot(150, -2), shot(300, 2)];
    const others = [shot(-60_000, 0), shot(90_000, 0)];
    for (const s of b) expect(ids(findBracket([...others, ...b].reverse(), s.id))).toEqual(ids(b));
  });

  it('splits brackets shot back to back', () => {
    const a = [shot(0, 0), shot(100, -1), shot(200, 1)];
    const b = [shot(300, 0), shot(400, -1), shot(500, 1)];
    expect(ids(findBracket([...a, ...b], b[1]!.id))).toEqual(ids(b));
    expect(ids(findBracket([...a, ...b], a[2]!.id))).toEqual(ids(a));
  });

  it('allows for long exposures between shots', () => {
    // An 8 s exposure: the next shot starts ~8 s later.
    const b = [shot(0, 0, { exposureTime: 2, ev: 0 }), shot(2_300, -2, { exposureTime: 0.5, ev: -2 }), shot(3_000, 2, { exposureTime: 8, ev: 2 })];
    const late = shot(3_000 + 8_000 + 1_500, 4, { exposureTime: 32, ev: 4 });
    expect(ids(findBracket([...b, late], b[0]!.id))).toEqual(ids([...b, late]));
  });

  it('ignores photos that are too far apart, from another camera or of another size', () => {
    expect(findBracket([shot(0, 0), shot(10_000, -2)], `id${n - 1}`)).toEqual([]);
    const a = shot(0, 0);
    expect(findBracket([a, shot(100, -2, { camera: 'nikon z 6' })], a.id)).toEqual([]);
    const c = shot(0, 0);
    expect(findBracket([c, shot(100, -2, { width: 3000, height: 2000 })], c.id)).toEqual([]);
    const d = shot(0, 0);
    expect(findBracket([d, shot(100, -2, { focalLength: 50 })], d.id)).toEqual([]);
  });

  it('is not fooled by a burst at one exposure', () => {
    const burst = [shot(0, 0), shot(100, 0), shot(200, 0), shot(300, 0)];
    expect(findBracket(burst, burst[2]!.id)).toEqual([]);
  });

  it('needs a real spread of exposures', () => {
    const tiny = [shot(0, 0), shot(100, 0.4)];
    expect(findBracket(tiny, tiny[0]!.id)).toEqual([]);
  });

  it('accepts a portrait shot among landscape ones (same sensor size)', () => {
    const b = [shot(0, 0), shot(150, -2, { width: 4000, height: 6000 }), shot(300, 2)];
    expect(ids(findBracket(b, b[0]!.id))).toHaveLength(3);
  });

  it('stops at nine frames', () => {
    const many = Array.from({ length: 11 }, (_, i) => shot(i * 100, i - 5));
    expect(findBracket(many, many[0]!.id)).toHaveLength(9);
  });
});

describe('referenceShot', () => {
  it('is the middle exposure', () => {
    const b = [shot(0, 0), shot(100, -2), shot(200, 2)];
    expect(referenceShot(b).id).toBe(b[0]!.id);
    const four = [shot(0, -1.5), shot(100, -0.5), shot(200, 0.5), shot(300, 1.5)];
    expect(referenceShot(four).id).toBe(four[1]!.id);
  });
});

describe('shotOf', () => {
  const asset = (over: Partial<AssetResponseDto> & { exif?: Partial<NonNullable<AssetResponseDto['exifInfo']>> }) =>
    ({
      id: 'a',
      originalFileName: 'IMG_0001.CR3',
      isTrashed: false,
      fileCreatedAt: '2026-06-01T10:00:00.000Z',
      localDateTime: '2026-06-01T12:00:00.000Z',
      ...over,
      exifInfo: { make: 'Canon', model: 'EOS R5', exposureTime: '1/100', fNumber: 8, iso: 100, focalLength: 35, dateTimeOriginal: '2026-06-01T10:00:00.250Z', exifImageWidth: 8192, exifImageHeight: 5464, ...over.exif },
    }) as AssetResponseDto;

  it('takes the capture time with milliseconds and works out the exposure', () => {
    const s = shotOf(asset({}))!;
    expect(s.time).toBe(Date.parse('2026-06-01T10:00:00.250Z'));
    expect(s.ev).toBeCloseTo(Math.log2((0.01 * 100) / 64));
    expect(s.camera).toBe('canon eos r5');
  });

  it('skips JPEGs, the trash, merged HDRs and shots without a shutter speed', () => {
    expect(shotOf(asset({ originalFileName: 'IMG_0001.JPG' }))).toBeNull();
    expect(shotOf(asset({ originalFileName: 'IMG_0001-HDR.dng' }))).toBeNull();
    expect(shotOf(asset({ originalFileName: 'IMG_0001-HDR-2.DNG' }))).toBeNull();
    expect(shotOf(asset({ originalFileName: 'IMG_0001.dng' }))).not.toBeNull();
    expect(shotOf(asset({ isTrashed: true }))).toBeNull();
    expect(shotOf(asset({ exif: { exposureTime: null } }))).toBeNull();
  });
});
