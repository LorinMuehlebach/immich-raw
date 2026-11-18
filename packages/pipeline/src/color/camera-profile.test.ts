import { describe, expect, it } from 'vitest';
import {
  cameraLookTable,
  cameraProfileFromJson,
  cameraProfileToJson,
  illuminantWeight,
  parseDcp,
  type CameraProfileData,
  type CameraProfileTable,
} from './camera-profile.ts';
import { profileUniforms, resolveProfile } from './profiles.ts';

// --- A synthetic .dcp ---------------------------------------------------------------------

const u16 = (n: number) => [n & 255, (n >> 8) & 255];
const u32 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
const f32 = (values: ArrayLike<number>) =>
  Array.from(values).flatMap((x) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setFloat32(0, x, true);
    return [...b];
  });
const text = (s: string) => [...[...s].map((c) => c.charCodeAt(0)), 0];

interface Entry {
  tag: number;
  type: number;
  count: number;
  data: number[];
}

const TYPE = { ascii: 2, short: 3, long: 4, float: 11 };

/** A DCP: "II", 0x4352, then an IFD with the tags and their out-of-line data. */
function dcpFile(entries: Entry[]): Uint8Array {
  const sorted = [...entries].sort((a, b) => a.tag - b.tag);
  const head = 8 + 2 + sorted.length * 12 + 4;
  const out: number[] = [0x49, 0x49, 0x52, 0x43, ...u32(8), ...u16(sorted.length)];
  const extra: number[] = [];
  for (const e of sorted) {
    out.push(...u16(e.tag), ...u16(e.type), ...u32(e.count));
    if (e.data.length <= 4) out.push(...e.data, ...new Array<number>(4 - e.data.length).fill(0));
    else {
      out.push(...u32(head + extra.length));
      extra.push(...e.data);
    }
  }
  return Uint8Array.from([...out, 0, 0, 0, 0, ...extra]);
}

const ascii = (tag: number, s: string): Entry => ({ tag, type: TYPE.ascii, count: s.length + 1, data: text(s) });
const shortE = (tag: number, v: number): Entry => ({ tag, type: TYPE.short, count: 1, data: u16(v) });
const dimsE = (tag: number, dims: number[]): Entry => ({ tag, type: TYPE.long, count: 3, data: dims.flatMap(u32) });
const floatsE = (tag: number, v: ArrayLike<number>): Entry => ({ tag, type: TYPE.float, count: v.length, data: f32(v) });

/** Nodes of a table (hue shift 0, saturation scale `sat`, value scale 1). */
const flat = (nodes: number, sat: number) => Float32Array.from({ length: nodes * 3 }, (_, i) => (i % 3 === 1 ? sat : i % 3 === 2 ? 1 : 0));

const TAGS = { model: 50708, i1: 50778, i2: 50779, name: 50936, hsDims: 50937, hs1: 50938, hs2: 50939, lkDims: 50981, lk: 50982, hsEnc: 51107, lkEnc: 51108 };

function sampleDcp(opts: { second?: boolean; look?: boolean; lookSrgb?: boolean } = {}): Uint8Array {
  const entries: Entry[] = [
    ascii(TAGS.model, 'Fujifilm X-T30'),
    ascii(TAGS.name, 'Adobe Standard'),
    shortE(TAGS.i1, 17),
    shortE(TAGS.i2, 21),
    dimsE(TAGS.hsDims, [4, 3, 1]),
    floatsE(TAGS.hs1, flat(12, 1)),
  ];
  if (opts.second ?? true) entries.push(floatsE(TAGS.hs2, flat(12, 2)));
  if (opts.look ?? true) {
    entries.push(dimsE(TAGS.lkDims, [4, 3, 2]), floatsE(TAGS.lk, flat(24, 1)));
    if (opts.lookSrgb) entries.push({ tag: TAGS.lkEnc, type: TYPE.long, count: 1, data: u32(1) });
  }
  return dcpFile(entries);
}

const table = (dims: [number, number, number], sat: number, srgbValues = false): CameraProfileTable => ({ dims, srgbValues, data: flat(dims[0] * dims[1] * dims[2], sat) });

