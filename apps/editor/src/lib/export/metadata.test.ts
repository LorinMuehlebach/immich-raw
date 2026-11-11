import { describe, expect, it } from 'vitest';
import { captureDate, exportMetadata, immichCopyExif, keywordsOf, type MetadataAsset } from './metadata.ts';

const asset: MetadataAsset = {
  localDateTime: '2022-12-17T16:03:36.000Z',
  exifInfo: {
    make: 'SONY',
    model: 'ILCE-7RM5',
    lensModel: 'FE 24-70mm F2.8 GM II',
    fNumber: 4,
    exposureTime: '1/250',
    iso: 100,
    focalLength: 35,
    dateTimeOriginal: '2022-12-17T08:03:36.000Z',
    timeZone: 'Asia/Shanghai',
    latitude: 31.23,
    longitude: 121.47,
    description: 'The Bund',
    rating: 4,
    city: 'Shanghai',
    state: 'Shanghai',
    country: 'China',
  },
  tags: [{ value: 'Travel' }, { value: 'Places/Asia/Shanghai' }, { value: 'Culling/Rejected/Blur' }, { value: 'Culling' }, { value: 'Travel' }],
};
const opts = { copyright: '© {year} {owner}', owner: 'Ana', software: 'immich-raw', ppi: 300, width: 3000, height: 2000 };

describe('exportMetadata', () => {
  it('writes everything for "all"', () => {
    const { exif, xmp } = exportMetadata(asset, 'all', opts);
    expect(exif).toMatchObject({
      make: 'SONY',
      lensModel: 'FE 24-70mm F2.8 GM II',
      dateTimeOriginal: '2022:12:17 16:03:36',
      offsetTimeOriginal: '+08:00',
      gps: { latitude: 31.23, longitude: 121.47 },
      artist: 'Ana',
      copyright: '© 2022 Ana',
      resolution: 300,
      colorSpace: 'sRGB',
      pixelWidth: 3000,
      pixelHeight: 2000,
      software: 'immich-raw',
    });
    expect(xmp).toMatchObject({
      creator: 'Ana',
      rights: '© 2022 Ana',
      description: 'The Bund',
      keywords: ['Travel', 'Places/Asia/Shanghai'],
      rating: 4,
      createDate: '2022-12-17T16:03:36+08:00',
      city: 'Shanghai',
      country: 'China',
    });
  });

  it('drops GPS and place names for "noLocation"', () => {
    const { exif, xmp } = exportMetadata(asset, 'noLocation', opts);
    expect(exif.gps).toBeUndefined();
    expect(exif.make).toBe('SONY');
    expect(xmp.city).toBeUndefined();
    expect(xmp.country).toBeUndefined();
    expect(xmp.keywords).toEqual(['Travel', 'Places/Asia/Shanghai']);
  });

  it('keeps only copyright and artist for "copyright"', () => {
    const { exif, xmp } = exportMetadata(asset, 'copyright', opts);
    expect(exif.make).toBeUndefined();
    expect(exif.dateTimeOriginal).toBeUndefined();
    expect(exif.gps).toBeUndefined();
    expect(exif).toMatchObject({ artist: 'Ana', copyright: '© 2022 Ana' });
    expect(xmp.keywords).toBeUndefined();
    expect(xmp.description).toBeUndefined();
  });

  it('leaves out an empty copyright and owner', () => {
    const { exif, xmp } = exportMetadata(asset, 'all', { ...opts, copyright: '', owner: ' ' });
    expect(exif.copyright).toBeUndefined();
    expect(exif.artist).toBeUndefined();
    expect(xmp.creator).toBeUndefined();
  });
});

describe('helpers', () => {
  it('reads the wall-clock capture time', () => {
    const d = captureDate(asset)!;
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()]).toEqual([2022, 11, 17, 16, 3]);
    expect(captureDate({})).toBeNull();
  });

  it('turns tags into keywords without the culler tags', () => {
    expect(keywordsOf(asset.tags)).toEqual(['Travel', 'Places/Asia/Shanghai']);
    expect(keywordsOf(null)).toEqual([]);
  });

  it('gives the Immich copy no artist, copyright or keywords', () => {
    const exif = immichCopyExif(asset, 'immich-raw', 3840, 2560);
    expect(exif).toMatchObject({ make: 'SONY', software: 'immich-raw', pixelWidth: 3840 });
    expect(exif.artist).toBeUndefined();
    expect(exif.copyright).toBeUndefined();
  });
});
