// The app's worker pool encodes tiles cut out with extractTile; the result must be the same
// bytes as encoding straight from the whole image.
import { describe, expect, it } from 'vitest';
import { cfaComponents, encodeCfaTile, encodeCfaTileData, extractTile, lossyTileRgba, tileLayout } from './tiles.ts';
import { rng } from './test-utils.ts';

function noise(n: number, seed: number): Uint16Array {
  const r = rng(seed);
  const out = new Uint16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.floor(r() * 65536);
  return out;
}

// Edge tiles narrower and shorter than a tile, an image narrower than one tile, the
// 2 * tileWidth === width case (1 component), and an X-Trans pattern width.
const SIZES: [number, number, number][] = [
  [600, 300, 2],
  [100, 70, 2],
  [512, 260, 2],
  [534, 258, 6],
];

describe('tiles cut out with extractTile', () => {
  it.each(SIZES)('CFA %ix%i (pattern %i) encodes like encodeCfaTile', (width, height, patternWidth) => {
    const data = noise(width * height, width + height);
    const layout = tileLayout(width, height);
    const components = cfaComponents(width, layout.tileWidth, patternWidth);
    for (let i = 0; i < layout.count; i++) {
      const tile = extractTile(data, width, height, layout, i);
      expect(tile.length).toBe(layout.tileWidth * layout.tileHeight);
      expect(encodeCfaTileData(tile, layout.tileWidth, layout.tileHeight, components)).toEqual(encodeCfaTile({ data, width, height, patternWidth }, i));
    }
  });

  it.each(SIZES)('linear RGB %ix%i gives the same lossy tile pixels', (width, height) => {
    const data = noise(width * height * 3, width * height);
    const layout = tileLayout(width, height);
    for (let i = 0; i < layout.count; i++) {
      const tile = extractTile(data, width, height, layout, i, 3);
      expect(tile.length).toBe(layout.tileWidth * layout.tileHeight * 3);
      expect(lossyTileRgba({ data: tile, width: layout.tileWidth, height: layout.tileHeight }, 0)).toEqual(lossyTileRgba({ data, width, height }, i));
    }
  });

  it('replicates the last pixel of each row and the last row', () => {
    const width = 300;
    const height = 260;
    const data = noise(width * height * 3, 7);
    const layout = tileLayout(width, height);
    const last = layout.count - 1; // 44 x 4 inside, the rest padded
    const tile = extractTile(data, width, height, layout, last, 3);
    const px = (x: number, y: number) => [...data.subarray((y * width + x) * 3, (y * width + x) * 3 + 3)];
    const at = (x: number, y: number) => [...tile.subarray((y * layout.tileWidth + x) * 3, (y * layout.tileWidth + x) * 3 + 3)];
    expect(at(0, 0)).toEqual(px(256, 256));
    expect(at(43, 3)).toEqual(px(299, 259));
    expect(at(255, 3)).toEqual(px(299, 259));
    expect(at(10, 255)).toEqual(px(266, 259));
  });
});