describe('parseDcp', () => {
  it('reads the names, illuminants and tables', () => {
    const p = parseDcp(sampleDcp());
    expect(p).toMatchObject({ schema: 1, model: 'Fujifilm X-T30', name: 'Adobe Standard', illuminants: [17, 21] });
    expect(p.hueSat?.first.dims).toEqual([4, 3, 1]);
    expect(p.hueSat?.first.data).toHaveLength(36);
    expect(p.hueSat?.first.data[1]).toBe(1);
    expect(p.hueSat?.second?.data[1]).toBe(2);
    expect(p.look?.dims).toEqual([4, 3, 2]);
    expect(p.look?.srgbValues).toBe(false);
  });

  it('reads the table encoding, and a profile with one illuminant or no look', () => {
    expect(parseDcp(sampleDcp({ lookSrgb: true })).look?.srgbValues).toBe(true);
    const single = parseDcp(sampleDcp({ second: false, look: false }));
    expect(single.hueSat?.second).toBeNull();
    expect(single.look).toBeNull();
  });

  it('refuses files that are not camera profiles', () => {
    expect(() => parseDcp(new Uint8Array(0))).toThrow(/Not a camera profile/);
    const tiff = Uint8Array.from(sampleDcp());
    tiff[2] = 42; // a TIFF, not a DCP
    tiff[3] = 0;
    expect(() => parseDcp(tiff)).toThrow(/Not a camera profile/);
    expect(() => parseDcp(Uint8Array.from([0x49, 0x49, 0x52, 0x43, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toThrow(/no hue\/saturation map or look table/);
  });

  it('copes with a cut-off file', () => {
    const good = sampleDcp();
    for (const cut of [10, 40, 120, good.length - 30]) expect(() => parseDcp(good.slice(0, cut))).toThrow();
  });
});

describe('the converted file', () => {
  it('round-trips through JSON', () => {
    const p = parseDcp(sampleDcp({ lookSrgb: true }));
    const back = cameraProfileFromJson(cameraProfileToJson(p));
    expect(back).toEqual(p);
  });

  it('round-trips a profile without a second map or a look', () => {
    const p = parseDcp(sampleDcp({ second: false, look: false }));
    expect(cameraProfileFromJson(cameraProfileToJson(p))).toEqual(p);
  });

  it('rejects anything else', () => {
    expect(() => cameraProfileFromJson('{}')).toThrow(/Not a converted camera profile/);
    expect(() => cameraProfileFromJson('[]')).toThrow();
    const json = JSON.parse(cameraProfileToJson(parseDcp(sampleDcp()))) as { hueSat: { first: { data: string } } };
    json.hueSat.first.data = 'AAAA';
    expect(() => cameraProfileFromJson(JSON.stringify(json))).toThrow(/wrong size/);
  });
});

describe('illuminantWeight', () => {
  const p = { illuminants: [17, 21] as [number, number] };

  it('is 1 at illuminant A, 0 at D65, and blends by inverse temperature in between', () => {
    expect(illuminantWeight(p, 2856)).toBeCloseTo(1, 9);
    expect(illuminantWeight(p, 6504)).toBeCloseTo(0, 9);
    expect(illuminantWeight(p, 4500)).toBeCloseTo(0.3486, 3);
  });

  it('stays within 0..1 and uses the first map for odd input', () => {
    expect(illuminantWeight(p, 1500)).toBe(1);
    expect(illuminantWeight(p, 12000)).toBe(0);
    expect(illuminantWeight(p, 0)).toBe(1);
    expect(illuminantWeight({ illuminants: [99, 21] }, 4500)).toBe(1);
  });
});

describe('cameraLookTable', () => {
  const profile = (over: Partial<CameraProfileData> = {}): CameraProfileData => ({
    schema: 1,
    model: 'X',
    name: 'Adobe Standard',
    illuminants: [17, 21],
    hueSat: { first: table([4, 3, 1], 1), second: table([4, 3, 1], 2) },
    look: table([4, 3, 2], 1),
    ...over,
  });

  it('Adobe Standard is the hue/saturation map blended for the colour temperature', () => {
    const t = cameraLookTable(profile(), 'standard', 4500)!;
    expect(t).toMatchObject({ hueDivisions: 4, satDivisions: 3, valDivisions: 1, srgbValues: false });
    // 0.3486 of the first (scale 1) and the rest of the second (scale 2)
    expect(t.data[1]).toBeCloseTo(0.3486 + 2 * (1 - 0.3486), 3);
    expect(cameraLookTable(profile(), 'standard', 2856)!.data[1]).toBeCloseTo(1, 6);
    expect(cameraLookTable(profile(), 'standard', 6504)!.data[1]).toBeCloseTo(2, 6);
  });

  it('a single-illuminant profile is used as it is', () => {
    const t = cameraLookTable(profile({ hueSat: { first: table([4, 3, 1], 1.4), second: null } }), 'standard', 3000)!;
    expect(t.data[1]).toBeCloseTo(1.4, 6);
  });

  it('Adobe Color folds the look table in after the map, on the look table grid', () => {
    const t = cameraLookTable(profile({ hueSat: { first: table([4, 3, 1], 1.5), second: null } }), 'color', 5000)!;
    expect(t).toMatchObject({ hueDivisions: 4, satDivisions: 3, valDivisions: 2 });
    // node (value 1, hue 0, saturation 0.5): the map takes saturation 0.5 to 0.75, the identity look leaves it
    const at = (v: number, h: number, s: number) => (v * 4 + h) * 3 * 3 + s * 3;
    expect(t.data[at(1, 0, 1) + 1]).toBeCloseTo(1.5, 5);
    expect(t.data[at(1, 0, 1)]).toBeCloseTo(0, 5); // no hue shift
    expect(t.data[at(1, 0, 1) + 2]).toBeCloseTo(1, 5); // no value change
    // the black row and the grey column have nothing to scale
    expect(Array.from(t.data.slice(at(0, 0, 1), at(0, 0, 1) + 3))).toEqual([0, 1, 1]);
    expect(Array.from(t.data.slice(at(1, 2, 0), at(1, 2, 0) + 3))).toEqual([0, 1, 1]);
  });

  it('Adobe Color without a look table is the map alone, and nothing at all gives null', () => {
    const noLook = profile({ look: null });
    expect(cameraLookTable(noLook, 'color', 4500)).toEqual(cameraLookTable(noLook, 'standard', 4500));
    expect(cameraLookTable(profile({ hueSat: null, look: null }), 'standard', 4500)).toBeNull();
    expect(cameraLookTable(profile({ hueSat: null }), 'color', 4500)).toMatchObject({ valDivisions: 2 });
  });
});

describe('camera profiles in the profile list', () => {
  it('render as the in-house Color until the camera profile is loaded (Standard is then flagged missing)', () => {
    expect(resolveProfile('color')).toMatchObject({ id: 'color', requested: 'color', missing: false, base: 0, adobeBase: true });
    const p = resolveProfile('standard');
    expect(p).toMatchObject({ id: 'color', requested: 'standard', missing: true, base: 0 });
    expect(profileUniforms(p, 100)).toEqual(profileUniforms(resolveProfile('color'), 100));
  });

  it('take the camera profile\'s colour once it is loaded; Standard blends in with the Amount, Color has none', () => {
    const lookTable = cameraLookTable(parseDcp(sampleDcp()), 'color', 4500)!;
    const standard = resolveProfile('standard', { standard: { key: 'standard@4500', lookTable } });
    expect(standard).toMatchObject({ id: 'standard', requested: 'standard', missing: false, base: 0, amount: true });
    expect(profileUniforms(standard, 100)).toMatchObject({ uLook: 1, uLookAmount: 1, uLookSrgb: 0, uProfileCurve: 0, uFilmLut: 0 });
    expect(profileUniforms(standard, 60)).toMatchObject({ uLook: 1, uLookAmount: 0.6 });
    expect(profileUniforms(standard, 0).uLook).toBe(0); // 0 % is exactly Color

    // Color never reads the camera's profile: it has its own colour.
    const color = resolveProfile('color', { color: { key: 'color@4500', lookTable } });
    expect(color.look?.key).toBe('color-fitted');
    expect(color).toMatchObject({ id: 'color', missing: false, amount: false });
    expect(profileUniforms(color, 40)).toMatchObject({ uLook: 1, uLookAmount: 1, uBaseFix: 1 }); // no Amount: always in full
  });
});
