import { describe, expect, it, vi } from 'vitest';
import { createCullerStackResolver, findCullerStack } from './stack.ts';

const CULLER = '/immich-raw/culler/api/v1';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const html = (status: number) => new Response('<html>Not Found</html>', { status, headers: { 'content-type': 'text/html' } });

/** Immich answers the asset, the culler the lookup. */
const fake = (asset: unknown, lookup: () => Response) =>
  vi.fn(async (url: string) => (url.startsWith(CULLER) ? lookup() : asset === null ? json({}, 404) : json(asset)));

const stacked = { id: 'a', stack: { id: 's', assetCount: 6 } };

describe('findCullerStack', () => {
  it('shows for a photo in a culler stack of several shots', async () => {
    const f = fake(stacked, () => json({ items: { a: { groupId: 'g', groupSize: 3 } } }));
    expect(await findCullerStack('a', CULLER, f)).toBe(true);
    const [url, init] = f.mock.calls[1]! as unknown as [string, RequestInit];
    expect(url).toBe(`${CULLER}/assets/lookup`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ ids: ['a'] });
  });

  it('not for a photo outside a stack (and then the culler is not asked)', async () => {
    const f = fake({ id: 'a', stack: null }, () => json({ items: {} }));
    expect(await findCullerStack('a', CULLER, f)).toBe(false);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("not for a RAW + JPEG pair or a stack the culler didn't make", async () => {
    expect(await findCullerStack('a', CULLER, fake(stacked, () => json({ items: {} })))).toBe(false);
    expect(await findCullerStack('a', CULLER, fake(stacked, () => json({ items: { a: { groupId: 'g', groupSize: 1 } } })))).toBe(false);
  });

  it('not without the culler, for someone else, or when Immich fails', async () => {
    expect(await findCullerStack('a', CULLER, fake(stacked, () => html(404)))).toBe(false);
    expect(await findCullerStack('a', CULLER, fake(stacked, () => json({ message: 'not yours' }, 403)))).toBe(false);
    expect(await findCullerStack('a', CULLER, fake(null, () => json({ items: {} })))).toBe(false);
    const broken = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await findCullerStack('a', CULLER, broken)).toBe(false);
  });
});

describe('createCullerStackResolver', () => {
  it('asks once per photo', async () => {
    const f = fake(stacked, () => json({ items: { a: { groupId: 'g', groupSize: 2 } } }));
    const resolve = createCullerStackResolver(CULLER, f);
    expect(await resolve('a')).toBe(true);
    expect(await resolve('a')).toBe(true);
    expect(f).toHaveBeenCalledTimes(2);
  });
});
