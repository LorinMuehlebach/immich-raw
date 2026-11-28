import { describe, expect, it } from 'vitest';
import { avifCicp, setAvifCicp } from './avif.ts';

const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const payload = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(8 + payload);
  new DataView(out.buffer).setUint32(0, out.length);
  out.set(ascii(type), 4);
  let o = 8;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const u16 = (...v: number[]) => Uint8Array.from(v.flatMap((n) => [n >> 8, n & 0xff]));
const nclx = (primaries: number, transfer: number, matrix: number) => box('colr', ascii('nclx'), u16(primaries, transfer, matrix), Uint8Array.of(0x80));

/** ftyp + meta (full box) > iprp > ipco with ispe, an ICC colr and an nclx colr, + mdat. */
function avif(...colr: Uint8Array[]): Uint8Array {
  const ipco = box('ipco', box('ispe', new Uint8Array(12)), box('colr', ascii('prof'), Uint8Array.of(1, 2, 3)), ...colr);
  const meta = box('meta', new Uint8Array(4), box('hdlr', new Uint8Array(25)), box('iprp', ipco, box('ipma', new Uint8Array(8))));
  return Uint8Array.from([...box('ftyp', ascii('avif'), new Uint8Array(4), ascii('mif1')), ...meta, ...box('mdat', Uint8Array.of(9, 9))]);
}

describe('AVIF colour description', () => {
  it('reads and sets the primaries and transfer of every nclx box, keeping matrix and range', () => {
    const file = avif(nclx(2, 2, 6));
    expect(avifCicp(file)).toEqual([{ primaries: 2, transfer: 2, matrix: 6, fullRange: true }]);
    const set = setAvifCicp(file, { primaries: 12, transfer: 13 });
    expect(set.boxes).toBe(1);
    expect(avifCicp(set.bytes)).toEqual([{ primaries: 12, transfer: 13, matrix: 6, fullRange: true }]);
    expect(set.bytes.length).toBe(file.length);
    // The input is left alone.
    expect(avifCicp(file)[0]!.primaries).toBe(2);
  });

  it('reports when there is no nclx box to set', () => {
    const set = setAvifCicp(avif(), { primaries: 1, transfer: 13 });
    expect(set.boxes).toBe(0);
    expect(avifCicp(set.bytes)).toEqual([]);
  });

  it('rejects files that are not ISO BMFF images', () => {
    expect(() => avifCicp(box('mdat', Uint8Array.of(1)))).toThrow(/Not an AVIF/);
    expect(() => avifCicp(Uint8Array.of(0, 0, 0, 99, 0x66, 0x74, 0x79, 0x70))).toThrow(/runs past/);
  });
});
