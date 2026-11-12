import { describe, expect, it } from 'vitest';
import { crc32 } from '@immich-raw/pipeline';
import { ZipWriter } from './zip.ts';

const MAX16 = 0xffff;
const MAX32 = 0xffffffff;
const text = (s: string) => new TextEncoder().encode(s);

// Deterministic noise, so a failure is reproducible.
function noise(n: number, seed = 1): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

interface ReadEntry {
  name: string;
  data: Uint8Array;
  crc: number;
  size: number;
  offset: number;
  time: number;
  date: number;
  version: number;
  /** ZIP64 extra field data in the central and local headers (null when absent). */
  centralZip64: number[] | null;
  localZip64: number[] | null;
}

interface ReadZip {
  entries: ReadEntry[];
  zip64: boolean;
  end: { entries: number; cdSize: number; cdOffset: number };
}

// A plain check instead of expect(): the 65535-entry archive needs millions of them.
function eq(actual: unknown, expected: unknown, what: string): void {
  if (actual !== expected) throw new Error(`${what}: got ${String(actual)}, expected ${String(expected)}`);
}

/**
 * Parses an archive the way an unzip tool does: end record, then the central directory,
 * then each local header. `shift` is subtracted from every stored offset, for archives
 * that pretend 4 GiB came before them.
 */
