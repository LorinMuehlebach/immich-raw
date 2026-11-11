import { defaultRecipe } from '@immich-raw/recipe';
import { describe, expect, it } from 'vitest';
import { History } from './history.ts';

describe('History', () => {
  it('records named steps, undoes, redoes and jumps', () => {
    const h = new History();
    const r = defaultRecipe();
    h.reset(r);
    r.basic.exposure = 0.5;
    expect(h.commit(r, 'Exposure +0.50')).toBe(true);
    r.basic.contrast = 20;
    h.commit(r, 'Contrast +20');
    expect(h.list().steps.map((s) => s.label)).toEqual(['Open', 'Exposure +0.50', 'Contrast +20']);

    const back = h.undo(r)!;
    expect(back.basic.contrast).toBe(0);
    expect(back.basic.exposure).toBe(0.5);
    expect(h.list().index).toBe(1);
    expect(h.redo()!.basic.contrast).toBe(20);
    expect(h.jump(0)!.basic.exposure).toBe(0);
  });

  it('does not record a step when nothing changed', () => {
    const h = new History();
    const r = defaultRecipe();
    h.reset(r);
    expect(h.commit(r, 'Nothing')).toBe(false);
    expect(h.canUndo).toBe(false);
  });

  it('commits a pending live change before undoing it', () => {
    const h = new History();
    const r = defaultRecipe();
    h.reset(r);
    r.basic.shadows = 30; // dragged, not committed yet
    const back = h.undo(r, 'Shadows +30')!;
    expect(back.basic.shadows).toBe(0);
    expect(h.canRedo).toBe(true);
  });

  it('drops redo steps after a new change', () => {
    const h = new History();
    const r = defaultRecipe();
    h.reset(r);
    r.basic.exposure = 1;
    h.commit(r, 'a');
    Object.assign(r, h.undo(r)!);
    r.basic.contrast = 10;
    h.commit(r, 'b');
    expect(h.canRedo).toBe(false);
    expect(h.list().steps.map((s) => s.label)).toEqual(['Open', 'b']);
  });

  it('amends the latest step in place, and never the opening state', () => {
    const h = new History();
    const r = defaultRecipe();
    h.reset(r);
    r.basic.exposure = 1;
    h.amend(r, 'Auto Tone');
    r.basic.exposure = 1.4;
    h.amend(r, 'Auto Tone');
    expect(h.list().steps.map((s) => s.label)).toEqual(['Open', 'Auto Tone']);
    expect(h.undo(r)!.basic.exposure).toBe(0);
    expect(h.redo()!.basic.exposure).toBe(1.4);
  });
});
