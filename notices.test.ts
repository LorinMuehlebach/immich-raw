// Keeps THIRD-PARTY-NOTICES.md in step with what ships: a new runtime dependency or licence text
// that isn't listed there fails here.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('./', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');
const notices = read('THIRD-PARTY-NOTICES.md');

function runtimeDependencies(): string[] {
  const manifests = ['apps/editor/package.json', ...readdirSync(new URL('packages/', root), 'utf8').map((p) => `packages/${p}/package.json`)];
  const names = new Set<string>();
  for (const m of manifests) {
    const deps = (JSON.parse(read(m)) as { dependencies?: Record<string, string> }).dependencies ?? {};
    for (const name of Object.keys(deps)) if (!name.startsWith('@immich-raw/')) names.add(name);
  }
  return [...names].sort();
}

describe('third-party notices', () => {
  it('list every runtime dependency', () => {
    const deps = runtimeDependencies();
    expect(deps).toContain('@noble/hashes');
    expect(deps.filter((name) => !notices.includes(name))).toEqual([]);
  });

  it('point to how the shipped LibRaw is built (LGPL)', () => {
    expect(notices).toContain('packages/libraw/build');
    expect(notices).toContain('no-pthreads.patch');
    expect(notices).toContain('Written offer');
  });

  it('link every licence text in licenses/', () => {
    const files = readdirSync(new URL('licenses/', root), 'utf8');
    expect(files.filter((f) => !notices.includes(`licenses/${f}`))).toEqual([]);
  });

  it('carry the notices the DNG patent licence and the IJG licence require', () => {
    expect(notices).toContain('This product includes DNG technology under license by Adobe.');
    expect(notices).toContain('This software is based in part on the work of the Independent JPEG Group.');
  });
});
