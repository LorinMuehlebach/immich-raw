import type { AssetResponseDto } from '@immich/sdk';
import { describe, expect, it } from 'vitest';
import { arrangeFilmstrip, captureTime, filmstripFilter, parseContext } from './context.ts';

const ALBUM = '11111111-2222-4333-8444-555555555555';

const asset = (id: string, name: string, local: string, extra: Partial<AssetResponseDto> = {}) =>
  ({ id, originalFileName: name, localDateTime: local, fileCreatedAt: local, isTrashed: false, ...extra }) as AssetResponseDto;

describe('parseContext', () => {
  it('reads album and person contexts and falls back to the timeline', () => {
    expect(parseContext(`album:${ALBUM}`)).toEqual({ kind: 'album', id: ALBUM });
    expect(parseContext(`person:${ALBUM.toUpperCase()}`)).toEqual({ kind: 'person', id: ALBUM });
    expect(parseContext('timeline')).toEqual({ kind: 'timeline' });
    expect(parseContext('album:not-a-uuid')).toEqual({ kind: 'timeline' });
    expect(parseContext(null)).toEqual({ kind: 'timeline' });
  });
});

describe('filmstripFilter', () => {
  const current = asset('c', 'a.NEF', '2024-06-01T12:00:00.000Z');

  it('limits to the album, excludes trash and non-RAW files', () => {
    const f = filmstripFilter({ kind: 'album', id: ALBUM }, current);
    expect(f.albumIds).toEqual({ any: [ALBUM] });
    expect(f.trashedAt).toEqual({ eq: null });
    expect(f.or?.some((b) => b.originalFileName?.endsWith === '.nef')).toBe(true);
    expect(f.takenAt).toBeUndefined();
  });

  it('uses a ±12 h window for the timeline', () => {
    const f = filmstripFilter({ kind: 'timeline' }, current);
    expect(f.takenAt).toEqual({ gte: '2024-06-01T00:00:00.000Z', lte: '2024-06-02T00:00:00.000Z' });
  });
});

describe('arrangeFilmstrip', () => {
  it('keeps RAWs only, sorted by capture time, without trash or duplicates', () => {
    const cur = asset('2', 'b.CR3', '2024-01-01T10:00:00Z');
    const out = arrangeFilmstrip(
      [
        asset('3', 'c.ARW', '2024-01-01T11:00:00Z'),
        cur,
        asset('1', 'a.DNG', '2024-01-01T09:00:00Z'),
        asset('1', 'a.DNG', '2024-01-01T09:00:00Z'),
        asset('4', 'd.jpg', '2024-01-01T09:30:00Z'),
        asset('5', 'e.NEF', '2024-01-01T09:45:00Z', { isTrashed: true }),
      ],
      cur,
    );
    expect(out.map((a) => a.id)).toEqual(['1', '2', '3']);
  });

  it('always includes the current asset', () => {
    const cur = asset('x', 'x.RAF', '2024-01-01T10:00:00Z');
    expect(arrangeFilmstrip([], cur).map((a) => a.id)).toEqual(['x']);
  });

  it('keeps a window around the current asset when there are too many', () => {
    const many = Array.from({ length: 50 }, (_, i) => asset(String(i), `${i}.NEF`, new Date(Date.UTC(2024, 0, 1, 0, i)).toISOString()));
    const out = arrangeFilmstrip(many, many[45]!, 10);
    expect(out).toHaveLength(10);
    expect(out.map((a) => a.id)).toContain('45');
    expect(out[out.length - 1]!.id).toBe('49');
  });

  it('falls back to the file date when there is no local date', () => {
    expect(captureTime({ fileCreatedAt: '2024-01-01T00:00:00Z' } as AssetResponseDto)).toBe(Date.UTC(2024, 0, 1));
  });
});