function readZip(buf: Uint8Array, shift = 0): ReadZip {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const u16 = (at: number) => v.getUint16(at, true);
  const u32 = (at: number) => v.getUint32(at, true);
  const u64 = (at: number) => Number(v.getBigUint64(at, true));
  const utf8 = new TextDecoder('utf-8', { fatal: true });

  const endAt = buf.length - 22;
  eq(u32(endAt), 0x06054b50, 'end signature');
  eq(u16(endAt + 4), 0, 'disk');
  eq(u16(endAt + 6), 0, 'central directory disk');
  eq(u16(endAt + 20), 0, 'comment length');
  const end = { entries: u16(endAt + 10), cdSize: u32(endAt + 12), cdOffset: u32(endAt + 16) };
  eq(u16(endAt + 8), end.entries, 'entries on this disk');
  let count = end.entries;
  let cdSize = end.cdSize;
  let cdOffset = end.cdOffset;
  let cdEnd = endAt;

  const locatorAt = endAt - 20;
  const zip64 = locatorAt >= 0 && u32(locatorAt) === 0x07064b50;
  if (zip64) {
    eq(u32(locatorAt + 4), 0, 'ZIP64 record disk');
    eq(u32(locatorAt + 16), 1, 'total disks');
    const recordAt = u64(locatorAt + 8) - shift;
    eq(recordAt, locatorAt - 56, 'ZIP64 record position');
    eq(u32(recordAt), 0x06064b50, 'ZIP64 record signature');
    eq(u64(recordAt + 4), 44, 'ZIP64 record size');
    eq(u16(recordAt + 12) & 0xff, 45, 'ZIP64 record made-by version');
    eq(u16(recordAt + 14), 45, 'ZIP64 record version needed');
    eq(u32(recordAt + 16), 0, 'ZIP64 disk');
    eq(u32(recordAt + 20), 0, 'ZIP64 central directory disk');
    count = u64(recordAt + 24);
    eq(u64(recordAt + 32), count, 'ZIP64 entries on this disk');
    cdSize = u64(recordAt + 40);
    cdOffset = u64(recordAt + 48);
    // Classic fields hold either the real value or the placeholder.
    expect([count, MAX16]).toContain(end.entries);
    expect([cdSize, MAX32]).toContain(end.cdSize);
    expect([cdOffset, MAX32]).toContain(end.cdOffset);
    cdEnd = recordAt;
  }
  eq(cdOffset - shift + cdSize, cdEnd, 'central directory end');

  const entries: ReadEntry[] = [];
  let at = cdOffset - shift;
  let nextLocal = 0;
  for (let i = 0; i < count; i++) {
    const what = (field: string) => `entry ${i} ${field}`;
    eq(u32(at), 0x02014b50, what('central signature'));
    eq(u16(at + 4) & 0xff, 45, what('made-by version'));
    const version = u16(at + 6);
    const flags = u16(at + 8);
    eq(flags, 0x0800, what('flags'));
    eq(u16(at + 10), 0, what('method'));
    const time = u16(at + 12);
    const date = u16(at + 14);
    const crc = u32(at + 16);
    let compressed = u32(at + 20);
    let size = u32(at + 24);
    const nameLength = u16(at + 28);
    const extraLength = u16(at + 30);
    eq(u16(at + 32), 0, what('comment length'));
    eq(u16(at + 34), 0, what('disk'));
    let offset = u32(at + 42);
    const name = utf8.decode(buf.subarray(at + 46, at + 46 + nameLength));

    let centralZip64: number[] | null = null;
    const zip64Field = findZip64Field(v, at + 46 + nameLength, extraLength);
    if (zip64Field) {
      const [start, length] = zip64Field;
      centralZip64 = [];
      for (let p = start; p < start + length; p += 8) centralZip64.push(u64(p));
      // Only the fields whose classic slot holds the placeholder, in fixed order.
      const fields = [...centralZip64];
      if (size === MAX32) size = fields.shift()!;
      if (compressed === MAX32) compressed = fields.shift()!;
      if (offset === MAX32) offset = fields.shift()!;
      eq(fields.length, 0, what('unused ZIP64 fields'));
      eq(version, 45, what('version needed'));
    }
    eq(compressed, size, what('compressed size'));
    if (size === MAX32 || offset === MAX32) throw new Error(what('placeholder without ZIP64 field'));

    // Local header: same metadata, data right after it, entries back to back.
    const local = offset - shift;
    eq(local, nextLocal, what('offset'));
    eq(u32(local), 0x04034b50, what('local signature'));
    eq(u16(local + 4), version, what('local version needed'));
    eq(u16(local + 6), flags, what('local flags'));
    eq(u16(local + 8), 0, what('local method'));
    eq(u16(local + 10), time, what('local time'));
    eq(u16(local + 12), date, what('local date'));
    eq(u32(local + 14), crc, what('local CRC'));
    const localCompressed = u32(local + 18);
    const localSize = u32(local + 22);
    eq(u16(local + 26), nameLength, what('local name length'));
    const localExtraLength = u16(local + 28);
    eq(utf8.decode(buf.subarray(local + 30, local + 30 + nameLength)), name, what('local name'));
    let localZip64: number[] | null = null;
    const localField = findZip64Field(v, local + 30 + nameLength, localExtraLength);
    if (localField) {
      const [start, length] = localField;
      // The local field always holds both sizes.
      eq(length, 16, what('local ZIP64 field length'));
      localZip64 = [u64(start), u64(start + 8)];
      eq(localSize, MAX32, what('local size placeholder'));
      eq(localCompressed, MAX32, what('local compressed size placeholder'));
      eq(localZip64[0], size, what('local ZIP64 size'));
      eq(localZip64[1], size, what('local ZIP64 compressed size'));
    } else {
      eq(localSize, size, what('local size'));
      eq(localCompressed, size, what('local compressed size'));
    }
    const dataAt = local + 30 + nameLength + localExtraLength;
    const data = buf.subarray(dataAt, dataAt + size);
    eq(crc32(data), crc, what('data CRC'));
    nextLocal = dataAt + size;

    entries.push({ name, data, crc, size, offset, time, date, version, centralZip64, localZip64 });
    at += 46 + nameLength + extraLength;
  }
  eq(at, cdEnd, 'central directory length');
  eq(nextLocal, cdOffset - shift, 'end of file data');
  return { entries, zip64, end };
}

/** Start and length of the ZIP64 field (0x0001) in an extra block, after checking the block's framing. */
function findZip64Field(v: DataView, start: number, length: number): [number, number] | null {
  let found: [number, number] | null = null;
  let at = start;
  while (at < start + length) {
    const id = v.getUint16(at, true);
    const size = v.getUint16(at + 2, true);
    if (id === 0x0001) found = [at + 4, size];
    at += 4 + size;
  }
  eq(at, start + length, 'extra field length');
  return found;
}

