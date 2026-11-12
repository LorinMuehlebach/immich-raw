import { describe, expect, it, vi } from 'vitest';
import { createCullerCheck, cullerAvailable } from './culler.ts';

const CULLER = '/immich-raw/culler/api/v1';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const html = (status: number) => new Response('<html>Not Found</html>', { status, headers: { 'content-type': 'text/html' } });

describe('cullerAvailable', () => {
  it("asks the culler's /me with the session cookie", async () => {
    const f = vi.fn(async () => json({ ok: true, owner: 'me@example.com' }));
    expect(await cullerAvailable(CULLER, f)).toBe(true);
    expect(f).toHaveBeenCalledWith(`${CULLER}/me`, expect.objectContaining({ credentials: 'same-origin' }));
  });

  it('no for a missing culler, another user, a logged-out page or a network error', async () => {
    expect(await cullerAvailable(CULLER, async () => html(404))).toBe(false);
    expect(await cullerAvailable(CULLER, async () => html(200))).toBe(false); // a fallback page, not the API
    expect(await cullerAvailable(CULLER, async () => json({ message: 'another library' }, 403))).toBe(false);
    expect(await cullerAvailable(CULLER, async () => json({ message: 'log in' }, 401))).toBe(false);
    const broken = async (): Promise<Response> => {
      throw new TypeError('Failed to fetch');
    };
    expect(await cullerAvailable(CULLER, broken)).toBe(false);
  });
});

describe('createCullerCheck', () => {
  it('asks once, then again after the time to live', async () => {
    let t = 0;
    const answers = [json({ ok: true }), json({ message: 'another library' }, 403)];
    const f = vi.fn(async () => answers.shift()!);
    const check = createCullerCheck(CULLER, f, 1000, () => t);
    expect(await check()).toBe(true);
    t = 900;
    expect(await check()).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
    t = 2000;
    expect(await check()).toBe(false);
    expect(f).toHaveBeenCalledTimes(2);
  });
});
