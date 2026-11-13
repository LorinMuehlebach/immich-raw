import { describe, expect, it } from 'vitest';
import {
  OPEN_LABELS,
  activeStep,
  beginStep,
  endStep,
  newOpenSteps,
  overallFraction,
  remainingMs,
  progressWorthShowing,
  remainingText,
  stepDetail,
  type OpenStep,
} from './open-progress.ts';

const steps = (): OpenStep[] => newOpenSteps({ info: 100, original: 1000, decode: 2000, show: 200 });
const step = (s: OpenStep[], id: OpenStep['id']) => s.find((x) => x.id === id)!;

describe('open progress', () => {
  it('adds up the estimates before anything starts', () => {
    const s = steps();
    expect(remainingMs(s, 0)).toBe(3300);
    expect(overallFraction(s, 0)).toBe(0);
    expect(activeStep(s)).toBeNull();
  });

  it('counts down the running step, but never to nothing', () => {
    const s = steps();
    beginStep(s, 'info', 0);
    endStep(s, 'info', 100);
    beginStep(s, 'original', 100);
    endStep(s, 'original', 1100);
    beginStep(s, 'decode', 1100);
    expect(activeStep(s)?.id).toBe('decode');
    expect(remainingMs(s, 1600)).toBe(1500 + 200);
    // Past its estimate, a tenth of the time so far is still expected.
    expect(remainingMs(s, 4100)).toBeCloseTo(300 + 200);
    expect(remainingText(s, 4100)).toBe('Almost done');
    // Well past it (1.5 times the estimate and a second), the screen says so.
    expect(remainingText(s, 5200)).toBe('Taking longer than usual');
  });

  it('times a download by its own speed', () => {
    const s = steps();
    beginStep(s, 'info', 0);
    endStep(s, 'info', 100);
    beginStep(s, 'original', 100, { label: OPEN_LABELS.download, estimateMs: 1000 });
    step(s, 'original').bytes = { received: 10e6, total: 60e6 };
    // 10 MB in 500 ms: 50 MB more take 2.5 s.
    expect(remainingMs(s, 600)).toBeCloseTo(2500 + 2000 + 200);
    expect(stepDetail(step(s, 'original'), 600)).toBe('10 of 60 MB · 20 MB/s');
  });

  it('fills the bar by time spent against time left', () => {
    const s = steps();
    beginStep(s, 'info', 0);
    endStep(s, 'info', 100);
    beginStep(s, 'original', 100);
    expect(overallFraction(s, 600)).toBeCloseTo(600 / (600 + 500 + 2000 + 200));
    for (const id of ['original', 'decode', 'show'] as const) endStep(s, id, 3000);
    expect(overallFraction(s, 3000)).toBe(1);
  });

  it('describes each step', () => {
    const s = steps();
    expect(stepDetail(step(s, 'decode'), 0)).toBe('about 2 s');
    expect(stepDetail(step(s, 'show'), 0)).toBe('under 1 s');
    beginStep(s, 'decode', 0);
    expect(stepDetail(step(s, 'decode'), 1200)).toBe('1.2 s of about 2 s');
    expect(stepDetail(step(s, 'decode'), 2500)).toBe('2.5 s');
    endStep(s, 'decode', 2400);
    expect(stepDetail(step(s, 'decode'), 9999)).toBe('2.4 s');
    beginStep(s, 'show', 2400);
    endStep(s, 'show', 2420);
    expect(stepDetail(step(s, 'show'), 9999)).toBe('<0.1 s');
  });

  it('shows the progress only for an open expected to take over a second', () => {
    const quick = newOpenSteps({ info: 50, original: 100, decode: 300, show: 50 });
    beginStep(quick, 'info', 0);
    expect(progressWorthShowing(quick, 100, 0)).toBe(false);
    expect(progressWorthShowing(quick, 300, 0)).toBe(false);
    // Slower than expected: after a second it shows anyway.
    expect(progressWorthShowing(quick, 1000, 0)).toBe(true);
    const slow = steps();
    beginStep(slow, 'info', 0);
    // Not in the first moment, while the estimates settle.
    expect(progressWorthShowing(slow, 100, 0)).toBe(false);
    expect(progressWorthShowing(slow, 300, 0)).toBe(true);
    expect(progressWorthShowing([], 300, 0)).toBe(false);
  });

  it('says how long the rest takes', () => {
    const s = steps();
    expect(remainingText(s, 0)).toBe('About 3 s left');
    for (const id of ['info', 'original', 'decode'] as const) endStep(s, id, 0);
    expect(remainingText(s, 0)).toBe('Almost done');
  });
});
