import { describe, expect, it } from 'vitest';
import {
  applyLookCpu,
  buildToneLut,
  cubeAt,
  cubeTexels,
  dngHsvToRgb,
  dngRgbToHsv,
  hueSatAt,
  hueSatTexels,
  parseCubeLut,
  parseDcpLookTableXml,
  parseDcpToneCurveXml,
  toneLutAt,
  type HueSatTable,
} from './dcp.ts';
import type { Vec3 } from './matrices.ts';

/** A dcpTool-style fragment; `node(h, s, v)` gives [hueShift, satScale, valScale]. */
function tableXml(H: number, S: number, V: number, node: (h: number, s: number, v: number) => number[], { shuffle = false } = {}) {
  const lines: string[] = [];
  for (let h = 0; h < H; h++) {
    for (let s = 0; s < S; s++) {
      for (let v = 0; v < V; v++) {
        const [a, b, c] = node(h, s, v);
        lines.push(`    <Element HueDiv="${h}" SatDiv="${s}" ValDiv="${v}" HueShift="${a}" SatScale="${b}" ValScale="${c}"/>`);
      }
    }
  }
  if (shuffle) lines.reverse();
  return `  <LookTable hueDivisions="${H}" satDivisions="${S}" valDivisions="${V}">\n${lines.join('\n')}\n  </LookTable>`;
}

const curveXml = (pts: [number, number][]) =>
  `  <ToneCurve Size="${pts.length}">\n${pts.map(([h, v], n) => `    <Element N="${n}" h="${h}" v="${v}" />`).join('\n')}\n  </ToneCurve>`;

/** A constant table of the given size. */
function constTable(hue: number, sat: number, val: number, H = 6, S = 3, V = 4): HueSatTable {
  return parseDcpLookTableXml(tableXml(H, S, V, () => [hue, sat, val]));
}

const close3 = (a: Vec3, b: Vec3, digits = 6) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, digits));
const encode = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
const decode = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

describe('parseDcpLookTableXml', () => {
  it('places every node by its indices, in any order', () => {
    const t = parseDcpLookTableXml(tableXml(3, 2, 2, (h, s, v) => [h, 1 + s, 1 + v / 10], { shuffle: true }));
    expect([t.hueDivisions, t.satDivisions, t.valDivisions, t.srgbValues]).toEqual([3, 2, 2, true]);
    const at = (h: number, s: number, v: number) => Array.from(t.data.slice(((v * 3 + h) * 2 + s) * 3, ((v * 3 + h) * 2 + s) * 3 + 3));
    expect(at(2, 1, 1)).toEqual([2, 2, Math.fround(1.1)]);
    expect(at(1, 0, 0)).toEqual([1, 1, 1]);
  });

  it('rejects missing, duplicated or broken nodes', () => {
    const full = tableXml(2, 2, 2, () => [0, 1, 1]);
    expect(() => parseDcpLookTableXml(full.replace(/<Element[^>]*\/>\n/, ''))).toThrow(/7 of 8/);
    expect(() => parseDcpLookTableXml(full.replace('HueDiv="1" SatDiv="0" ValDiv="0"', 'HueDiv="0" SatDiv="0" ValDiv="0"'))).toThrow(/twice/);
    expect(() => parseDcpLookTableXml(full.replace('HueDiv="1"', 'HueDiv="5"'))).toThrow(/range/);
    expect(() => parseDcpLookTableXml(full.replace('SatScale="1"', 'SatScale="abc"'))).toThrow(/SatScale/);
    expect(() => parseDcpLookTableXml('<ToneCurve></ToneCurve>')).toThrow(/LookTable/);
  });
});

