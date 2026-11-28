import { describe, expect, it } from 'vitest';
import { parseView, viewParts } from './view-cache.ts';

const jpeg = new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);

describe('view-cache file', () => {
  it('reads back which state the picture shows, and the picture', async () => {
    const view = await parseView(new Blob(viewParts('{"basic":{"exposure":0.5}}', jpeg)));
    expect(view?.shows).toBe('{"basic":{"exposure":0.5}}');
    expect(view?.image.type).toBe('image/jpeg');
    expect(new Uint8Array(await view!.image.arrayBuffer())).toEqual(jpeg);
  });

  it('ignores a damaged file', async () => {
    expect(await parseView(new Blob([new Uint8Array(3)]))).toBeNull();
    const [head] = viewParts('unedited', jpeg);
    // The header without a picture.
    expect(await parseView(new Blob([head!]))).toBeNull();
    const notJson = new Uint8Array(head!.buffer.slice(0));
    notJson[4] = 0x7e;
    await expect(parseView(new Blob([notJson, jpeg]))).rejects.toThrow();
  });
});
