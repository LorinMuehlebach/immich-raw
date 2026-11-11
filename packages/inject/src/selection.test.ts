import { describe, expect, it } from 'vitest';
import { idsFromDownloadBody } from './selection.ts';

const A = '1801b1cb-a19e-4e11-95f0-1324647e05c2';

describe('idsFromDownloadBody', () => {
  it('reads the ids Immich posts to /api/download/info', () => {
    expect(idsFromDownloadBody(JSON.stringify({ assetIds: [A, A.toUpperCase(), 'x'] }))).toEqual([A, A]);
  });

  it('ignores other bodies', () => {
    expect(idsFromDownloadBody('{"albumId":"x"}')).toBeNull();
    expect(idsFromDownloadBody('not json')).toBeNull();
    expect(idsFromDownloadBody(undefined)).toBeNull();
  });
});