describe('parseDcpToneCurveXml', () => {
  it('reads the points in order', () => {
    const c = parseDcpToneCurveXml(curveXml([[0, 0], [0.5, 0.6], [1, 1]]));
    expect(Array.from(c)).toEqual([0, 0, 0.5, Math.fround(0.6), 1, 1]);
  });

  it('rejects curves that do not run from (0,0) to (1,1) or go backwards', () => {
    expect(() => parseDcpToneCurveXml(curveXml([[0, 0.1], [1, 1]]))).toThrow(/\(0,0\)/);
    expect(() => parseDcpToneCurveXml(curveXml([[0, 0], [0.6, 0.5], [0.5, 0.6], [1, 1]]))).toThrow(/increase/);
    expect(() => parseDcpToneCurveXml(curveXml([[0, 0], [1, 1]]).replace('Size="2"', 'Size="3"'))).toThrow(/2 of 3/);
  });
});

describe('parseCubeLut', () => {
  const identity2 = ['# made by hand', 'TITLE "identity"', 'LUT_3D_SIZE 2', 'DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 1 1 1'];
  for (let b = 0; b < 2; b++) for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++) identity2.push(`${r}.00000 ${g}.0 ${b}`);

  it('reads a size-2 identity with comments, TITLE and DOMAIN lines', () => {
    const c = parseCubeLut(identity2.join('\r\n'));
    expect(c.size).toBe(2);
    expect(Array.from(c.data.slice(3, 6))).toEqual([1, 0, 0]); // red runs fastest
    close3(cubeAt(c, [0.25, 0.5, 0.75]), [0.25, 0.5, 0.75]);
    expect(Array.from(cubeTexels(c).slice(4, 8))).toEqual([1, 0, 0, 1]);
  });

  it('rejects wrong sizes and domains', () => {
    expect(() => parseCubeLut(identity2.slice(0, -1).join('\n'))).toThrow(/7 of 8/);
    expect(() => parseCubeLut(identity2.join('\n').replace('DOMAIN_MAX 1 1 1', 'DOMAIN_MAX 2 2 2'))).toThrow(/DOMAIN_MAX/);
    expect(() => parseCubeLut('LUT_1D_SIZE 4\n0 0 0')).toThrow(/1D/);
  });
});

describe('DNG HSV', () => {
  it('round-trips colours', () => {
    const colours: Vec3[] = [[0.5, 0.2, 0.1], [0.1, 0.6, 0.3], [0.2, 0.3, 0.9], [0.7, 0.1, 0.6], [1.4, 1.2, 0.3], [0.3, 0.3, 0.3]];
    for (const c of colours) close3(dngHsvToRgb(dngRgbToHsv(c)), c, 9);
    expect(dngRgbToHsv([1, 0, 0])[0]).toBe(0);
    expect(dngRgbToHsv([0, 1, 0])[0]).toBe(2);
    expect(dngRgbToHsv([0, 0, 1])[0]).toBe(4);
    close3(dngHsvToRgb([6.5, 1, 1]), dngHsvToRgb([0.5, 1, 1]));
  });
});

