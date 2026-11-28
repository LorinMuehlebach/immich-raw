import { describe, expect, it } from 'vitest';
import { anchoredCentre, clampZoom, fitScale, nextScale, panBy, viewScale, VIEW_PAD, wheelFactor, zoomAnchored, zoomTo, ZOOM_MAX, type ZoomState } from './zoom.ts';

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

  /** Device-pixel rectangle of the frame the view shows: [left, top, right, bottom]. */
  const shown = (z: ZoomState) => {
    const fw = frame.width * z.scale;
    const fh = frame.height * z.scale;
    const vw = vp.width * vp.dpr;
    const vh = vp.height * vp.dpr;
    return [z.cx * fw - vw / 2, z.cy * fh - vh / 2, z.cx * fw + vw / 2, z.cy * fh + vh / 2] as const;
  };

  it('never shows past the edges of the frame', () => {
    const z = clampZoom({ on: true, cx: 0, cy: 1, scale: 1 }, frame, vp);
    const [l, t, r, b] = shown(z);
    expect(l).toBeCloseTo(0, 6);
    expect(b).toBeCloseTo(frame.height, 6);
    expect(r).toBeLessThan(frame.width);
    expect(t).toBeGreaterThan(0);
  });

  it('centres an axis the frame does not fill', () => {
    const narrow = { width: 400, height: 6000 };
    const z = clampZoom({ on: true, cx: 0.1, cy: 0.1, scale: 1 }, narrow, vp);
    expect(z.cx).toBe(0.5);
    expect(z.cy).toBeGreaterThan(0.1);
  });

  it('zooms to a point, clamped', () => {
    expect(zoomTo([0.5, 0.5], 1, frame, vp)).toEqual({ on: true, cx: 0.5, cy: 0.5, scale: 1 });
    const corner = zoomTo([0, 0], 1, frame, vp);
    expect(shown(corner)[0]).toBeCloseTo(0, 6);
    expect(shown(corner)[1]).toBeCloseTo(0, 6);
  });

  it('pans by a drag in CSS pixels, the photo following the pointer', () => {
    const z: ZoomState = { on: true, cx: 0.5, cy: 0.5, scale: 1 };
    const moved = panBy(z, 100, -40, frame, vp);
    expect((z.cx - moved.cx) * frame.width).toBeCloseTo(100 * vp.dpr, 6);
    expect((z.cy - moved.cy) * frame.height).toBeCloseTo(-40 * vp.dpr, 6);
    expect(shown(panBy(z, 1e6, 0, frame, vp))[0]).toBeCloseTo(0, 6);
  });

  it('does not pan the fitted view', () => {
    const fitted: ZoomState = { on: false, cx: 0.5, cy: 0.5, scale: 1 };
    expect(panBy(fitted, 100, 100, frame, vp)).toBe(fitted);
  });

  it('reports the fitted scale when not zoomed', () => {
    expect(viewScale({ on: false, cx: 0.5, cy: 0.5, scale: 3 }, frame, vp)).toBe(fitScale(frame, vp));
    expect(viewScale({ on: true, cx: 0.5, cy: 0.5, scale: 3 }, frame, vp)).toBe(3);
  });

  it('zooms around an anchor, or back to fit', () => {
    const fit = fitScale(frame, vp);
    expect(zoomAnchored({ scale: fit, p: [0.5, 0.5] }, 0.5, [700, 450], frame, vp)).toBeNull();
    const p: [number, number] = [0.4, 0.6];
    const at: [number, number] = [600, 500];
    const z = zoomAnchored({ scale: fit, p }, 4, [600, 500], frame, vp)!;
    expect(z.on).toBe(true);
    expect(z.scale).toBeCloseTo(fit * 4, 9);
    // Away from the edges the anchor stays under the cursor.
    expect([z.cx, z.cy]).toEqual(anchoredCentre(p, at, z.scale, frame, vp));
    // Near an edge the view is clamped instead.
    const edge = zoomAnchored({ scale: fit, p: [0, 0] }, 4, [700, 450], frame, vp)!;
    expect(shown(edge)[0]).toBeCloseTo(0, 6);
  });
});
