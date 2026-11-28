import { describe, expect, it, vi } from 'vitest';
import { RAW_EXTENSIONS, captureBaseName, createEditTargetResolver, findEditTarget, isRawFilename, rawOfCapture } from './raw.ts';

describe('isRawFilename', () => {
  it('accepts RAW extensions in any case', () => {
    for (const name of ['a.CR3', 'b.nef', 'c.ARW', 'd.Raf', 'e.dng', 'f.RW2', 'g.orf', 'h.pef', 'i.x3f', 'j.3fr']) {
      expect(isRawFilename(name)).toBe(true);
    }
  });

  it('rejects other images and the extensions Immich lists as raw but we cannot decode', () => {
    for (const name of ['a.jpg', 'b.JPEG', 'c.heic', 'd.tif', 'e.psd', 'f.ari', 'g.cin', 'noext', '', null, undefined]) {
      expect(isRawFilename(name)).toBe(false);
    }
  });

  it('matches Immich v3.3.6 minus psd/ari/cin (27 extensions)', () => {
    expect(RAW_EXTENSIONS).toHaveLength(27);
    expect(new Set(RAW_EXTENSIONS).size).toBe(27);
  });
});

type Routes = Record<string, unknown>;

function fakeFetch(routes: Routes) {
  return vi.fn(async (url: string) => {
    if (url in routes) return new Response(JSON.stringify(routes[url]), { status: 200 });
    return new Response('{"message":"Not found"}', { status: 404 });
  });
}

describe('findEditTarget', () => {
  it('returns a RAW itself', async () => {
    const f = fakeFetch({ '/api/assets/raw1': { id: 'raw1', originalFileName: 'IMG_1.CR3' } });
    expect(await findEditTarget('raw1', f)).toEqual({ rawId: 'raw1', copyId: null });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('follows an editor render back to its RAW', async () => {
    const f = fakeFetch({
      '/api/assets/render1': { id: 'render1', originalFileName: 'IMG_1.edit.jpg' },
      '/api/assets/render1/metadata/raw-editor.render': { key: 'raw-editor.render', value: { sourceAssetId: 'raw1' } },
    });
    expect(await findEditTarget('render1', f)).toEqual({ rawId: 'raw1', copyId: null });
  });

  it("a virtual copy's render opens that copy", async () => {
    const f = fakeFetch({
      '/api/assets/c1': { id: 'c1', originalFileName: 'IMG_1.copy-2.edit.jpg' },
      '/api/assets/c1/metadata/raw-editor.render': { key: 'raw-editor.render', value: { sourceAssetId: 'raw1', copyId: 'k3x9' } },
    });
    expect(await findEditTarget('c1', f)).toEqual({ rawId: 'raw1', copyId: 'k3x9' });
  });

  it('follows an AI-upscaled copy back to its RAW', async () => {
    const f = fakeFetch({
      '/api/assets/up1': { id: 'up1', originalFileName: 'IMG_1.upscaled-2x.edit.jpg', stack: { id: 's1', primaryAssetId: 'render1', assetCount: 3 } },
      '/api/assets/up1/metadata/raw-editor.render': { key: 'raw-editor.render', value: { sourceAssetId: 'raw1', upscale: { scale: 2, style: 'sharp' } } },
    });
    expect(await findEditTarget('up1', f)).toEqual({ rawId: 'raw1', copyId: null });
  });

  it('finds the RAW in a camera RAW+JPEG stack', async () => {
    const f = fakeFetch({
      '/api/assets/jpg1': { id: 'jpg1', originalFileName: 'IMG_1.JPG', stack: { id: 's1', primaryAssetId: 'jpg1', assetCount: 2 } },
      '/api/stacks/s1': {
        id: 's1',
        assets: [
          { id: 'jpg1', originalFileName: 'IMG_1.JPG' },
          { id: 'old', originalFileName: 'IMG_0.NEF', isTrashed: true },
          { id: 'raw1', originalFileName: 'IMG_1.NEF' },
        ],
      },
    });
    expect(await findEditTarget('jpg1', f)).toEqual({ rawId: 'raw1', copyId: null });
  });

  it('returns null for a plain JPEG and for unknown assets', async () => {
    const f = fakeFetch({ '/api/assets/jpg2': { id: 'jpg2', originalFileName: 'x.jpg', stack: null } });
    expect(await findEditTarget('jpg2', f)).toBeNull();
    expect(await findEditTarget('missing', f)).toBeNull();
  });

  it('returns null when the network fails', async () => {
    const f = vi.fn(async () => {
      throw new TypeError('offline');
    });
    expect(await findEditTarget('x', f)).toBeNull();
  });
});

describe('createEditTargetResolver', () => {
  it('looks each asset up once', async () => {
    const f = fakeFetch({ '/api/assets/raw1': { id: 'raw1', originalFileName: 'a.dng' } });
    const resolve = createEditTargetResolver(f);
    await Promise.all([resolve('raw1'), resolve('raw1')]);
    await resolve('raw1');
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe('captureBaseName', () => {
  it('drops the extension and the editor suffix', () => {
    expect(captureBaseName('DSC01234.ARW')).toBe('dsc01234');
    expect(captureBaseName('DSC01234.JPG')).toBe('dsc01234');
    expect(captureBaseName('DSC01234.edit.jpg')).toBe('dsc01234');
    expect(captureBaseName('noext')).toBe('noext');
  });
});

describe('rawOfCapture (stacks holding several captures)', () => {
  const t = (s: string) => `2024-05-01T10:00:${s}.000Z`;
  const burst = [
    { id: 'j2', originalFileName: 'DSC2.JPG', fileCreatedAt: t('01') },
    { id: 'r1', originalFileName: 'DSC1.ARW', fileCreatedAt: t('00') },
    { id: 'r2', originalFileName: 'DSC2.ARW', fileCreatedAt: t('01') },
    { id: 'r3', originalFileName: 'DSC3.ARW', fileCreatedAt: t('05') },
  ];

  it('picks the RAW with the same file name', () => {
    expect(rawOfCapture({ id: 'j2', originalFileName: 'DSC2.JPG', fileCreatedAt: t('01') }, burst)).toBe('r2');
  });

  it('falls back to the RAW taken at the same moment', () => {
    expect(rawOfCapture({ id: 'p', originalFileName: 'phone.jpg', fileCreatedAt: t('05') }, burst)).toBe('r3');
  });

  it('gives up when it cannot tell', () => {
    const twins = [...burst, { id: 'r4', originalFileName: 'DSC4.ARW', fileCreatedAt: t('05') }];
    expect(rawOfCapture({ id: 'p', originalFileName: 'phone.jpg', fileCreatedAt: t('05') }, twins)).toBeNull();
  });

  it('a single RAW in the stack is the answer', () => {
    expect(rawOfCapture({ id: 'x', originalFileName: 'x.jpg' }, [burst[1]!])).toBe('r1');
  });

  it('findEditTarget uses it for a camera JPEG in a burst stack', async () => {
    const f = fakeFetch({
      '/api/assets/j2': { id: 'j2', originalFileName: 'DSC2.JPG', fileCreatedAt: t('01'), stack: { id: 's' } },
      '/api/stacks/s': { assets: burst },
    });
    expect(await findEditTarget('j2', f)).toEqual({ rawId: 'r2', copyId: null });
  });
});
