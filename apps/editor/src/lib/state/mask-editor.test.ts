import { describe, expect, it } from 'vitest';
import { LOCAL_PARAMS, MAX_BRUSHES, MAX_MASKS, MAX_POLYGON_POINTS, newComponent, newMask, type BrushComponent, type ColorComponent, type Mask, type PolygonComponent } from '@immich-raw/recipe';
import { initialMaskUi, MaskEditor, READ_ONLY_NOTICE, type MaskHost, type ShapeGesture, type StrokeGesture } from './mask-editor.ts';

/** A host that records what the editor would do: history steps, notices, renders. */
function setup(o: { masks?: Mask[]; readOnly?: boolean; toolActive?: boolean } = {}) {
  const recipe = { masks: o.masks ?? [] };
  const state = { readOnly: o.readOnly ?? false, toolActive: o.toolActive ?? true };
  const log: { commit: boolean; label?: string }[] = [];
  const notices: string[] = [];
  const saved: unknown[] = [];
  let masking!: MaskEditor;
  const host: MaskHost = {
    recipe: () => recipe,
    readOnly: () => state.readOnly,
    toolActive: () => state.toolActive,
    openTool: () => {
      state.toolActive = true;
      masking.toolChanged(true);
    },
    changed: (commit, label) => void log.push({ commit, label }),
    render: () => {},
    notify: (m) => void notices.push(m),
    saveBrush: (b) => void saved.push(b),
    findPeople: () => {},
    personPoint: () => null,
  };
  masking = new MaskEditor(initialMaskUi(null), host);
  const commits = () => log.filter((s) => s.commit).map((s) => s.label);
  return { masking, recipe, state, log, notices, saved, commits };
}

const NO_MODS = { shift: false, erase: false };

