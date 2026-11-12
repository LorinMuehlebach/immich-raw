import { describe, expect, it } from 'vitest';
import { editorUrl, isExcludedPath, isSafeReturnPath, pageContext, parseViewerRoute, stackPageUrl } from './routes.ts';

const A = '06d70775-6b65-4af4-8cfc-60a93afa9c3d';
const B = 'a95b288d-caf0-49ac-a428-a47db8e05d4a';

describe('parseViewerRoute', () => {
  it('finds the asset on the timeline viewer', () => {
    expect(parseViewerRoute(`/photos/${A}`)).toEqual({ assetId: A, context: 'timeline' });
  });

  it('keeps album and person context', () => {
    expect(parseViewerRoute(`/albums/${B}/photos/${A}`)).toEqual({ assetId: A, context: `album:${B}` });
    expect(parseViewerRoute(`/people/${B}/photos/${A}`)).toEqual({ assetId: A, context: `person:${B}` });
  });

  it('works on other viewer routes', () => {
    for (const prefix of ['/favorites', '/archive', '/search', '/folders', '/map', '/recently-added', '/utilities/duplicates']) {
      expect(parseViewerRoute(`${prefix}/photos/${A}`)?.assetId).toBe(A);
    }
    expect(parseViewerRoute(`/partners/${B}/photos/${A}`)?.assetId).toBe(A);
    expect(parseViewerRoute(`/memories/${B}/photos/${A}`)?.assetId).toBe(A);
  });

  it('normalises upper-case ids', () => {
    expect(parseViewerRoute(`/photos/${A.toUpperCase()}`)?.assetId).toBe(A);
  });

  it('ignores shared links, trash and the locked folder', () => {
    expect(parseViewerRoute(`/share/somekey/photos/${A}`)).toBeNull();
    expect(parseViewerRoute(`/s/slug/photos/${A}`)).toBeNull();
    expect(parseViewerRoute(`/trash/photos/${A}`)).toBeNull();
    expect(parseViewerRoute(`/locked/photos/${A}`)).toBeNull();
  });

  it('ignores pages without a single asset', () => {
    expect(parseViewerRoute('/photos')).toBeNull();
    expect(parseViewerRoute(`/albums/${B}`)).toBeNull();
    expect(parseViewerRoute('/photos/not-a-uuid')).toBeNull();
    expect(parseViewerRoute(`/photos/${A}x`)).toBeNull();
  });
});

describe('editorUrl', () => {
  it('builds the editor link with asset, context and return path', () => {
    const url = editorUrl('/immich-raw/', A, `album:${B}`, `/albums/${B}/photos/${A}`);
    const params = new URL(url, 'https://immich.example.com').searchParams;
    expect(url.startsWith('/immich-raw/?')).toBe(true);
    expect(params.get('asset')).toBe(A);
    expect(params.get('ctx')).toBe(`album:${B}`);
    expect(params.get('return')).toBe(`/albums/${B}/photos/${A}`);
  });

  it('drops unsafe return paths', () => {
    const url = editorUrl('/immich-raw/', A, 'timeline', '//evil.example.com');
    expect(new URL(url, 'https://x').searchParams.has('return')).toBe(false);
  });
});

describe('stackPageUrl', () => {
  it('builds the stack page link with asset, context and return path', () => {
    const url = stackPageUrl('/immich-raw/', A, 'timeline', `/photos/${A}`);
    const params = new URL(url, 'https://immich.example.com').searchParams;
    expect(url.startsWith('/immich-raw/?')).toBe(true);
    expect(params.get('stack')).toBe(A);
    expect(params.get('ctx')).toBe('timeline');
    expect(params.get('return')).toBe(`/photos/${A}`);
  });

  it('drops unsafe return paths', () => {
    const url = stackPageUrl('/immich-raw/?x=1', A, 'timeline', 'https://evil.example.com');
    expect(url.startsWith('/immich-raw/?x=1&stack=')).toBe(true);
    expect(new URL(url, 'https://x').searchParams.has('return')).toBe(false);
  });
});

describe('isSafeReturnPath', () => {
  it('accepts same-origin paths only', () => {
    expect(isSafeReturnPath('/photos/x')).toBe(true);
    expect(isSafeReturnPath('//host/x')).toBe(false);
    expect(isSafeReturnPath('/\\host')).toBe(false);
    expect(isSafeReturnPath('https://host/x')).toBe(false);
    expect(isSafeReturnPath('photos')).toBe(false);
  });
});

describe('pageContext', () => {
  it('names the album or person page a selection was made on', () => {
    expect(pageContext(`/albums/${B}`)).toBe(`album:${B}`);
    expect(pageContext(`/albums/${B.toUpperCase()}/`)).toBe(`album:${B}`);
    expect(pageContext(`/people/${A}`)).toBe(`person:${A}`);
    expect(pageContext('/photos')).toBe('timeline');
    expect(pageContext('/search?query=x')).toBe('timeline');
  });

  it('knows the pages without buttons', () => {
    expect(isExcludedPath('/share/abc')).toBe(true);
    expect(isExcludedPath('/trash')).toBe(true);
    expect(isExcludedPath('/photos')).toBe(false);
  });
});
