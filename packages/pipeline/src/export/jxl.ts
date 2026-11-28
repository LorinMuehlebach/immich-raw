// Wraps a bare JPEG XL codestream (which carries no metadata) in the ISO BMFF container of
// ISO/IEC 18181-2, with Exif and xml (XMP) boxes before the codestream box.

export interface JxlMetadata {
  /** TIFF block from buildTiff ("II*\0..."), written as an Exif box. */
  exif?: Uint8Array;
  /** XMP packet, written as an "xml " box. */
  xmp?: string;
}

const SIGNATURE = [0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a];
const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

function box(type: string, payload: Uint8Array): Uint8Array {
  const size = 8 + payload.length;
  if (size > 0xffffffff) throw new Error('JPEG XL box too large.');
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, size);
  out.set(ascii(type), 4);
  out.set(payload, 8);
  return out;
}

interface Box {
  type: string;
  /** Whole box, header included. */
  bytes: Uint8Array;
}

function readBoxes(file: Uint8Array): Box[] {
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const boxes: Box[] = [];
  let p = 0;
  while (p + 8 <= file.length) {
    let size = dv.getUint32(p);
    const type = String.fromCharCode(file[p + 4]!, file[p + 5]!, file[p + 6]!, file[p + 7]!);
    if (size === 1) {
      if (p + 16 > file.length) throw new Error('Corrupt JPEG XL container: truncated box size.');
      size = Number(dv.getBigUint64(p + 8));
    } else if (size === 0) size = file.length - p;
    if (size < 8 || p + size > file.length) throw new Error(`Corrupt JPEG XL container: box at ${p} runs past the end.`);
    boxes.push({ type, bytes: file.subarray(p, p + size) });
    p += size;
  }
  return boxes;
}

const isContainer = (b: Uint8Array) => b.length >= SIGNATURE.length && SIGNATURE.every((v, i) => b[i] === v);

/**
 * A JPEG XL file with the given Exif and XMP. A bare codestream (FF 0A) is put in a container;
 * a container keeps its boxes, with existing Exif and xml boxes replaced. Without any metadata
 * the input is returned.
 */
export function jxlContainer(jxl: Uint8Array, m: JxlMetadata): Uint8Array {
  const xmp = m.xmp ? new TextEncoder().encode(m.xmp) : undefined;
  if (!m.exif?.length && !xmp?.length) return jxl;

  const meta: Uint8Array[] = [];
  if (m.exif?.length) {
    // Exif box: a 4-byte offset to the TIFF header (0 here), then the TIFF block.
    const payload = new Uint8Array(4 + m.exif.length);
    payload.set(m.exif, 4);
    meta.push(box('Exif', payload));
  }
  if (xmp?.length) meta.push(box('xml ', xmp));

  let parts: Uint8Array[];
  if (isContainer(jxl)) {
    const boxes = readBoxes(jxl).filter((b) => b.type !== 'Exif' && b.type !== 'xml ');
    const at = boxes.findIndex((b) => b.type === 'jxlc' || b.type === 'jxlp');
    if (at < 0) throw new Error('Corrupt JPEG XL container: no codestream box.');
    parts = [...boxes.slice(0, at).map((b) => b.bytes), ...meta, ...boxes.slice(at).map((b) => b.bytes)];
  } else {
    if (jxl[0] !== 0xff || jxl[1] !== 0x0a) throw new Error('Not a JPEG XL codestream.');
    const ftyp = new Uint8Array(12);
    ftyp.set(ascii('jxl '), 0);
    ftyp.set(ascii('jxl '), 8);
    parts = [Uint8Array.from(SIGNATURE), box('ftyp', ftyp), ...meta, box('jxlc', jxl)];
  }
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
