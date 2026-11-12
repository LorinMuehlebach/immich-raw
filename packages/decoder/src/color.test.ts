import { describe, expect, it } from 'vitest';
import { CAMERAS } from '../../pipeline/src/color/fixtures.ts';
import { camXyzFromRgbCam, hasCamXyz } from './color.ts';

const XYZ_RGB = [
  [0.4124564, 0.3575761, 0.1804375],
  [0.2126729, 0.7151522, 0.072175],
  [0.0193339, 0.119192, 0.9503041],
];

/** pre_mul as LibRaw sets it for a camera matrix: 1 / row sums of cam_xyz · XYZ_RGB. */
function preMulFor(camXyz: number[][]): number[] {
  return camXyz.slice(0, 3).map((r) => 1 / [0, 1, 2].reduce((s, j) => s + r[0]! * XYZ_RGB[0]![j]! + r[1]! * XYZ_RGB[1]![j]! + r[2]! * XYZ_RGB[2]![j]!, 0));
}

describe('cam_xyz from rgb_cam', () => {
  // The Leica Q2 is a DNG: LibRaw built its rgb_cam from the file's own matrix, not from the
  // table cam_xyz, so the two don't belong together.
  const fromTable = CAMERAS.filter((c) => c.camera !== 'Leica Q2');

  it('gives back the camera matrix LibRaw used', () => {
    expect(fromTable.length).toBe(4);
    for (const cam of fromTable) {
      const got = camXyzFromRgbCam(cam.rgbCam, preMulFor(cam.camXyz))!;
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) expect(got[i]![j]!).toBeCloseTo(cam.camXyz[i]![j]!, 5);
    }
  });

  it('spots the all-zero matrix of an unknown camera', () => {
    expect(hasCamXyz([[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]])).toBe(false);
    expect(hasCamXyz(undefined)).toBe(false);
    expect(hasCamXyz(CAMERAS[0]!.camXyz)).toBe(true);
    expect(camXyzFromRgbCam([[0, 0, 0], [0, 0, 0], [0, 0, 0]], [1, 1, 1])).toBeNull();
    expect(camXyzFromRgbCam(CAMERAS[0]!.rgbCam, [0, 1, 1])).toBeNull();
  });
});
