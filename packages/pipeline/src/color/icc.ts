// ICC profiles for exports in a colour space other than sRGB: small matrix/TRC display profiles
// (ICC.1 version 2.4, class 'mntr', RGB to XYZ). Version 2 with 'curv' curves because some
// colour-managed viewers (Firefox by default) ignore version 4 profiles. The bytes are fixed
// for each space (no creation time), so identical exports stay byte-identical.
import { ICC_D50, OUTPUT_SPACE_INFO, type OutputSpace } from './output-spaces.ts';

/** A fixed creation date: 2026-01-01 00:00:00. */
const DATE = [2026, 1, 1, 0, 0, 0];
const COPYRIGHT = 'No copyright, use freely';
/** Entries of the sRGB curve, written as a table (version 2 has no parametric curves). */
const SRGB_CURVE_POINTS = 1024;

const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0x7f);
const s15f16 = (v: number) => Math.round(v * 65536) | 0;

function xyzType(v: readonly number[]): Uint8Array {
  const out = new Uint8Array(20);
  const dv = new DataView(out.buffer);
  out.set(ascii('XYZ '), 0);
  for (let i = 0; i < 3; i++) dv.setInt32(8 + i * 4, s15f16(v[i]!));
  return out;
}

/** textDescriptionType: ASCII, then empty Unicode and ScriptCode parts. */
function descType(text: string): Uint8Array {
  const a = ascii(text);
  const out = new Uint8Array(12 + a.length + 1 + 4 + 4 + 2 + 1 + 67);
  const dv = new DataView(out.buffer);
  out.set(ascii('desc'), 0);
  dv.setUint32(8, a.length + 1);
  out.set(a, 12);
  return out;
}

function textType(text: string): Uint8Array {
  const a = ascii(text);
  const out = new Uint8Array(8 + a.length + 1);
  out.set(ascii('text'), 0);
  out.set(a, 8);
  return out;
}

function curveType(space: OutputSpace): Uint8Array {
  const gamma = OUTPUT_SPACE_INFO[space].gamma;
  const count = gamma === null ? SRGB_CURVE_POINTS : 1;
  const out = new Uint8Array(12 + count * 2);
  const dv = new DataView(out.buffer);
  out.set(ascii('curv'), 0);
  dv.setUint32(8, count);
  if (gamma !== null) {
    // u8Fixed8Number.
    dv.setUint16(12, Math.round(gamma * 256));
  } else {
    // Encoded value -> linear, as the profile maps device values to the PCS.
    const linear = (e: number) => (e <= 0.04045 ? e / 12.92 : ((e + 0.055) / 1.055) ** 2.4);
    for (let i = 0; i < count; i++) dv.setUint16(12 + i * 2, Math.round(linear(i / (count - 1)) * 65535));
  }
  return out;
}

const cache = new Map<OutputSpace, Uint8Array>();

/** The ICC profile of an output colour space. */
export function iccProfile(space: OutputSpace): Uint8Array {
  const hit = cache.get(space);
  if (hit) return hit;
  const info = OUTPUT_SPACE_INFO[space];
  const m = info.toPcs;
  const curve = curveType(space);
  const tags: [string, Uint8Array][] = [
    ['desc', descType(info.description)],
    ['cprt', textType(COPYRIGHT)],
    ['wtpt', xyzType(ICC_D50)],
    ['rXYZ', xyzType([m[0]!, m[3]!, m[6]!])],
    ['gXYZ', xyzType([m[1]!, m[4]!, m[7]!])],
    ['bXYZ', xyzType([m[2]!, m[5]!, m[8]!])],
    // The three curves share one element.
    ['rTRC', curve],
    ['gTRC', curve],
    ['bTRC', curve],
  ];

  // Layout: header, tag table, then each distinct element, 4-byte aligned.
  const tableEnd = 128 + 4 + tags.length * 12;
  const at = new Map<Uint8Array, number>();
  let pos = tableEnd;
  for (const [, data] of tags) {
    if (at.has(data)) continue;
    pos = (pos + 3) & ~3;
    at.set(data, pos);
    pos += data.length;
  }
  const size = (pos + 3) & ~3;

  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, size);
  dv.setUint32(8, 0x02400000); // version 2.4.0
  out.set(ascii('mntr'), 12);
  out.set(ascii('RGB '), 16);
  out.set(ascii('XYZ '), 20);
  DATE.forEach((v, i) => dv.setUint16(24 + i * 2, v));
  out.set(ascii('acsp'), 36);
  // 64: rendering intent 0 (perceptual). 68: the PCS illuminant.
  for (let i = 0; i < 3; i++) dv.setInt32(68 + i * 4, s15f16(ICC_D50[i]!));
  dv.setUint32(128, tags.length);
  tags.forEach(([sig, data], i) => {
    const e = 132 + i * 12;
    out.set(ascii(sig), e);
    dv.setUint32(e + 4, at.get(data)!);
    dv.setUint32(e + 8, data.length);
  });
  for (const [data, offset] of at) out.set(data, offset);
  cache.set(space, out);
  return out;
}