describe('MaskEditor', () => {
  it('gives a radial drawn by a click its default size, in one history step', () => {
    const { masking, recipe, log, commits } = setup();
    masking.start('radial');
    expect(masking.ui.draft).toMatchObject({ kind: 'radial', maskId: null });
    const g = masking.press([0.5, 0.5], NO_MODS) as ShapeGesture;
    expect(g).toMatchObject({ kind: 'shape', drawing: true });
    expect(masking.ui.draft).toBeNull();
    g.end(2);
    expect(recipe.masks).toHaveLength(1);
    expect(recipe.masks[0]!.components[0]).toMatchObject({ kind: 'radial', cx: 0.5, cy: 0.5, rx: 0.15, ry: 0.15 });
    expect(commits()).toEqual(['New Mask: Radial Gradient']);
    expect(log.every((s) => s.commit || s.label === 'New Mask: Radial Gradient')).toBe(true);
    expect(masking.selectedComponent?.id).toBe(g.compId);
  });

  it('keeps a dragged gradient as drawn and clamps what it is given', () => {
    const { masking, recipe, commits } = setup();
    masking.start('radial');
    const g = masking.press([0.5, 0.5], NO_MODS) as ShapeGesture;
    g.move({ rx: 0.3, ry: 99, angle: -90 });
    g.end(40);
    expect(recipe.masks[0]!.components[0]).toMatchObject({ rx: 0.3, ry: 4, angle: 270 });
    expect(commits()).toHaveLength(1);
  });

  it('adds a luminance range at once and names masks in order', () => {
    const { masking, recipe, commits } = setup();
    masking.start('luminance');
    masking.start('luminance');
    expect(recipe.masks.map((m) => m.name)).toEqual(['Mask 1', 'Mask 2']);
    expect(commits()).toEqual(['New Mask: Luminance Range', 'New Mask: Luminance Range']);
    expect(masking.ui.draft).toBeNull();
  });

  it('paints a stroke: one stroke at a time, thinned points, one commit', () => {
    const { masking, commits } = setup();
    masking.start('brush');
    const s = masking.press([0.1, 0.1], NO_MODS) as StrokeGesture;
    expect(s.kind).toBe('stroke');
    expect(masking.press([0.2, 0.2], NO_MODS)).toBeNull();
    s.to([0.1000001, 0.1]); // too close to the last point
    s.to([0.4, 0.4]);
    expect(commits()).toEqual([]);
    s.end();
    s.end();
    expect(commits()).toEqual(['New Mask: Brush']);
    const c = masking.selectedComponent as BrushComponent;
    expect(c.strokes).toHaveLength(1);
    expect(c.strokes[0]!.points).toEqual([0.1, 0.1, 0.4, 0.4]);
    // The brush part stays selected, so the next press paints on it.
    const next = masking.press([0.5, 0.5], { shift: false, erase: true }) as StrokeGesture;
    next.end();
    expect(c.strokes.map((x) => x.erase)).toEqual([false, true]);
    expect(commits().at(-1)).toBe('Mask 1: Erase');
  });

  it('picks colours: a click replaces the samples, Shift adds one', () => {
    const { masking } = setup();
    masking.start('color');
    (masking.press([0.2, 0.2], NO_MODS) as ShapeGesture).end(0);
    const add = masking.press([0.6, 0.6], { shift: true, erase: false }) as ShapeGesture;
    expect(add).toMatchObject({ kind: 'shape', drawing: false, sampleIndex: 1 });
    add.end(0);
    expect((masking.selectedComponent as ColorComponent).samples.map((s) => [s.x, s.y])).toEqual([[0.2, 0.2], [0.6, 0.6]]);
    (masking.press([0.9, 0.9], NO_MODS) as ShapeGesture).end(0);
    expect((masking.selectedComponent as ColorComponent).samples).toHaveLength(1);
  });

  it('points out an object with a box, normalised', () => {
    const { masking, recipe, commits } = setup();
    masking.startAi('object');
    const g = masking.press([0.8, 0.9], NO_MODS);
    expect(g?.kind).toBe('object');
    if (g?.kind === 'object') g.end([0.8, 0.9, 0.2, 0.1], null);
    expect(recipe.masks[0]!.components[0]).toMatchObject({ kind: 'ai', target: 'object', box: [0.2, 0.1, 0.8, 0.9] });
    expect(commits()[0]).toMatch(/^New Mask: /);
    expect(masking.ui.draft).toBeNull();
  });

  it('refuses a mask past the limit, with a notice and no change', () => {
    const masks = Array.from({ length: MAX_MASKS }, (_, i) => newMask(`M${i}`, newComponent('linear')));
    const { masking, recipe, notices, log } = setup({ masks });
    masking.start('linear');
    expect(masking.ui.draft).toBeNull();
    expect(notices).toEqual([`Up to ${MAX_MASKS} masks are supported.`]);
    expect(recipe.masks).toHaveLength(MAX_MASKS);
    expect(log).toEqual([]);
  });

  it('changes nothing on a read-only photo', () => {
    const masks = [newMask('Mask 1', newComponent('linear'))];
    const { masking, recipe, notices, log } = setup({ masks, readOnly: true });
    masking.start('radial');
    masking.deleteMask(masks[0]!.id);
    masking.select(masks[0]!.id);
    masking.setParam(LOCAL_PARAMS.exposure, 1);
    expect(masking.press([0.5, 0.5], NO_MODS)).toBeNull();
    expect(recipe.masks).toHaveLength(1);
    expect(recipe.masks[0]!.adjust.exposure).toBe(0);
    expect(log).toEqual([]);
    expect(new Set(notices)).toEqual(new Set([READ_ONLY_NOTICE]));
    expect(masking.painting).toBe(false);
  });

  it('shows the overlay while the shape is edited, hides it for adjustments, O brings it back', () => {
    const { masking } = setup();
    masking.start('luminance');
    const id = masking.ui.sel.mask;
    expect(masking.overlayMask).toBe(id);
    masking.setParam(LOCAL_PARAMS.exposure, 1, true);
    expect(masking.selectedMask!.adjust.exposure).toBe(1);
    expect(masking.overlayMask).toBeNull();
    masking.toggleOverlay();
    expect(masking.overlayMask).toBe(id);
    masking.toggleOverlay();
    expect(masking.overlayMask).toBeNull();
  });

  it('opens the tool when arming, disarms when leaving, selects the last mask on entering', () => {
    const masks = [newMask('A', newComponent('linear')), newMask('B', newComponent('radial'))];
    const { masking, state } = setup({ masks, toolActive: false });
    masking.start('linear');
    expect(state.toolActive).toBe(true);
    expect(masking.ui.sel.mask).toBe(masks[1]!.id);
    masking.toolChanged(false);
    expect(masking.ui.draft).toBeNull();
  });

  it('removing a part keeps the mask additive and selects its first part', () => {
    const { masking, recipe } = setup();
    masking.start('luminance');
    const maskId = masking.ui.sel.mask!;
    masking.start('luminance', 'subtract', maskId);
    const [first, second] = recipe.masks[0]!.components;
    expect(second!.mode).toBe('subtract');
    masking.deleteComponent(maskId, first!.id);
    expect(recipe.masks[0]!.components).toEqual([expect.objectContaining({ id: second!.id, mode: 'add' })]);
    expect(masking.ui.sel).toEqual({ mask: maskId, comp: second!.id });
    masking.deleteComponent(maskId, second!.id);
    expect(recipe.masks).toEqual([]);
    expect(masking.ui.sel).toEqual({ mask: null, comp: null });
  });

  it('a handle drag selects the part and commits once', () => {
    const masks = [newMask('A', newComponent('linear')), newMask('B', newComponent('radial'))];
    const { masking, commits } = setup({ masks });
    const g = masking.grab(masks[0]!.id, masks[0]!.components[0]!.id)!;
    expect(masking.ui.sel.mask).toBe(masks[0]!.id);
    g.move({ x0: 0.25 });
    g.end(30);
    expect(masks[0]!.components[0]).toMatchObject({ x0: 0.25 });
    expect(commits()).toEqual([undefined]); // commits the step the move named
  });

  it('keeps brush settings in range and saves them without the eraser', () => {
    const { masking, saved } = setup();
    masking.setBrush({ size: 500, erase: true });
    expect(masking.ui.brush).toMatchObject({ size: 100, erase: true });
    expect(saved.at(-1)).toEqual({ size: 100, feather: 50, flow: 100, density: 100 });
  });
  it('draws a polygon corner by corner: Backspace takes one back, closing needs three', () => {
    const { masking, recipe, commits } = setup();
    masking.start('polygon');
    expect(masking.ui.draft).toMatchObject({ kind: 'polygon', points: [] });
    // Clicks on the photo don't go through press().
    expect(masking.press([0.1, 0.1], NO_MODS)).toBeNull();
    masking.addPolygonPoint([0.1, 0.1]);
    masking.addPolygonPoint([0.9, 0.1]);
    expect(masking.closePolygon()).toBe(false);
    masking.addPolygonPoint([0.5, 0.123456789]);
    masking.removePolygonPoint();
    masking.addPolygonPoint([0.5, 0.9]);
    expect(commits()).toEqual([]);
    expect(masking.closePolygon()).toBe(true);
    expect(masking.ui.draft).toBeNull();
    const c = recipe.masks[0]!.components[0] as PolygonComponent;
    expect(c).toMatchObject({ kind: 'polygon', points: [0.1, 0.1, 0.9, 0.1, 0.5, 0.9] });
    expect(c.freehand).toBeUndefined();
    expect(commits()).toEqual(['New Mask: Polygon']);
    expect(masking.selectedComponent?.id).toBe(c.id);
  });

  it('stores polygon corners with 5 decimals and stops at the corner limit', () => {
    const { masking, notices } = setup();
    masking.start('polygon');
    masking.addPolygonPoint([0.123456789, 0.5]);
    expect(masking.ui.draft?.points).toEqual([0.12346, 0.5]);
    for (let i = 1; i < MAX_POLYGON_POINTS + 3; i++) masking.addPolygonPoint([i / 1000, 0.5]);
    expect(masking.ui.draft?.points).toHaveLength(MAX_POLYGON_POINTS * 2);
    expect(notices.at(-1)).toMatch(/corners per polygon/);
  });

  it('closes and simplifies a lasso, added to an existing mask', () => {
    const masks = [newMask('Sky', newComponent('radial', 'add'))];
    const { masking, recipe, commits } = setup({ masks });
    masking.start('lasso', 'subtract', masks[0]!.id);
    // A square outline with many points along each side.
    const pts: number[] = [];
    for (let i = 0; i <= 20; i++) pts.push(0.2 + i * 0.03, 0.2);
    for (let i = 1; i <= 20; i++) pts.push(0.8, 0.2 + i * 0.03);
    for (let i = 1; i <= 20; i++) pts.push(0.8 - i * 0.03, 0.8);
    for (let i = 1; i < 20; i++) pts.push(0.2, 0.8 - i * 0.03);
    expect(masking.drawLasso(pts)).toBe(true);
    const c = recipe.masks[0]!.components[1] as PolygonComponent;
    expect(c).toMatchObject({ kind: 'polygon', mode: 'subtract', freehand: true });
    expect(c.points.length / 2).toBe(4);
    expect(commits()).toEqual(['Subtract Lasso']);
    // Without a lasso armed, nothing.
    expect(masking.drawLasso(pts)).toBe(false);
  });

  it('polygons and lassos share the brush limit', () => {
    const masks = [newMask('Brushes', newComponent('brush', 'add'))];
    for (let i = 1; i < MAX_BRUSHES; i++) masks[0]!.components.push(newComponent('polygon', 'add'));
    const { masking, notices } = setup({ masks });
    masking.start('lasso');
    expect(masking.ui.draft).toBeNull();
    expect(notices.at(-1)).toMatch(/brush, polygon and lasso/);
  });

  it('adds a corner on an edge as a drag, removes one but keeps three', () => {
    const tri = newComponent('polygon', 'add') as PolygonComponent;
    tri.points = [0, 0, 1, 0, 0, 1];
    const masks = [newMask('Mask 1', tri)];
    const { masking, commits } = setup({ masks });
    const g = masking.addCorner(masks[0]!.id, tri.id, 0, [0.5, -0.1])!;
    expect(g).toMatchObject({ kind: 'shape', compId: tri.id });
    expect(g.comp).toMatchObject({ points: [0, 0, 0.5, -0.1, 1, 0, 0, 1] });
    g.move({ points: [0, 0, 0.5, -0.2, 1, 0, 0, 1] });
    g.end(20);
    expect(commits()).toHaveLength(1);
    masking.removeCorner(masks[0]!.id, tri.id, 1);
    expect((masks[0]!.components[0] as PolygonComponent).points).toEqual([0, 0, 1, 0, 0, 1]);
    expect(commits().at(-1)).toBe('Mask 1: Remove Corner');
    masking.removeCorner(masks[0]!.id, tri.id, 0);
    expect((masks[0]!.components[0] as PolygonComponent).points).toHaveLength(6);
  });

  it('reset clears the selection and anything armed', () => {
    const masks = [newMask('Mask 1', newComponent('radial', 'add'))];
    const { masking } = setup({ masks });
    masking.select(masks[0]!.id);
    masking.start('polygon');
    masking.addPolygonPoint([0.1, 0.1]);
    masking.reset();
    expect(masking.ui).toMatchObject({ sel: { mask: null, comp: null }, draft: null, picker: null, editing: 'shape' });
  });
});
