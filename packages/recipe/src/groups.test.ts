import { describe, expect, it } from 'vitest';
import { applyPatch, DEFAULT_GROUPS, patchGroups, pickGroups } from './groups.ts';
import { defaultRecipe } from './recipe.ts';

describe('groups', () => {
  it('copies only the chosen groups and leaves crop off by default', () => {
    const a = defaultRecipe();
    a.basic.exposure = 1;
    a.basic.vibrance = 30;
    a.crop.angle = 5;
    a.toneCurve.point.master = [[0, 0], [128, 150], [255, 255]];
    const patch = pickGroups(a, DEFAULT_GROUPS);
    expect(patchGroups(patch)).not.toContain('crop');
    const b = applyPatch(defaultRecipe(), patch);
    expect(b.basic.exposure).toBe(1);
    expect(b.basic.vibrance).toBe(30);
    expect(b.crop.angle).toBe(0);
    expect(b.toneCurve.point.master[1]).toEqual([128, 150]);
    // deep copy: editing the source afterwards doesn't leak
    a.toneCurve.point.master[1]![1] = 10;
    expect(b.toneCurve.point.master[1]).toEqual([128, 150]);
  });

  it('picks a single group', () => {
    const a = defaultRecipe();
    a.wb = { mode: 'custom', temp: 4000, tint: 5 };
    expect(pickGroups(a, ['wb'])).toEqual({ wb: { mode: 'custom', temp: 4000, tint: 5 } });
  });

  it('merges a partial group instead of replacing it', () => {
    const r = defaultRecipe();
    r.colorGrading.highlights = { hue: 45, sat: 20, lum: 5 };
    r.colorMixer.hue.red = 10;
    applyPatch(r, { colorGrading: { shadows: { hue: 220, sat: 12 } }, colorMixer: { saturation: { blue: -30 } } });
    expect(r.colorGrading.shadows).toEqual({ hue: 220, sat: 12, lum: 0 });
    expect(r.colorGrading.highlights).toEqual({ hue: 45, sat: 20, lum: 5 });
    expect(r.colorMixer.hue.red).toBe(10);
    expect(r.colorMixer.saturation.blue).toBe(-30);
    expect(patchGroups({ colorGrading: { blending: 60 }, calibration: { redHue: 5 } })).toEqual(['colorGrading', 'calibration']);
  });

  it('copies the new colour groups by default', () => {
    expect(DEFAULT_GROUPS).toEqual(expect.arrayContaining(['colorMixer', 'colorGrading', 'calibration']));
    expect(DEFAULT_GROUPS).not.toContain('crop');
  });

  it('copies the profile Amount with the profile', () => {
    const r = defaultRecipe();
    r.profile = 'vivid';
    r.profileAmount = 150;
    const patch = pickGroups(r, ['profile']);
    expect(patch).toEqual({ profile: 'vivid', profileAmount: 150 });
    expect(applyPatch(defaultRecipe(), patch).profileAmount).toBe(150);
  });
});
