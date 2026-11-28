import { describe, expect, it } from 'vitest';
import { atMost, defaultParallel, deviceSpecs, isMobileDevice, oneAtATime, parallelOr } from './parallel.ts';

const WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const ANDROID_TABLET = 'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

describe('defaultParallel', () => {
  it('runs 4 at once on every computer', () => {
    expect(defaultParallel({ mobile: false, cores: 8, memoryGb: 8 })).toBe(4);
    expect(defaultParallel({ mobile: false, cores: 4 })).toBe(4);
    expect(defaultParallel({ mobile: false })).toBe(4);
    expect(defaultParallel({ mobile: false, cores: 16, memoryGb: 32 })).toBe(4);
    expect(defaultParallel({ mobile: false, cores: 16, memoryGb: 4 })).toBe(4);
  });
  it('runs 2 at once on phones and tablets', () => {
    expect(defaultParallel({ mobile: true, cores: 8, memoryGb: 8 })).toBe(2);
    expect(defaultParallel({ mobile: true, cores: 6 })).toBe(2);
  });
  it('runs 1 on a phone that reports under 4 GB', () => {
    expect(defaultParallel({ mobile: true, cores: 8, memoryGb: 2 })).toBe(1);
  });
});

describe('isMobileDevice', () => {
  it('tells phones and tablets from desktops', () => {
    expect(isMobileDevice({ userAgent: WIN, platform: 'Win32', maxTouchPoints: 10 })).toBe(false);
    expect(isMobileDevice({ userAgent: MAC, platform: 'MacIntel', maxTouchPoints: 0 })).toBe(false);
    expect(isMobileDevice({ userAgent: IPHONE, platform: 'iPhone', maxTouchPoints: 5 })).toBe(true);
    expect(isMobileDevice({ userAgent: ANDROID_TABLET, platform: 'Linux armv8l' })).toBe(true);
  });
  it('sees an iPad that reports itself as a Mac', () => {
    expect(isMobileDevice({ userAgent: MAC, platform: 'MacIntel', maxTouchPoints: 5 })).toBe(true);
  });
  it('uses client hints where the browser has them', () => {
    expect(isMobileDevice({ userAgent: WIN, userAgentData: { mobile: true } })).toBe(true);
    expect(isMobileDevice({ userAgent: 'Mozilla/5.0 (Linux; Android 10; K)', userAgentData: { mobile: false, platform: 'Android' } })).toBe(true);
    expect(isMobileDevice({ userAgent: WIN, userAgentData: { mobile: false, platform: 'Windows' } })).toBe(false);
  });
});

describe('deviceSpecs', () => {
  it('reads cores and memory', () => {
    expect(deviceSpecs({ userAgent: WIN, hardwareConcurrency: 16, deviceMemory: 8 })).toEqual({ mobile: false, cores: 16, memoryGb: 8 });
    expect(deviceSpecs({ userAgent: IPHONE, hardwareConcurrency: 0 })).toEqual({ mobile: true, cores: undefined, memoryGb: undefined });
  });
});

describe('parallelOr', () => {
  it('accepts 1 to 16 only', () => {
    expect(parallelOr(3, 1)).toBe(3);
    expect(parallelOr(16, 1)).toBe(16);
    expect(parallelOr(0, 2)).toBe(2);
    expect(parallelOr(17, 2)).toBe(2);
    expect(parallelOr(1.5, 2)).toBe(2);
    expect(parallelOr('3', 2)).toBe(2);
    expect(parallelOr(null, 1)).toBe(1);
  });
});

describe('oneAtATime', () => {
  it('runs tasks one after another in call order, past failures', async () => {
    const queue = oneAtATime();
    const log: string[] = [];
    let running = 0;
    let peak = 0;
    const task = (name: string, ms: number, fail = false) =>
      queue(async () => {
        running++;
        peak = Math.max(peak, running);
        log.push(`start ${name}`);
        await new Promise((r) => setTimeout(r, ms));
        running--;
        log.push(`end ${name}`);
        if (fail) throw new Error(name);
        return name;
      });
    const results = await Promise.allSettled([task('a', 15), task('b', 1, true), task('c', 5)]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
    expect(peak).toBe(1);
  });
});

describe('atMost', () => {
  it('runs at most the limit at once, starting in call order, past failures', async () => {
    const queue = atMost(2);
    const started: string[] = [];
    let running = 0;
    let peak = 0;
    const task = (name: string, ms: number, fail = false) =>
      queue(async () => {
        running++;
        peak = Math.max(peak, running);
        started.push(name);
        await new Promise((r) => setTimeout(r, ms));
        running--;
        if (fail) throw new Error(name);
        return name;
      });
    const results = await Promise.allSettled([task('a', 20), task('b', 2, true), task('c', 2), task('d', 2), task('e', 2)]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled', 'fulfilled', 'fulfilled']);
    expect(started).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(peak).toBe(2);
    expect(running).toBe(0);
  });

  it('also releases its slot for a task that throws before returning a promise', async () => {
    const queue = atMost(1);
    const bad = queue(() => {
      throw new Error('sync');
    });
    await expect(bad).rejects.toThrow('sync');
    await expect(queue(async () => 'next')).resolves.toBe('next');
  });
});
