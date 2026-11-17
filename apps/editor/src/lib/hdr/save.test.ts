import { describe, expect, it } from 'vitest';
import type { AssetResponseDto } from '@immich/sdk';
import { hdrFileName, halfDecoded, type BuiltHdr } from './build.ts';
import { hdrRecord, hdrStackIds } from './save.ts';

type Frame = Pick<AssetResponseDto, 'id' | 'stack'>;
const stacked = (id: string, primary: string): Frame => ({ id, stack: { id: `s-${primary}`, primaryAssetId: primary, assetCount: 2 } });

describe('hdrStackIds', () => {
  it('puts the HDR first, then the bracket', () => {
    expect(hdrStackIds('hdr', [{ id: 'a' }, { id: 'b' }, { id: 'c' }])).toEqual(['hdr', 'a', 'b', 'c']);
  });

  it('pulls in stacks the shots already belong to through their primary, once', () => {
    // b has an edited JPEG in front; a and c were stacked together by the culler with a in front.
    const ids = hdrStackIds('hdr', [stacked('a', 'a'), stacked('b', 'b-edit'), stacked('c', 'a')]);
    expect(ids).toEqual(['hdr', 'a', 'b-edit']);
  });

  it('handles an HDR that is already in the stack (a repeated upload)', () => {
    expect(hdrStackIds('hdr', [stacked('a', 'hdr'), stacked('b', 'hdr')])).toEqual(['hdr']);
  });
});

describe('hdrFileName', () => {
  it('adds -HDR and the DNG extension', () => {
    expect(hdrFileName('DSC01234.ARW')).toBe('DSC01234-HDR.dng');
    expect(hdrFileName('IMG.0001.CR3')).toBe('IMG.0001-HDR.dng');
    expect(hdrFileName('noext')).toBe('noext-HDR.dng');
  });
});

describe('hdrRecord', () => {
  it('records the frames, rounded, and the settings', () => {
    const built = {
      reference: { id: 'b' },
      frames: [
        { id: 'a', fileName: 'A.ARW', ev: -2.00049, measured: true, shift: { dx: 2, dy: -1 } },
        { id: 'b', fileName: 'B.ARW', ev: 0, measured: true, shift: { dx: 0, dy: 0 } },
      ],
      headroom: 2.3456,
    } as unknown as BuiltHdr;
    const r = hdrRecord(built, true, 'medium');
    expect(r).toMatchObject({ reference: 'b', align: true, deghost: 'medium', headroom: 2.35 });
    expect((r.frames as { ev: number }[])[0]!.ev).toBe(-2);
  });
});

describe('halfDecoded', () => {
  it('halves the merged image and applies the reference white balance as LibRaw will', () => {
    // 2 x 2 pixels, native values; k = [1, 2, 4] means LibRaw divides G by 2 and B by 4.
    const out = new Uint16Array([100, 200, 400, 300, 400, 800, 100, 200, 400, 300, 400, 800]);
    const half = halfDecoded(out, 2, 2, [1, 2, 4]);
    expect([half.width, half.height]).toEqual([1, 1]);
    expect(Array.from(half.data)).toEqual([200, 150, 150]);
  });
});
