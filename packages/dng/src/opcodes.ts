// DNG opcode lists (DNG spec 1.7.1, chapter 7). Always big-endian, whatever the file's byte
// order: a 32-bit opcode count, then per opcode ID, DNG version, flags, parameter byte count
// and the parameters.

export const OPCODE_MAP_POLYNOMIAL = 8;

/** DNG version 1.3.0.0, packed like the opcode header field (and DNGVersion) does. */
export const DNG_1_3 = 0x01030000;

export interface Opcode {
  id: number;
  /** DNG version the opcode was defined in, packed one byte per tier (1.3.0.0 = 0x01030000). */
  version: number;
  /** Bit 0: optional, bit 1: may be skipped for previews. */
  flags: number;
  params: Uint8Array;
}

/**
 * Parses an opcode list, checking that every opcode fits inside it. Bytes after the last
 * opcode are ignored (readers only follow the count).
 */
export function parseOpcodeList(bytes: Uint8Array): Opcode[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 4) throw new Error('Opcode list is shorter than its header');
  const count = dv.getUint32(0);
  const ops: Opcode[] = [];
  let p = 4;
  for (let i = 0; i < count; i++) {
    if (p + 16 > bytes.length) throw new Error(`Opcode list truncated at opcode ${i}`);
    const size = dv.getUint32(p + 12);
    if (p + 16 + size > bytes.length) throw new Error(`Opcode ${i} parameters run past the list`);
    ops.push({ id: dv.getUint32(p), version: dv.getUint32(p + 4), flags: dv.getUint32(p + 8), params: bytes.subarray(p + 16, p + 16 + size) });
    p += 16 + size;
  }
  return ops;
}

export function buildOpcodeList(ops: Opcode[]): Uint8Array {
  const out = new Uint8Array(4 + ops.reduce((s, o) => s + 16 + o.params.length, 0));
  const dv = new DataView(out.buffer);
  dv.setUint32(0, ops.length);
  let p = 4;
  for (const o of ops) {
    dv.setUint32(p, o.id);
    dv.setUint32(p + 4, o.version);
    dv.setUint32(p + 8, o.flags);
    dv.setUint32(p + 12, o.params.length);
    out.set(o.params, p + 16);
    p += 16 + o.params.length;
  }
  return out;
}

/**
 * One required MapPolynomial per plane over the whole width x height image.
 * One opcode per plane (Plane = p, Planes = 1) rather than one with Planes = 3: LibRaw's
 * lossy_dng_load_raw only reads Plane and fills that channel's curve, ignoring Planes.
 */
export function mapPolynomialOpcodes(width: number, height: number, planes: number, coefficients: readonly number[]): Opcode[] {
  const degree = coefficients.length - 1;
  if (degree < 0 || degree > 8) throw new Error('MapPolynomial degree must be 0..8');
  const ops: Opcode[] = [];
  for (let plane = 0; plane < planes; plane++) {
    const params = new Uint8Array(36 + 8 * (degree + 1));
    const dv = new DataView(params.buffer);
    // Top, Left, Bottom, Right, Plane, Planes, RowPitch, ColPitch, Degree
    [0, 0, height, width, plane, 1, 1, 1, degree].forEach((v, i) => dv.setUint32(4 * i, v));
    coefficients.forEach((c, i) => dv.setFloat64(36 + 8 * i, c));
    ops.push({ id: OPCODE_MAP_POLYNOMIAL, version: DNG_1_3, flags: 0, params });
  }
  return ops;
}

export interface MapPolynomial {
  top: number;
  left: number;
  bottom: number;
  right: number;
  plane: number;
  planes: number;
  rowPitch: number;
  colPitch: number;
  coefficients: number[];
}

export function parseMapPolynomial(op: Opcode): MapPolynomial {
  if (op.id !== OPCODE_MAP_POLYNOMIAL) throw new Error(`Opcode ${op.id} is not MapPolynomial`);
  const dv = new DataView(op.params.buffer, op.params.byteOffset, op.params.byteLength);
  const u = (i: number) => dv.getUint32(4 * i);
  const degree = u(8);
  if (op.params.length !== 36 + 8 * (degree + 1)) throw new Error('MapPolynomial parameter size does not match its degree');
  const coefficients: number[] = [];
  for (let i = 0; i <= degree; i++) coefficients.push(dv.getFloat64(36 + 8 * i));
  return { top: u(0), left: u(1), bottom: u(2), right: u(3), plane: u(4), planes: u(5), rowPitch: u(6), colPitch: u(7), coefficients };
}

/**
 * The opcode-dependent DNG versions: `version` is the highest opcode version in the lists,
 * `backward` the highest of the required (non-optional) ones (spec appendix A, issue 7).
 */
export function opcodeVersions(lists: Opcode[][]): { version: number; backward: number } {
  let version = 0;
  let backward = 0;
  for (const ops of lists)
    for (const o of ops) {
      version = Math.max(version, o.version >>> 0);
      if (!(o.flags & 1)) backward = Math.max(backward, o.version >>> 0);
    }
  return { version, backward };
}
