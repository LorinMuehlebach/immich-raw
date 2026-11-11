import { describe, expect, it } from 'vitest';
import { DOUBLE_TAP_MS, DOUBLE_TAP_PX, TapTracker } from './touch.ts';

describe('TapTracker', () => {
  const a = {};
  const b = {};

  it('sees two quick taps on the same spot as a double-tap', () => {
    const t = new TapTracker();
    expect(t.tap(0, 10, 10, a)).toBe(false);
    expect(t.tap(200, 14, 12, a)).toBe(true);
  });

  it('needs the taps close in time and place, on the same element', () => {
    const slow = new TapTracker();
    slow.tap(0, 10, 10, a);
    expect(slow.tap(DOUBLE_TAP_MS + 1, 10, 10, a)).toBe(false);

    const far = new TapTracker();
    far.tap(0, 10, 10, a);
    expect(far.tap(100, 10 + DOUBLE_TAP_PX + 1, 10, a)).toBe(false);

    const other = new TapTracker();
    other.tap(0, 10, 10, a);
    expect(other.tap(100, 10, 10, b)).toBe(false);
  });

  it('starts over after a double-tap, so a triple tap is one double-tap', () => {
    const t = new TapTracker();
    t.tap(0, 10, 10, a);
    expect(t.tap(100, 10, 10, a)).toBe(true);
    expect(t.tap(200, 10, 10, a)).toBe(false);
    expect(t.tap(300, 10, 10, a)).toBe(true);
  });
});
