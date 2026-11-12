import { applyPatch, defaultRecipe, DEFAULT_GROUPS } from '@immich-raw/recipe';
import { describe, expect, it } from 'vitest';
import { DEFAULT_FOLDER, LIGHTROOM_FOLDER, MemoryPresetStorage, PresetStore, presetFolders, sanitizePatch, type XmpParser } from './presets.ts';

const store = () => new PresetStore(new MemoryPresetStorage());

function edited() {
  const r = defaultRecipe();
  r.basic.exposure = 0.7;
  r.basic.vibrance = 20;
  r.wb = { mode: 'custom', temp: 4300, tint: 8 };
  r.crop.angle = 3;
  return r;
}

describe('PresetStore', () => {
  it('creates a preset from the chosen groups and applies it to another recipe', async () => {
    const s = store();
    const p = await s.create('Warm pop', edited(), DEFAULT_GROUPS);
    expect(p.group).toBe(DEFAULT_FOLDER);
    expect(p.groups).toContain('wb');
    expect(p.groups).not.toContain('crop');
    const target = applyPatch(defaultRecipe(), p.patch);
    expect(target.basic.exposure).toBe(0.7);
    expect(target.wb).toEqual({ mode: 'custom', temp: 4300, tint: 8 });
    expect(target.crop.angle).toBe(0);
    expect(await s.list()).toHaveLength(1);
  });

  it('only stores the groups that were ticked', async () => {
    const p = await store().create('Only WB', edited(), ['wb']);
    expect(Object.keys(p.patch)).toEqual(['wb']);
  });

  it('renames, removes and sorts by folder then name', async () => {
    const s = store();
    const b = await s.create('b', edited(), ['tone'], 'Zeta');
    await s.create('a10', edited(), ['tone']);
    await s.create('a9', edited(), ['tone']);
    expect((await s.list()).map((p) => p.name)).toEqual(['a9', 'a10', 'b']);
    await s.rename(b.id, '  bee ');
    expect((await s.list()).find((p) => p.id === b.id)?.name).toBe('bee');
    expect(await s.rename(b.id, '   ')).toBeNull();
    await s.remove(b.id);
    expect(await s.list()).toHaveLength(2);
  });

  it('round-trips through the JSON export', async () => {
    const a = store();
    await a.create('One', edited(), DEFAULT_GROUPS);
    await a.create('Two', edited(), ['wb'], 'Travel');
    const blob = a.exportJson(await a.list());
    const file = new File([await blob.text()], 'presets.json', { type: 'application/json' });

    const b = store();
    const res = await b.importFiles([file]);
    expect(res.failed).toEqual([]);
    expect(res.imported.map((p) => p.name).sort()).toEqual(['One', 'Two']);
    const two = res.imported.find((p) => p.name === 'Two')!;
    expect(two.group).toBe('Travel');
    expect(two.source).toBe('import');
    expect(applyPatch(defaultRecipe(), two.patch).wb.temp).toBe(4300);
  });

  it('imports a single preset object or a bare array too', async () => {
    const s = store();
    const one = new File([JSON.stringify({ name: 'Solo', patch: { basic: { contrast: 15 } } })], 'solo.json');
    const arr = new File([JSON.stringify([{ name: 'A', patch: { profile: 'neutral' } }])], 'arr.json');
    const res = await s.importFiles([one, arr]);
    expect(res.imported.map((p) => p.name)).toEqual(['Solo', 'A']);
    expect(res.imported[0]!.groups).toEqual(['tone']);
  });

  it('imports Lightroom XMP through the injected parser', async () => {
    const parser: XmpParser = (text, filename) =>
      text.includes('crs:Exposure2012') ? { name: filename.replace('.xmp', ''), patch: { basic: { exposure: 1.2 }, junk: 1 } } : null;
    const s = store();
    const res = await s.importFiles(
      [new File(['<x crs:Exposure2012="+1.20"/>'], 'Moody.xmp'), new File(['<x/>'], 'Empty.xmp')],
      parser,
    );
    expect(res.imported).toHaveLength(1);
    expect(res.imported[0]).toMatchObject({ name: 'Moody', group: LIGHTROOM_FOLDER, source: 'lightroom', groups: ['tone'] });
    expect(res.imported[0]!.patch).toEqual({ basic: { exposure: 1.2 } });
    expect(res.failed).toEqual([{ file: 'Empty.xmp', reason: 'no develop settings found' }]);
  });

  it('reports files it cannot use', async () => {
    const s = store();
    const res = await s.importFiles([
      new File(['{oops'], 'broken.json'),
      new File(['{"hello":1}'], 'other.json'),
      new File(['x'], 'preset.xmp'),
      new File(['x'], 'photo.jpg'),
    ]);
    expect(res.imported).toEqual([]);
    expect(res.failed.map((f) => f.reason)).toEqual([
      'not valid JSON',
      'no presets found',
      'XMP import is not available',
      'unsupported file type (use .json or .xmp)',
    ]);
  });

  it('a throwing parser is reported, not fatal', async () => {
    const res = await store().importFiles([new File(['x'], 'bad.xmp')], () => {
      throw new Error('malformed XMP');
    });
    expect(res.failed).toEqual([{ file: 'bad.xmp', reason: 'malformed XMP' }]);
  });
});

describe('helpers', () => {
  it('sanitizePatch drops unknown paths', () => {
    expect(sanitizePatch({ basic: { exposure: 1, nope: 2 }, render: { assetId: 'x' }, profile: 'linear' })).toEqual({
      basic: { exposure: 1 },
      profile: 'linear',
    });
    expect(sanitizePatch(null)).toEqual({});
  });

  it('lists the default folder first', () => {
    expect(presetFolders([])).toEqual([DEFAULT_FOLDER]);
    const folders = presetFolders([{ group: 'B' }, { group: 'A' }, { group: DEFAULT_FOLDER }] as never);
    expect(folders).toEqual([DEFAULT_FOLDER, 'A', 'B']);
  });
});
