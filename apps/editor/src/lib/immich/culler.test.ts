import { afterEach, describe, expect, it, vi } from 'vitest';
import { CullerError, cullerStatus, lookupCull, recullGroup, setCullerFetch, startRun, waitForRun } from './culler.ts';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const html = (status: number) => new Response('<html>Bad Gateway</html>', { status, headers: { 'content-type': 'text/html' } });

afterEach(() => setCullerFetch((input, init) => fetch(input, init)));

describe('culler client', () => {
  it('a missing service (proxy error page) means "not installed"', async () => {
    setCullerFetch(async () => html(502));
    expect(await cullerStatus(true)).toBeNull();
    expect(await lookupCull(['a'])).toBeNull();
  });

  it('a network error means "not installed" too', async () => {
    setCullerFetch(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await lookupCull(['a'])).toBeNull();
  });

  it("the service's own errors are reported", async () => {
    setCullerFetch(async () => json(403, { message: "this service works on another Immich user's library" }));
    await expect(startRun({ kind: 'day', date: '2024-05-01' }, true)).rejects.toThrow(CullerError);
    await expect(startRun({ kind: 'day', date: '2024-05-01' }, true)).rejects.toThrow(/another Immich user/);
  });

  it('changes carry the editor header, reads do not need it', async () => {
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/runs')) return json(202, { runId: 'r1' });
      return json(200, { items: {} });
    });
    setCullerFetch(f);
    expect(await startRun({ kind: 'album', id: 'x' }, false)).toBe('r1');
    await lookupCull(['a']);
    const [, post] = f.mock.calls[0]!;
    expect(post?.method).toBe('POST');
    expect((post?.headers as Record<string, string>)['X-Raw-Editor']).toBe('1');
    expect(JSON.parse(String(post?.body))).toEqual({ scope: { kind: 'album', id: 'x' }, dryRun: false });
    expect(f.mock.calls[0]![0]).toBe(`${import.meta.env.BASE_URL}culler/api/v1/runs`);
  });

  it('sorts a group again', async () => {
    const f = vi.fn(async () => json(202, { runId: 'r2' }));
    setCullerFetch(f);
    expect(await recullGroup('g/1')).toBe('r2');
    const [url, init] = f.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe(`${import.meta.env.BASE_URL}culler/api/v1/groups/g%2F1/recull`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['X-Raw-Editor']).toBe('1');
  });

  it('waits for a run to finish', async () => {
    const states = ['queued', 'running', 'done'];
    setCullerFetch(async () => json(200, { id: 'r1', status: states.shift() }));
    const seen: string[] = [];
    const run = await waitForRun('r1', (r) => seen.push(r.status), undefined, 1);
    expect(run.status).toBe('done');
    expect(seen).toEqual(['queued', 'running', 'done']);
  });
});
