import { describe, expect, it } from 'vitest';
import { uniqueName } from './destination.ts';

describe('uniqueName', () => {
  it('numbers names that are taken, case-insensitively', () => {
    const taken = new Set(['a.jpg', 'a (2).jpg', 'readme']);
    const has = (n: string) => taken.has(n);
    expect(uniqueName('b.jpg', has)).toBe('b.jpg');
    expect(uniqueName('A.JPG', has)).toBe('A (3).JPG');
    expect(uniqueName('README', has)).toBe('README (2)');
  });
});
