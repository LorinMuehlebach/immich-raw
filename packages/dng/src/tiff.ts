// Little-endian TIFF writer: IFDs are built as tag lists, laid out once (sizes are known
// before any offset is), then written into a single buffer.

export const BYTE = 1;
export const ASCII = 2;
export const SHORT = 3;
export const LONG = 4;
export const RATIONAL = 5;
export const UNDEFINED = 7;
export const SLONG = 9;
export const SRATIONAL = 10;
export const FLOAT = 11;
export const DOUBLE = 12;

/** Bytes per value, by TIFF type. */
export const TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4];

const encoder = new TextEncoder();

interface Field {
  tag: number;
  type: number;
  count: number;
  data: Uint8Array;
  /** Absolute file offset of the value bytes (inline or not), set by layout. */
  pos: number;
}

/**
 * Rational for v with |error| <= 1e-7 * max(1, |v|), preferring a short form so values that
 * came through float32 come back as written: a fraction with a denominator up to 1000
 * (1/3, 1/250), else a decimal fraction (0.6722 -> 6722/10000), else the closest continued
 * fraction convergent.
 */
export function toRational(v: number, signed: boolean): [number, number] {
  if (!Number.isFinite(v)) throw new Error(`Cannot store ${v} as a rational`);
  const maxNum = signed ? 0x7fffffff : 0xffffffff;
  const neg = v < 0;
  if (neg && !signed) throw new Error(`Cannot store ${v} as an unsigned rational`);
  const a = Math.abs(v);
  if (a > maxNum) throw new Error(`${v} is too large for a rational`);
  const tol = 1e-7 * Math.max(1, a);
  const cf = continuedFraction(a, tol, maxNum, signed ? 0x7fffffff : 0xffffffff);
  let best = cf;
  if (cf[1] > 1000) {
    for (let d = 10; d <= 1e9; d *= 10) {
      const n = Math.round(a * d);
      if (n > maxNum || (signed && d > 0x7fffffff)) break;
      if (Math.abs(n / d - a) <= tol) {
        best = [n, d];
        break;
      }
    }
  }
  return neg ? [-best[0], best[1]] : best;
}

function continuedFraction(a: number, tol: number, maxNum: number, maxDen: number): [number, number] {
  let [h0, h1, k0, k1] = [0, 1, 1, 0];
  let x = a;
  let best: [number, number] = [Math.round(a), 1];
  for (let i = 0; i < 40; i++) {
    const q = Math.floor(x);
    const h2 = q * h1 + h0;
    const k2 = q * k1 + k0;
    if (h2 > maxNum || k2 > maxDen) break;
    best = [h2, k2];
    if (Math.abs(h2 / k2 - a) <= tol) break;
    const frac = x - q;
    if (frac < 1e-15) break;
    x = 1 / frac;
    [h0, h1, k0, k1] = [h1, h2, k1, k2];
  }
  return best;
}

export class Ifd {
  fields: Field[] = [];
  /** File offset of the IFD, set by layout. */
  offset = 0;

  private add(tag: number, type: number, count: number, data: Uint8Array): void {
    if (this.fields.some((f) => f.tag === tag)) throw new Error(`Tag ${tag} added twice`);
    this.fields.push({ tag, type, count, data, pos: 0 });
  }

  bytes(tag: number, type: typeof BYTE | typeof UNDEFINED, data: Uint8Array): void {
    this.add(tag, type, data.length, data);
  }

  /** Null-terminated string. Written as BYTE when it is not plain ASCII (allowed for the UTF-8 DNG tags). */
  ascii(tag: number, s: string, utf8AsByte = false): void {
    const b = encoder.encode(s);
    const data = new Uint8Array(b.length + 1);
    data.set(b);
    const type = utf8AsByte && /[^\x00-\x7f]/.test(s) ? BYTE : ASCII;
    this.add(tag, type, data.length, data);
  }

