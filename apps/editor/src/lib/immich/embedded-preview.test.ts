import { describe, expect, it } from 'vitest';
import { watchEmbeddedPreview } from './embedded-preview.ts';

/** A RAF's start: the header with the JPEG's place, then the JPEG (0xff 0xd8 ... 0xff 0xd9), then more. */
function raf(jpegLength: number, tail = 500): Uint8Array {
  const b = new Uint8Array(160 + jpegLength + tail);
  b.set([...'FUJIFILMCCD-RAW 0201'].map((c) => c.charCodeAt(0)));
  const dv = new DataView(b.buffer);
  dv.setUint32(84, 160, false);
  dv.setUint32(88, jpegLength, false);
  b[160] = 0xff;
  b[161] = 0xd8;
  b[160 + jpegLength - 2] = 0xff;
  b[160 + jpegLength - 1] = 0xd9;
  return b;
}

describe('watchEmbeddedPreview', () => {
  it('settles with the JPEG as soon as the bytes reach its end, before the download is done', async () => {
    const file = raf(1000);
    const w = watchEmbeddedPreview();
    w.onData(file.subarray(0, 100), false);
    w.onData(file.subarray(0, 1000), false);
    let settled = false;
    void w.ready.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    w.onData(file.subarray(0, 1160), false);
    const blob = (await w.ready)!;
    expect(blob.type).toBe('image/jpeg');
    expect(blob.size).toBe(1000);
  });

  it('is null for a file that is not a RAF, as soon as its header is in', async () => {
    const w = watchEmbeddedPreview();
    w.onData(new Uint8Array(200), false);
    expect(await w.ready).toBeNull();
  });

  it('is null when the file ends before the JPEG does', async () => {
    const w = watchEmbeddedPreview();
    w.onData(raf(1000).subarray(0, 600), true);
    expect(await w.ready).toBeNull();
  });

  it('is null for a tiny file, and keeps its first answer', async () => {
    const tiny = watchEmbeddedPreview();
    tiny.onData(new Uint8Array(10), true);
    expect(await tiny.ready).toBeNull();
    const w = watchEmbeddedPreview();
    const file = raf(1000);
    w.onData(file, true);
    w.onData(new Uint8Array(0), true);
    expect((await w.ready)!.size).toBe(1000);
  });
});