const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());

const when = new Date(2024, 4, 17, 13, 45, 31);
const files: [string, Uint8Array<ArrayBuffer>][] = [
  ['Zürich-été.jpg', noise(1234, 7)],
  ['empty.txt', new Uint8Array(0)],
  ['album/random.bin', noise(70 * 1024)],
  ['check.txt', text('123456789')],
];

function writeSample(opts?: { forceZip64?: boolean }): ZipWriter {
  const zip = new ZipWriter(opts);
  for (const [name, data] of files) zip.add(name, data, when);
  return zip;
}

describe('ZipWriter', () => {
  it('writes a stored archive with UTF-8 names', async () => {
    const zip = writeSample();
    expect(zip.count).toBe(4);
    const expectedSize = files.reduce((sum, [name, data]) => sum + 30 + text(name).length + data.length, 0);
    expect(zip.size).toBe(expectedSize);

    const blob = zip.finish();
    expect(blob.type).toBe('application/zip');
    const archive = readZip(await bytesOf(blob));
    expect(archive.zip64).toBe(false);
    expect(archive.end.entries).toBe(4);
    expect(archive.end.cdOffset).toBe(expectedSize);
    expect(archive.entries.map((e) => e.name)).toEqual(files.map(([name]) => name));
    for (const [i, entry] of archive.entries.entries()) {
      expect(entry.data).toEqual(files[i]![1]);
      expect(entry.version).toBe(20);
      expect(entry.centralZip64).toBeNull();
      expect(entry.localZip64).toBeNull();
    }
    expect(archive.entries[1]!.size).toBe(0);
    expect(archive.entries[1]!.crc).toBe(0);
    expect(archive.entries[3]!.crc).toBe(0xcbf43926);
  });

  it('writes ZIP64 records and extra fields when forced', async () => {
    const archive = readZip(await bytesOf(writeSample({ forceZip64: true }).finish()));
    expect(archive.zip64).toBe(true);
    expect(archive.end).toEqual({ entries: MAX16, cdSize: MAX32, cdOffset: MAX32 });
    expect(archive.entries.map((e) => e.name)).toEqual(files.map(([name]) => name));
    for (const [i, entry] of archive.entries.entries()) {
      const size = files[i]![1].length;
      expect(entry.data).toEqual(files[i]![1]);
      expect(entry.version).toBe(45);
      expect(entry.centralZip64).toEqual([size, size, entry.offset]);
      expect(entry.localZip64).toEqual([size, size]);
    }
  });

  it('puts only the offset in the ZIP64 field when just the offset is too big', async () => {
    const zip = new ZipWriter();
    // Pretend 4 GiB were written before, like data in front of a self-extracting archive.
    const shift = 2 ** 32 + 10;
    (zip as unknown as { offset: number }).offset = shift;
    zip.add('a.jpg', noise(100), when);
    zip.add('b.jpg', noise(50, 3), when);
    expect(zip.size).toBe(shift + 2 * 35 + 150);

    const archive = readZip(await bytesOf(zip.finish()), shift);
    expect(archive.zip64).toBe(true);
    // Central headers: 46 bytes + name + ZIP64 field with just the offset (4 + 8).
    expect(archive.end).toEqual({ entries: 2, cdSize: 2 * (46 + 5 + 12), cdOffset: MAX32 });
    for (const entry of archive.entries) {
      expect(entry.version).toBe(45);
      expect(entry.centralZip64).toEqual([entry.offset]);
      expect(entry.localZip64).toBeNull();
    }
    expect(archive.entries.map((e) => e.offset)).toEqual([shift, shift + 135]);
  });

  it('switches to ZIP64 at 65535 entries', async () => {
    const zip = new ZipWriter();
    const empty = new Uint8Array(0);
    for (let i = 0; i < MAX16; i++) zip.add(`f${i}`, empty, when);
    const archive = readZip(await bytesOf(zip.finish()));
    expect(archive.zip64).toBe(true);
    expect(archive.end.entries).toBe(MAX16);
    expect(archive.end.cdOffset).toBe(zip.size);
    expect(archive.entries).toHaveLength(MAX16);
    expect(archive.entries[MAX16 - 1]!.name).toBe(`f${MAX16 - 1}`);
    expect(archive.entries.every((e) => e.centralZip64 === null && e.version === 20)).toBe(true);
  }, 30_000);

  it('keeps its own copy of the data', async () => {
    const zip = new ZipWriter();
    const data = noise(1000);
    const copy = data.slice();
    zip.add('a.jpg', data);
    data.fill(0);
    const [entry] = readZip(await bytesOf(zip.finish())).entries;
    expect(entry!.data).toEqual(copy);
  });

  it('encodes MS-DOS times in local time, clamped to 1980-2107', async () => {
    const zip = new ZipWriter();
    zip.add('a', new Uint8Array(0), new Date(2024, 4, 17, 13, 45, 31));
    zip.add('b', new Uint8Array(0), new Date(1970, 0, 1, 12, 0, 0));
    zip.add('c', new Uint8Array(0), new Date(2200, 0, 1));
    zip.add('d', new Uint8Array(0), new Date(Number.NaN));
    zip.add('e', new Uint8Array(0), new Date(1980, 0, 1, 0, 0, 0));
    const before = new Date();
    zip.add('now', new Uint8Array(0));
    const after = new Date();

    const entries = readZip(await bytesOf(zip.finish())).entries;
    const at = (i: number) => [entries[i]!.date, entries[i]!.time];
    expect(at(0)).toEqual([(44 << 9) | (5 << 5) | 17, (13 << 11) | (45 << 5) | 15]);
    expect(at(1)).toEqual([(1 << 5) | 1, 0]);
    expect(at(2)).toEqual([(127 << 9) | (12 << 5) | 31, (23 << 11) | (59 << 5) | 29]);
    expect(at(3)).toEqual([(1 << 5) | 1, 0]);
    expect(at(4)).toEqual([(1 << 5) | 1, 0]);

    const { date, time } = entries[5]!;
    const decoded = new Date(
      (date >> 9) + 1980,
      ((date >> 5) & 15) - 1,
      date & 31,
      time >> 11,
      (time >> 5) & 63,
      (time & 31) * 2,
    );
    expect(decoded.getTime()).toBeGreaterThanOrEqual(before.getTime() - 2000);
    expect(decoded.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it('turns backslashes into slashes', async () => {
    const zip = new ZipWriter();
    zip.add('album\\day 1\\a.jpg', new Uint8Array(1));
    expect(readZip(await bytesOf(zip.finish())).entries[0]!.name).toBe('album/day 1/a.jpg');
  });

  it('rejects unsafe, empty and duplicate names', () => {
    const zip = new ZipWriter();
    const data = new Uint8Array(1);
    for (const name of ['', '/a.jpg', '\\a.jpg', '..', '../a.jpg', 'x/../../a.jpg', 'x\\..\\a.jpg', 'a/', 'a//b.jpg', './a.jpg']) {
      expect(() => zip.add(name, data), name).toThrow();
    }
    expect(zip.count).toBe(0);
    expect(zip.size).toBe(0);

    zip.add('x/a.jpg', data);
    expect(() => zip.add('x/a.jpg', data)).toThrow(/Duplicate/);
    expect(() => zip.add('x\\a.jpg', data)).toThrow(/Duplicate/);
    zip.add('x/A.jpg', data);
    zip.add('a..b.jpg', data);
    expect(zip.count).toBe(3);
  });

  it('refuses to add after finishing and returns the same archive again', () => {
    const zip = new ZipWriter();
    zip.add('a.jpg', new Uint8Array(1));
    const blob = zip.finish();
    expect(zip.finish()).toBe(blob);
    expect(() => zip.add('b.jpg', new Uint8Array(1))).toThrow();
  });

  it('writes an empty archive', async () => {
    const bytes = await bytesOf(new ZipWriter().finish());
    expect(bytes.length).toBe(22);
    expect(readZip(bytes).entries).toEqual([]);
  });
});