  shorts(tag: number, values: number[]): void {
    const data = new Uint8Array(values.length * 2);
    const dv = new DataView(data.buffer);
    values.forEach((v, i) => {
      if (!(v >= 0 && v <= 0xffff && Number.isInteger(v))) throw new Error(`Tag ${tag}: ${v} is not a SHORT`);
      dv.setUint16(i * 2, v, true);
    });
    this.add(tag, SHORT, values.length, data);
  }

  longs(tag: number, values: number[]): void {
    const data = new Uint8Array(values.length * 4);
    const dv = new DataView(data.buffer);
    values.forEach((v, i) => {
      if (!(v >= 0 && v <= 0xffffffff && Number.isInteger(v))) throw new Error(`Tag ${tag}: ${v} is not a LONG`);
      dv.setUint32(i * 4, v, true);
    });
    this.add(tag, LONG, values.length, data);
  }

  rationals(tag: number, values: number[], signed = false): void {
    const data = new Uint8Array(values.length * 8);
    const dv = new DataView(data.buffer);
    values.forEach((v, i) => {
      const [n, d] = toRational(v, signed);
      if (signed) dv.setInt32(i * 8, n, true);
      else dv.setUint32(i * 8, n, true);
      dv.setUint32(i * 8 + 4, d, true);
    });
    this.add(tag, signed ? SRATIONAL : RATIONAL, values.length, data);
  }

  /** Rational with a fixed denominator (EXIF values cameras write as e.g. x/10). */
  rationalFixed(tag: number, values: number[], den: number): void {
    const data = new Uint8Array(values.length * 8);
    const dv = new DataView(data.buffer);
    values.forEach((v, i) => {
      dv.setUint32(i * 8, Math.round(v * den), true);
      dv.setUint32(i * 8 + 4, den, true);
    });
    this.add(tag, RATIONAL, values.length, data);
  }

  /** Overwrites the values of a LONG field added earlier with the same count (for offsets known after layout). */
  setLongs(tag: number, values: number[]): void {
    const f = this.fields.find((x) => x.tag === tag);
    if (!f || f.type !== LONG || f.count !== values.length) throw new Error(`Tag ${tag} has no LONG placeholder for ${values.length} values`);
    const dv = new DataView(f.data.buffer, f.data.byteOffset, f.data.byteLength);
    values.forEach((v, i) => dv.setUint32(i * 4, v, true));
  }

  has(tag: number): boolean {
    return this.fields.some((f) => f.tag === tag);
  }
}

const align2 = (n: number) => (n + 1) & ~1;

/**
 * Assigns offsets to the IFDs and their out-of-line values, starting at `start`, in order.
 * Returns the end offset.
 */
export function layoutIfds(ifds: Ifd[], start: number): number {
  let pos = start;
  for (const ifd of ifds) {
    ifd.fields.sort((a, b) => a.tag - b.tag);
    pos = align2(pos);
    ifd.offset = pos;
    pos += 2 + ifd.fields.length * 12 + 4;
    ifd.fields.forEach((f, i) => {
      if (f.data.length <= 4) f.pos = ifd.offset + 2 + i * 12 + 8;
      else {
        pos = align2(pos);
        f.pos = pos;
        pos += f.data.length;
      }
    });
  }
  return pos;
}

/** Writes laid-out IFDs (next-IFD offset 0) into `out`. */
export function writeIfds(out: Uint8Array, ifds: Ifd[]): void {
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  for (const ifd of ifds) {
    dv.setUint16(ifd.offset, ifd.fields.length, true);
    ifd.fields.forEach((f, i) => {
      const e = ifd.offset + 2 + i * 12;
      dv.setUint16(e, f.tag, true);
      dv.setUint16(e + 2, f.type, true);
      dv.setUint32(e + 4, f.count, true);
      if (f.data.length > 4) dv.setUint32(e + 8, f.pos, true);
      out.set(f.data, f.pos);
    });
    dv.setUint32(ifd.offset + 2 + ifd.fields.length * 12, 0, true);
  }
}

export { align2 };
