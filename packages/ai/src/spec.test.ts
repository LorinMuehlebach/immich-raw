import { newAiComponent } from '@immich-raw/recipe';
import { describe, expect, it } from 'vitest';
import { modelsFor } from './models.ts';
import { analysisRecipe, objectKey, specFor, specKey } from './spec.ts';

describe('AI component specs', () => {
  // Mask frame -> image: a quarter turn, so x and y swap.
  const turn = (mx: number, my: number): [number, number] => [1 - my, mx];

  it('maps points into the analysis image and keeps boxes ordered', () => {
    const obj = specFor(newAiComponent('object', 'add', { box: [0.1, 0.2, 0.3, 0.6] }), turn);
    expect(obj.box).toEqual([0.4, 0.1, 0.8, 0.3]);
    const brushed = specFor(newAiComponent('object', 'add', { points: [0.1, 0.2] }), turn);
    expect(brushed.points).toEqual([0.8, 0.1]);
    const person = specFor(newAiComponent('people', 'add', { parts: ['hair'], person: { x: 0.12345, y: 0.5 } }), turn);
    expect(person).toEqual({ target: 'people', parts: ['hair'], person: [0.5, 0.123] });
  });

  it('gives equal specs equal keys', () => {
    const a = specFor(newAiComponent('landscape', 'add', { classes: ['water'] }), turn);
    const b = specFor({ ...newAiComponent('landscape', 'subtract', { classes: ['water'] }), invert: true }, turn);
    expect(specKey(a)).toBe(specKey(b));
    expect(specKey(a)).not.toBe(specKey({ ...a, classes: ['sky'] }));
    expect(objectKey({ target: 'object', box: [0, 0, 1, 1] })).toBe('[0,0,1,1]');
  });

  it('knows which models a component needs', () => {
    expect(modelsFor({ target: 'background' })).toEqual(['subject']);
    expect(modelsFor({ target: 'object', box: [0, 0, 1, 1] })).toEqual(['subject']);
    expect(modelsFor({ target: 'object' })).toEqual(['objectEncoder', 'objectDecoder']);
  });

  it('renders the analysis image without lens corrections', () => {
    const r = analysisRecipe();
    expect([r.lens.profile, r.lens.removeCA, r.masks.length]).toEqual([false, false, 0]);
  });
});
