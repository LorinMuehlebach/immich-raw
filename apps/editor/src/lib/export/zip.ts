// A small ZIP writer for album exports. The files are already-compressed images, so
// entries are stored as-is. Each file goes into a Blob part as soon as it is added,
// letting the caller drop its bytes; ZIP64 kicks in past 4 GiB or 65535 entries.
import { crc32 } from '@immich-raw/pipeline';

const MAX16 = 0xffff;
const MAX32 = 0xffffffff;
const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const ZIP64_END_SIG = 0x06064b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const END_SIG = 0x06054b50;
const UTF8_NAMES = 0x0800;
const VERSION = 20;
const VERSION_ZIP64 = 45;
// Made on Unix, spec 4.5, so unzip gives the files rw-r--r--.
const MADE_BY = (3 << 8) | VERSION_ZIP64;
const FILE_ATTRS = (0o100644 << 16) >>> 0;
const encoder = new TextEncoder();

interface Entry {
  name: Uint8Array;
  crc: number;
  size: number;
  offset: number;
  time: number;
  date: number;
  /** Sizes go in ZIP64 extra fields (local and central). */
  bigSize: boolean;
  /** The local header offset goes in the central ZIP64 extra field. */
  bigOffset: boolean;
}

export class ZipWriter {
  private readonly force: boolean;
  private parts: Blob[] = [];
  private entries: Entry[] = [];
  private names = new Set<string>();
  private offset = 0;
  private result: Blob | null = null;

  constructor(opts: { forceZip64?: boolean } = {}) {
    this.force = opts.forceZip64 ?? false;
  }

  /** Adds one stored (uncompressed) file. Names are stored as UTF-8 (language-encoding flag, bit 11). */
  add(name: string, data: Uint8Array, modified: Date = new Date()): void {
    if (this.result) throw new Error('The ZIP archive is already finished');
    const path = checkName(name);
    if (this.names.has(path)) throw new Error(`Duplicate file name in ZIP: ${path}`);
    const nameBytes = encoder.encode(path);
    if (nameBytes.length > MAX16) throw new Error(`File name too long for ZIP: ${path}`);

    const size = data.length;
    const bigSize = this.force || size >= MAX32;
    const bigOffset = this.force || this.offset >= MAX32;
    const { time, date } = dosDateTime(modified);
    const entry: Entry = { name: nameBytes, crc: crc32(data), size, offset: this.offset, time, date, bigSize, bigOffset };

    // The local header only carries the sizes; its ZIP64 field must hold both of them.
    const extraLength = bigSize ? 20 : 0;
    const header = new Uint8Array(30 + nameBytes.length + extraLength);
    const v = new DataView(header.buffer);
    v.setUint32(0, LOCAL_SIG, true);
    v.setUint16(4, bigSize || bigOffset ? VERSION_ZIP64 : VERSION, true);
    v.setUint16(6, UTF8_NAMES, true);
    v.setUint16(8, 0, true); // stored
    v.setUint16(10, time, true);
    v.setUint16(12, date, true);
    v.setUint32(14, entry.crc, true);
    v.setUint32(18, bigSize ? MAX32 : size, true);
    v.setUint32(22, bigSize ? MAX32 : size, true);
    v.setUint16(26, nameBytes.length, true);
    v.setUint16(28, extraLength, true);
    header.set(nameBytes, 30);
    if (bigSize) {
      const at = 30 + nameBytes.length;
      v.setUint16(at, 0x0001, true);
      v.setUint16(at + 2, 16, true);
      setUint64(v, at + 4, size);
      setUint64(v, at + 12, size);
    }

    // The Blob copies the bytes, so the caller's buffer can go right away.
    this.parts.push(new Blob([header, data as BlobPart]));
    this.entries.push(entry);
    this.names.add(path);
    this.offset += header.length + size;
  }

  /** Total bytes so far (local headers + data). */
  get size(): number {
    return this.offset;
  }

  get count(): number {
    return this.entries.length;
  }

