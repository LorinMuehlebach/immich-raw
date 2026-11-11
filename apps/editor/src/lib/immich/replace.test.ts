import { AssetVisibility, type AssetResponseDto } from '@immich/sdk';
import { describe, expect, it } from 'vitest';
import { convertBlocked, planReplace } from './replace.ts';

const raw = (patch: Partial<AssetResponseDto> = {}) =>
  ({
    id: 'raw',
    ownerId: 'me',
    libraryId: null,
    isTrashed: false,
    visibility: AssetVisibility.Timeline,
    tags: [],
    stack: null,
    exifInfo: { dateTimeOriginal: '2024-05-01T10:00:00.000Z', timeZone: 'Europe/Zurich', latitude: 47.3, longitude: 8.5, rating: 4, description: 'Lake' },
    ...patch,
  }) as AssetResponseDto;

describe('convert to DNG: replace plan', () => {
  it('only lets the owner convert files Immich can delete', () => {
    expect(convertBlocked(raw(), { id: 'me' })).toBeNull();
    expect(convertBlocked(raw(), { id: 'partner' })).toMatch(/owner/);
    expect(convertBlocked(raw(), null)).toMatch(/owner/);
    expect(convertBlocked(raw({ libraryId: 'lib' }), { id: 'me' })).toMatch(/external library/);
    expect(convertBlocked(raw({ isTrashed: true }), { id: 'me' })).toMatch(/trash/);
    expect(convertBlocked(raw({ visibility: AssetVisibility.Locked }), { id: 'me' })).toMatch(/locked/);
  });

  it('copies date (with its zone), location, rating, description, tags and archive state', () => {
    const plan = planReplace(raw({ visibility: AssetVisibility.Archive, tags: [{ id: 't1' }, { id: 't2' }] as AssetResponseDto['tags'] }), 'permanent');
    expect(plan.update).toEqual({
      dateTimeOriginal: '2024-05-01T12:00:00.000+02:00',
      latitude: 47.3,
      longitude: 8.5,
      rating: 4,
      description: 'Lake',
      visibility: AssetVisibility.Archive,
    });
    expect(plan.tagIds).toEqual(['t1', 't2']);
    expect(plan.force).toBe(true);
    expect(planReplace(raw(), 'trash').force).toBe(false);
    expect(planReplace(raw(), 'trash').update.visibility).toBeUndefined();
  });
});
