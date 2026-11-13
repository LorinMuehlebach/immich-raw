import { beforeEach, describe, expect, it } from 'vitest';
import { fakeLibRawLog } from './fake-libraw.ts';
import { RawSession, prewarmDecoder, readExtraMeta, setLibRawUrl } from './libraw.ts';
import type { RawMeta } from './types.ts';

const FAKE = new URL('./fake-libraw.ts', import.meta.url).href;
const bytes = new Uint8Array(16);
/** Lets pending promises (the module import, a dispose) settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('prewarmDecoder', () => {
  beforeEach(async () => {
    setLibRawUrl(FAKE);
    await settle();
    fakeLibRawLog().length = 0;
  });

  it('hands the instance it started to the next decode, which disposes it', async () => {
    prewarmDecoder();
    await settle();
    expect(fakeLibRawLog()).toHaveLength(1);
    const started = fakeLibRawLog()[0]!;
    expect(started).toMatch(/^new /);
    await readExtraMeta(bytes);
    // No second instance: the decode used the one already running.
    expect(fakeLibRawLog()).toEqual([started, started.replace('new', 'dispose')]);
  });

  it('starts a new instance for each later decode', async () => {
    prewarmDecoder();
    await readExtraMeta(bytes);
    await readExtraMeta(bytes);
    const made = fakeLibRawLog().filter((s) => s.startsWith('new'));
    const disposed = fakeLibRawLog().filter((s) => s.startsWith('dispose'));
    expect(made).toHaveLength(2);
    expect(disposed).toEqual(made.map((s) => s.replace('new', 'dispose')));
  });

  it('keeps at most one instance waiting', async () => {
    prewarmDecoder();
    prewarmDecoder();
    await settle();
    expect(fakeLibRawLog().filter((s) => s.startsWith('new'))).toHaveLength(1);
  });

  it('disposes a waiting instance when the decoder moves', async () => {
    prewarmDecoder();
    await settle();
    setLibRawUrl(FAKE);
    await settle();
    const [made, disposed] = fakeLibRawLog();
    expect(disposed).toBe(made!.replace('new', 'dispose'));
  });
});

describe('RawSession.close', () => {
  const meta = { width: 8, height: 8, isXTrans: false } as RawMeta;

  beforeEach(async () => {
    setLibRawUrl(FAKE);
    await settle();
    fakeLibRawLog().length = 0;
  });

  it('stops a running full-resolution decode', async () => {
    const session = RawSession.restore(bytes, meta, { width: 4, height: 4, data: new Uint16Array(48), halfSize: true });
    const full = session.full();
    full.catch(() => {});
    await settle();
    expect(fakeLibRawLog()).toHaveLength(1);
    session.close();
    await expect(full).rejects.toThrow('LibRaw disposed');
    expect(fakeLibRawLog()[1]).toMatch(/^dispose /);
  });
});