describe('applyLookCpu', () => {
  const colours: Vec3[] = [[0.5, 0.2, 0.1], [0.05, 0.4, 0.2], [0.2, 0.3, 0.9], [0.18, 0.18, 0.18], [0.9, 0.85, 0.2]];

  it('leaves colours alone with an identity table, or at Amount 0', () => {
    for (const c of colours) close3(applyLookCpu(constTable(0, 1, 1), c), c);
    const strong = constTable(30, 1.5, 0.8);
    for (const c of colours) close3(applyLookCpu(strong, c, 0), c);
  });

  it('shifts hue, scales saturation (up to 1) and value', () => {
    const [h, s, v] = dngRgbToHsv([0.5, 0.2, 0.1]);
    const [h2, s2] = dngRgbToHsv(applyLookCpu(constTable(60, 1.5, 1), [0.5, 0.2, 0.1]));
    expect(h2).toBeCloseTo(h + 1, 6);
    expect(s2).toBeCloseTo(Math.min(1, s * 1.5), 6);
    expect(dngRgbToHsv(applyLookCpu(constTable(0, 1, 1), [0.5, 0.2, 0.1]))[2]).toBeCloseTo(v, 9);
  });

  it('scales the encoded value and pins it at white, like the DNG SDK, for v <= 1', () => {
    for (const valScale of [0.7, 1.2]) {
      for (const v of [0.05, 0.3, 0.9]) {
        const out = applyLookCpu(constTable(0, 1, valScale), [v, v * 0.5, v * 0.25]);
        expect(Math.max(...out)).toBeCloseTo(decode(Math.min(encode(v) * valScale, 1)), 6);
      }
    }
  });

  it('keeps headroom above 1, and passes negative parts through', () => {
    close3(applyLookCpu(constTable(0, 1, 1), [1.4, 0.7, 0.3]), [1.4, 0.7, 0.3]);
    close3(applyLookCpu(constTable(0, 1, 1), [-0.05, 0.5, 0.2]), [-0.05, 0.5, 0.2]);
  });

  it('interpolates hue across the wrap from the last division to the first', () => {
    // 6 hue divisions, 60° apart: +10° at division 5 (300°), 0 elsewhere.
    const t = parseDcpLookTableXml(tableXml(6, 2, 2, (h) => [h === 5 ? 10 : 0, 1, 1]));
    expect(hueSatAt(t, 5.5, 0.5, 0.5)[0]).toBeCloseTo(5, 6); // halfway from 300° to 360°
    expect(hueSatAt(t, 5, 0.5, 0.5)[0]).toBeCloseTo(10, 6);
    expect(hueSatAt(t, 0, 0.5, 0.5)[0]).toBeCloseTo(0, 6);
  });

  it('extrapolates the change with Amount above 100 %', () => {
    const [h] = dngRgbToHsv([0.5, 0.2, 0.1]);
    expect(dngRgbToHsv(applyLookCpu(constTable(12, 1, 1), [0.5, 0.2, 0.1], 2))[0]).toBeCloseTo(h + (24 * 6) / 360, 6);
  });
});

describe('hueSatTexels', () => {
  it('keeps the DNG order: saturation fastest, then hue, then value', () => {
    const t = parseDcpLookTableXml(tableXml(3, 2, 2, (h, s, v) => [h, s, v]));
    const tex = hueSatTexels(t);
    const at = (h: number, s: number, v: number) => Array.from(tex.slice(((v * 3 + h) * 2 + s) * 4, ((v * 3 + h) * 2 + s) * 4 + 4));
    expect(at(2, 1, 0)).toEqual([2, 1, 0, 1]);
    expect(at(1, 0, 1)).toEqual([1, 0, 1, 1]);
  });
});

describe('buildToneLut', () => {
  const identity = Float32Array.from([0, 0, 1, 1]);

  it('clips at 1 without a knee, and is monotone', () => {
    const t = buildToneLut(identity, { knee: 1 });
    for (const x of [0, 0.001, 0.18, 0.5, 0.99]) expect(toneLutAt(t, x)).toBeCloseTo(x, 3);
    expect(toneLutAt(t, 1.5)).toBe(1);
    expect(t.whitePoint).toBeCloseTo(0.995, 2);
    for (let i = 1; i < t.lut.length; i++) expect(t.lut[i]).toBeGreaterThanOrEqual(t.lut[i - 1]!);
  });

  it('rolls highlights off above the knee instead of clipping', () => {
    const t = buildToneLut(identity, { knee: 0.8 });
    expect(toneLutAt(t, 0.5)).toBeCloseTo(0.5, 3);
    expect(toneLutAt(t, 1)).toBeGreaterThan(0.9);
    expect(toneLutAt(t, 1)).toBeLessThan(0.99);
    expect(toneLutAt(t, 1.2)).toBeGreaterThan(toneLutAt(t, 1));
    expect(t.whitePoint).toBeGreaterThan(1);
  });

  it('follows the curve', () => {
    const t = buildToneLut(Float32Array.from([0, 0, 0.25, 0.1, 0.5, 0.45, 0.75, 0.82, 1, 1]), { knee: 1 });
    expect(toneLutAt(t, 0.25)).toBeCloseTo(0.1, 3);
    expect(toneLutAt(t, 0.5)).toBeCloseTo(0.45, 3);
  });
});
