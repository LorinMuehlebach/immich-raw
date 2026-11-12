import { defaultRecipe } from '@immich-raw/recipe';
import { describe, expect, it } from 'vitest';
import { FUJI_BW_FILTERS, fujiSimLabel, photoDefaults } from './photo-defaults.ts';

describe('photoDefaults', () => {
  it('starts a Fujifilm RAW with its film simulation once the looks are here', () => {
    const d = photoDefaults({ make: 'Fujifilm', sim: { sim: 'classic-chrome', filter: null }, looksReady: true });
    expect(d.recipe.profile).toBe('fuji-classic-chrome');
    expect(d.wanted).toBeNull();
    expect(d.simLabel).toBe('Classic Chrome');
  });

  it('starts with Color and remembers the wanted look while they are not', () => {
    const d = photoDefaults({ make: 'FUJIFILM', sim: { sim: 'classic-chrome', filter: null }, looksReady: false });
    expect(d.recipe).toEqual(defaultRecipe());
    expect(d.wanted).toBe('fuji-classic-chrome');
  });

  it('uses Provia for a Fujifilm file without a simulation', () => {
    expect(photoDefaults({ make: 'Fujifilm', sim: null, looksReady: true }).recipe.profile).toBe('fuji-provia');
    const d = photoDefaults({ make: 'Fujifilm', sim: null, looksReady: false });
    expect(d.wanted).toBe('fuji-provia');
    expect(d.simLabel).toBeNull();
  });

  it('turns the monochrome simulations into Monochrome, with or without the looks', () => {
    for (const looksReady of [false, true]) {
      const d = photoDefaults({ make: 'Fujifilm', sim: { sim: 'acros', filter: 'red' }, looksReady });
      expect(d.recipe.profile).toBe('monochrome');
      expect(d.recipe.bwMix.red).toBe(FUJI_BW_FILTERS.red.red);
      expect(d.recipe.bwMix.blue).toBe(FUJI_BW_FILTERS.red.blue);
      expect(d.recipe.bwMix.magenta).toBe(0);
      expect(d.wanted).toBeNull();
      expect(d.simLabel).toBe('Acros+R');
    }
    const plain = photoDefaults({ make: 'Fujifilm', sim: { sim: 'monochrome', filter: null }, looksReady: false });
    expect(plain.recipe.profile).toBe('monochrome');
    expect(Object.values(plain.recipe.bwMix).every((v) => v === 0)).toBe(true);
    expect(photoDefaults({ make: 'Fujifilm', sim: { sim: 'sepia', filter: null }, looksReady: true }).recipe.profile).toBe('monochrome');
  });

  it('leaves other cameras alone', () => {
    const d = photoDefaults({ make: 'Sony', sim: { sim: 'velvia', filter: null }, looksReady: true });
    expect(d.recipe).toEqual(defaultRecipe());
    expect(d.wanted).toBeNull();
  });

  it('labels simulations the way the camera does', () => {
    expect(fujiSimLabel({ sim: 'provia', filter: null })).toBe('Provia/Standard');
    expect(fujiSimLabel({ sim: 'monochrome', filter: 'yellow' })).toBe('Monochrome+Ye');
  });
});
