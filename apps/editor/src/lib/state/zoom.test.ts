import { describe, expect, it } from 'vitest';
import { anchoredCentre, fitScale, nextScale, VIEW_PAD, wheelFactor, ZOOM_MAX } from './zoom.ts';

const frame = { width: 9566, height: 6374 }; // Sony A7R V
const vp = { width: 1400, height: 900, dpr: 1.5 };

describe('zoom', () => {
  it('fits the frame inside the padded stage', () => {
    const s = fitScale(frame, vp);
    expect(frame.width * s).toBeLessThanOrEqual((vp.width - 2 * VIEW_PAD) * vp.dpr + 1e-6);
    expect(frame.height * s).toBeCloseTo((vp.height - 2 * VIEW_PAD) * vp.dpr, 6);
  });

  it('zooms a mouse notch by 2^(1/3), in and out symmetrically', () => {
    expect(wheelFactor({ deltaY: -100, deltaMode: 0 })).toBeCloseTo(2 ** (1 / 3), 9);
    expect(wheelFactor({ deltaY: 100, deltaMode: 0 }) * wheelFactor({ deltaY: -100, deltaMode: 0 })).toBeCloseTo(1, 12);
    expect(wheelFactor({ deltaY: -3, deltaMode: 1 })).toBeCloseTo(wheelFactor({ deltaY: -99, deltaMode: 0 }), 9);
    // One huge event (some trackpads) is capped at a doubling.
    expect(wheelFactor({ deltaY: -5000, deltaMode: 0 })).toBe(2);
  });

  it('returns to fit at the bottom and stops at the top', () => {
    const fit = fitScale(frame, vp);
    expect(nextScale(fit, 0.9, fit)).toBeNull();
    expect(nextScale(fit * 1.1, 0.8, fit)).toBeNull();
    expect(nextScale(fit, 1.26, fit)).toBeCloseTo(fit * 1.26, 9);
    expect(nextScale(6, 2, fit)).toBe(ZOOM_MAX);
  });

  it('keeps the point under the cursor in place', () => {
    const p: [number, number] = [0.3, 0.7];
    const at: [number, number] = [200, 650];
    for (const scale of [0.25, 1, 3.5]) {
      const [cx, cy] = anchoredCentre(p, at, scale, frame, vp);
      // Where p lands on the stage, in CSS pixels: view origin = centre - half the view.
      const fw = frame.width * scale;
      const fh = frame.height * scale;
      const ox = cx * fw - (vp.width * vp.dpr) / 2;
      const oy = cy * fh - (vp.height * vp.dpr) / 2;
      expect((p[0] * fw - ox) / vp.dpr).toBeCloseTo(at[0], 6);
      expect((p[1] * fh - oy) / vp.dpr).toBeCloseTo(at[1], 6);
    }
  });
});
