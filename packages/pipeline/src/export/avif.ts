// Reads and sets the colour description (CICP: primaries, transfer, matrix) in an AVIF's "colr"
// boxes of type "nclx", in meta > iprp > ipco (ISO/IEC 23008-12, ISO/IEC 23091-2 code points).
// The encoder takes RGB in whatever space it is given; these boxes say which space that was.

export interface Cicp {
  /** 1 = BT.709/sRGB, 12 = Display P3 (SMPTE EG 432-1). */
  primaries: number;
  /** 13 = sRGB curve. */
  transfer: number;
}

interface Box {
  type: string;
  /** Payload: after the header (and after version/flags for full boxes read by the caller). */
  start: number;
  end: number;
}

function readBoxes(file: Uint8Array, start: number, end: number): Box[] {
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const boxes: Box[] = [];
  let p = start;
  while (p + 8 <= end) {
    let size = dv.getUint32(p);
    let header = 8;
    const type = String.fromCharCode(file[p + 4]!, file[p + 5]!, file[p + 6]!, file[p + 7]!);
    if (size === 1) {
      if (p + 16 > end) throw new Error('Corrupt AVIF: truncated box size.');
      size = Number(dv.getBigUint64(p + 8));
      header = 16;
    } else if (size === 0) size = end - p;
    if (size < header || p + size > end) throw new Error(`Corrupt AVIF: box at ${p} runs past its parent.`);
    boxes.push({ type, start: p + header, end: p + size });
    p += size;
  }
  return boxes;
}

/** Offsets of the code point fields of every nclx colr box (primaries first, then transfer, matrix). */
function nclxOffsets(avif: Uint8Array): number[] {
  const top = readBoxes(avif, 0, avif.length);
  if (!top.some((b) => b.type === 'ftyp')) throw new Error('Not an AVIF (no ftyp box).');
  const offsets: number[] = [];
  for (const meta of top.filter((b) => b.type === 'meta')) {
    // meta is a full box: 4 bytes of version and flags before its children.
    for (const iprp of readBoxes(avif, meta.start + 4, meta.end).filter((b) => b.type === 'iprp')) {
      for (const ipco of readBoxes(avif, iprp.start, iprp.end).filter((b) => b.type === 'ipco')) {
        for (const colr of readBoxes(avif, ipco.start, ipco.end).filter((b) => b.type === 'colr')) {
          const kind = String.fromCharCode(...avif.subarray(colr.start, colr.start + 4));
          if (kind === 'nclx' && colr.start + 4 + 7 <= colr.end) offsets.push(colr.start + 4);
        }
      }
    }
  }
  return offsets;
}

/** The colour description of every nclx box, in file order. */
export function avifCicp(avif: Uint8Array): (Cicp & { matrix: number; fullRange: boolean })[] {
  const dv = new DataView(avif.buffer, avif.byteOffset, avif.byteLength);
  return nclxOffsets(avif).map((o) => ({
    primaries: dv.getUint16(o),
    transfer: dv.getUint16(o + 2),
    matrix: dv.getUint16(o + 4),
    fullRange: (avif[o + 6]! & 0x80) !== 0,
  }));
}

/**
 * A copy of the AVIF with primaries and transfer set in every nclx box (the matrix and range,
 * which describe the encoder's YUV conversion, are kept), and how many boxes were set.
 */
export function setAvifCicp(avif: Uint8Array, cicp: Cicp): { bytes: Uint8Array; boxes: number } {
  const offsets = nclxOffsets(avif);
  const bytes = avif.slice();
  const dv = new DataView(bytes.buffer);
  for (const o of offsets) {
    dv.setUint16(o, cicp.primaries);
    dv.setUint16(o + 2, cicp.transfer);
  }
  return { bytes, boxes: offsets.length };
}