  /** The finished archive: local headers + data parts, central directory, (ZIP64 end record + locator when needed), end of central directory. */
  finish(): Blob {
    if (this.result) return this.result;

    const central = this.entries.map((e) => centralHeader(e));
    const cdOffset = this.offset;
    const cdSize = central.reduce((sum, h) => sum + h.length, 0);
    const count = this.entries.length;
    const zip64 = this.force || count >= MAX16 || cdSize >= MAX32 || cdOffset >= MAX32;

    const tail = new Uint8Array((zip64 ? 56 + 20 : 0) + 22);
    const v = new DataView(tail.buffer);
    let at = 0;
    if (zip64) {
      const recordOffset = cdOffset + cdSize;
      v.setUint32(0, ZIP64_END_SIG, true);
      setUint64(v, 4, 44); // size of the rest of the record
      v.setUint16(12, MADE_BY, true);
      v.setUint16(14, VERSION_ZIP64, true);
      v.setUint32(16, 0, true); // this disk
      v.setUint32(20, 0, true); // disk where the central directory starts
      setUint64(v, 24, count);
      setUint64(v, 32, count);
      setUint64(v, 40, cdSize);
      setUint64(v, 48, cdOffset);
      v.setUint32(56, ZIP64_LOCATOR_SIG, true);
      v.setUint32(60, 0, true); // disk with the ZIP64 end record
      setUint64(v, 64, recordOffset);
      v.setUint32(72, 1, true); // total disks
      at = 76;
    }
    // Fields that don't fit hold the placeholder; readers take them from the ZIP64 record.
    const entriesField = this.force ? MAX16 : Math.min(count, MAX16);
    v.setUint32(at, END_SIG, true);
    v.setUint16(at + 4, 0, true);
    v.setUint16(at + 6, 0, true);
    v.setUint16(at + 8, entriesField, true);
    v.setUint16(at + 10, entriesField, true);
    v.setUint32(at + 12, this.force ? MAX32 : Math.min(cdSize, MAX32), true);
    v.setUint32(at + 16, this.force ? MAX32 : Math.min(cdOffset, MAX32), true);
    v.setUint16(at + 20, 0, true); // comment length

    this.result = new Blob([...this.parts, ...central, tail], { type: 'application/zip' });
    this.parts = [];
    return this.result;
  }
}

function centralHeader(e: Entry): Uint8Array<ArrayBuffer> {
  // ZIP64 extra: only the fields whose classic slot holds the placeholder, in this order.
  const extraData = (e.bigSize ? 16 : 0) + (e.bigOffset ? 8 : 0);
  const extraLength = extraData ? 4 + extraData : 0;
  const header = new Uint8Array(46 + e.name.length + extraLength);
  const v = new DataView(header.buffer);
  v.setUint32(0, CENTRAL_SIG, true);
  v.setUint16(4, MADE_BY, true);
  v.setUint16(6, e.bigSize || e.bigOffset ? VERSION_ZIP64 : VERSION, true);
  v.setUint16(8, UTF8_NAMES, true);
  v.setUint16(10, 0, true); // stored
  v.setUint16(12, e.time, true);
  v.setUint16(14, e.date, true);
  v.setUint32(16, e.crc, true);
  v.setUint32(20, e.bigSize ? MAX32 : e.size, true);
  v.setUint32(24, e.bigSize ? MAX32 : e.size, true);
  v.setUint16(28, e.name.length, true);
  v.setUint16(30, extraLength, true);
  v.setUint16(32, 0, true); // comment length
  v.setUint16(34, 0, true); // disk number
  v.setUint16(36, 0, true); // internal attributes
  v.setUint32(38, FILE_ATTRS, true);
  v.setUint32(42, e.bigOffset ? MAX32 : e.offset, true);
  header.set(e.name, 46);
  if (extraLength) {
    let at = 46 + e.name.length;
    v.setUint16(at, 0x0001, true);
    v.setUint16(at + 2, extraData, true);
    at += 4;
    if (e.bigSize) {
      setUint64(v, at, e.size); // uncompressed
      setUint64(v, at + 8, e.size); // compressed
      at += 16;
    }
    if (e.bigOffset) setUint64(v, at, e.offset);
  }
  return header;
}

function setUint64(v: DataView, at: number, n: number): void {
  v.setBigUint64(at, BigInt(n), true);
}

/** MS-DOS date and time (local time, 2 s steps), clamped to the range the format can hold. */
function dosDateTime(d: Date): { time: number; date: number } {
  const year = d.getFullYear();
  // Also catches invalid dates (NaN).
  if (!(year >= 1980)) return { time: 0, date: (1 << 5) | 1 };
  if (year > 2107) return { time: (23 << 11) | (59 << 5) | 29, date: (127 << 9) | (12 << 5) | 31 };
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function checkName(name: string): string {
  const path = name.replace(/\\/g, '/');
  if (!path) throw new Error('Empty file name in ZIP');
  if (path.startsWith('/')) throw new Error(`Absolute file name in ZIP: ${name}`);
  for (const part of path.split('/')) {
    if (part === '..') throw new Error(`File name in ZIP leaves its folder: ${name}`);
    if (part === '' || part === '.') throw new Error(`Invalid file name in ZIP: ${name}`);
  }
  return path;
}
