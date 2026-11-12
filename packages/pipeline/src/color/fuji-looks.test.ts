import { FUJI_PROFILE_IDS } from '@immich-raw/recipe';
import { describe, expect, it } from 'vitest';
import { FUJI_CONVERSION_FILES, FUJI_FILES, FUJI_LOOKS_SOURCE, FUJI_TABLE_FILES, fujiLooksUrl, fujiProfileLooks, parseFujiLooks, validFujiLooksData } from './fuji-looks.ts';

// Synthetic stand-ins for the downloaded files (the real ones are never part of this repo).
const table = (shift: number) => {
  const lines = [`<LookTable hueDivisions="2" satDivisions="2" valDivisions="2">`];
  for (let h = 0; h < 2; h++) for (let s = 0; s < 2; s++) for (let v = 0; v < 2; v++) lines.push(`<Element HueDiv="${h}" SatDiv="${s}" ValDiv="${v}" HueShift="${shift}" SatScale="1.1" ValScale="1.0"/>`);
  lines.push('</LookTable>', '<ToneCurve Size="3">', '<Element N="0" h="0.0" v="0.0" />', '<Element N="1" h="0.5" v="0.4" />', '<Element N="2" h="1.0" v="1.0" />', '</ToneCurve>');
  return lines.join('\n');
};
const cube = (title: string) => ['# sRGB', `TITLE "${title}"`, 'LUT_3D_SIZE 2', ...Array.from({ length: 8 }, (_, i) => `${i & 1} ${(i >> 1) & 1} ${(i >> 2) & 1}`)].join('\n');

function files(): Record<string, string> {
  const out: Record<string, string> = {};
  Object.values(FUJI_TABLE_FILES).forEach((p, i) => (out[p] = table(i)));
  Object.values(FUJI_CONVERSION_FILES).forEach((p) => (out[p] = cube(p)));
  return out;
}

describe('Fujifilm film looks', () => {
  it('download from the pinned commit, with spaces encoded', () => {
    expect(FUJI_FILES).toHaveLength(11);
    expect(fujiLooksUrl('provia conversion luts/Provia to Classic Neg sRGB.cube')).toBe(
      `https://raw.githubusercontent.com/abpy/FujifilmCameraProfiles/${FUJI_LOOKS_SOURCE.commit}/provia%20conversion%20luts/Provia%20to%20Classic%20Neg%20sRGB.cube`,
    );
  });

  it('give render data for every Fujifilm profile', () => {
    const data = parseFujiLooks(files());
    expect(validFujiLooksData(data)).toBe(data);
    const looks = fujiProfileLooks(data);
    for (const id of FUJI_PROFILE_IDS) {
      expect(looks[id]?.lookTable, id).toBeDefined();
      expect(looks[id]?.toneLut, id).toBeDefined();
    }
    expect(looks['fuji-velvia']!.lookTable!.data[0]).toBe(1); // second table file
    expect(looks['fuji-velvia']!.filmLut).toBeUndefined();
    // Classic Neg. and friends are Provia plus their conversion LUT.
    for (const id of ['fuji-classic-neg', 'fuji-nostalgic-neg', 'fuji-bleach-bypass'] as const) {
      expect(looks[id]!.lookTable).toBe(looks['fuji-provia']!.lookTable);
      expect(looks[id]!.filmLut?.size).toBe(2);
    }
  });

  it('report which file is missing or broken', () => {
    const f = files();
    delete f[FUJI_TABLE_FILES.eterna];
    expect(() => parseFujiLooks(f)).toThrow(/eterna/);
    const g = files();
    g[FUJI_CONVERSION_FILES['bleach-bypass']] = 'LUT_3D_SIZE 2\n0 0 0';
    expect(() => parseFujiLooks(g)).toThrow(/Bleach Bypass/);
  });

  it('reject cached data from another commit or with a wrong shape', () => {
    const data = parseFujiLooks(files());
    expect(validFujiLooksData({ ...data, commit: 'abc' })).toBeNull();
    expect(validFujiLooksData({ ...data, cubes: { ...data.cubes, 'classic-neg': { size: 3, data: new Float32Array(3) } } })).toBeNull();
    expect(validFujiLooksData(null)).toBeNull();
  });
});
