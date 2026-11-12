import { defaultRecipe } from '@immich-raw/recipe';
import { describe, expect, it } from 'vitest';
import {
  applyAffine,
  aspectRatioFor,
  cropToView,
  cropViewFrame,
  editFrame,
  fitViewRect,
  invertAffine,
  isTransformActive,
  maxViewRect,
  orientAffine,
  quarterTurnsFromFlip,
  transformInverse,
  transformMatrix,
  viewRectInside,
  viewToCrop,
} from './geometry.ts';

const crop = () => defaultRecipe().crop;
const close = (a: [number, number], b: [number, number]) => {
  expect(a[0]).toBeCloseTo(b[0], 6);
  expect(a[1]).toBeCloseTo(b[1], 6);
};

describe('orientation', () => {
  it('maps LibRaw flips to clockwise quarter turns', () => {
    expect([0, 3, 5, 6].map(quarterTurnsFromFlip)).toEqual([0, 2, 3, 1]);
  });

  it('rotating 90° clockwise puts the sensor top-left corner at the upright top-right', () => {
    // upright top-right (1, 0) must come from source top-left (0, 0)
    close(applyAffine(orientAffine(1), 1, 0), [0, 0]);
    close(applyAffine(orientAffine(1), 0, 0), [0, 1]);
    close(applyAffine(orientAffine(3), 0, 0), [1, 0]);
    close(applyAffine(orientAffine(2), 0, 0), [1, 1]);
  });
});

describe('editFrame', () => {
  it('is the identity for the default crop', () => {
    const f = editFrame(crop(), 0, 6000, 4000);
    expect(f.width).toBe(6000);
    expect(f.height).toBe(4000);
    close(applyAffine(f.tToS, 0, 0), [0, 0]);
    close(applyAffine(f.tToS, 1, 1), [1, 1]);
  });

  it('swaps the output size for portrait shots', () => {
    const f = editFrame(crop(), 6, 6000, 4000);
    expect([f.width, f.height]).toEqual([4000, 6000]);
  });

  it('maps a centred half crop to the middle of the source', () => {
    const c = { ...crop(), w: 0.5, h: 0.5 };
    const f = editFrame(c, 0, 6000, 4000);
    expect([f.width, f.height]).toEqual([3000, 2000]);
    close(applyAffine(f.tToS, 0, 0), [0.25, 0.25]);
    close(applyAffine(f.tToS, 1, 1), [0.75, 0.75]);
  });

  it('keeps the crop centre fixed when straightening', () => {
    const c = { ...crop(), w: 0.5, h: 0.5, cx: 0.4, cy: 0.6, angle: 10 };
    const f = editFrame(c, 0, 6000, 4000);
    close(applyAffine(f.tToS, 0.5, 0.5), [0.4, 0.6]);
  });
});

describe('crop view', () => {
  it('round-trips between recipe crop and view rectangle', () => {
    const c = { ...crop(), cx: 0.42, cy: 0.55, w: 0.5, h: 0.4, angle: 7 };
    const v = cropToView(c, 6000, 4000);
    const back = viewToCrop(v, c.angle, 6000, 4000);
    expect(back.cx).toBeCloseTo(c.cx, 9);
    expect(back.cy).toBeCloseTo(c.cy, 9);
  });

  it('view centre maps to the same source point in crop and edit mode', () => {
    const c = { ...crop(), cx: 0.42, cy: 0.55, w: 0.5, h: 0.4, angle: 7 };
    const v = cropToView(c, 6000, 4000);
    const inCropMode = applyAffine(cropViewFrame(c, 0, 6000, 4000).tToS, v.cx, v.cy);
    const inEditMode = applyAffine(editFrame(c, 0, 6000, 4000).tToS, 0.5, 0.5);
    close(inCropMode, inEditMode);
  });

  it('shrinks a full rectangle to fit once the image is straightened', () => {
    const full = { cx: 0.5, cy: 0.5, w: 1, h: 1 };
    expect(viewRectInside(full, 0, 6000, 4000)).toBe(true);
    expect(viewRectInside(full, 5, 6000, 4000)).toBe(false);
    const fitted = fitViewRect(full, 5, 6000, 4000);
    expect(viewRectInside(fitted, 5, 6000, 4000)).toBe(true);
    expect(fitted.w).toBeGreaterThan(0.8);
    expect(fitted.w / fitted.h).toBeCloseTo(1, 6);
  });

  it('finds the largest rectangle for an aspect', () => {
    const r = maxViewRect(1, 0, 6000, 4000); // square on a 3:2 image
    expect(r.h).toBeCloseTo(1, 6);
    expect(r.w * 6000).toBeCloseTo(4000, 3);
  });

  it('computes preset aspects', () => {
    expect(aspectRatioFor({ aspect: 'original', portrait: false }, 6000, 4000)).toBeCloseTo(1.5);
    expect(aspectRatioFor({ aspect: '4:5', portrait: false }, 6000, 4000)).toBeCloseTo(1.25);
    expect(aspectRatioFor({ aspect: '4:5', portrait: true }, 6000, 4000)).toBeCloseTo(0.8);
    expect(aspectRatioFor({ aspect: 'free', portrait: false }, 6000, 4000)).toBeNull();
  });

  it('inverts the crop/rotate mapping exactly', () => {
    const crop = { ...defaultRecipe().crop, cx: 0.4, cy: 0.6, w: 0.5, h: 0.4, angle: 7.5 };
    const { tToS } = editFrame(crop, 6, 6000, 4000);
    const inv = invertAffine(tToS);
    for (const [x, y] of [[0, 0], [1, 0.3], [0.25, 0.9]] as const) {
      const [sx, sy] = applyAffine(tToS, x, y);
      const [bx, by] = applyAffine(inv, sx, sy);
      expect(bx).toBeCloseTo(x, 9);
      expect(by).toBeCloseTo(y, 9);
    }
  });
});

describe('transform (perspective)', () => {
  const W = 6000;
  const H = 4000;
  const t = (patch: Partial<ReturnType<typeof defaultRecipe>['transform']>) => ({ ...defaultRecipe().transform, ...patch });

  it('is the identity at the defaults', () => {
    expect(isTransformActive(defaultRecipe().transform)).toBe(false);
    expect(transformMatrix(defaultRecipe().transform, W, H)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    close(applyAffine(editFrame(crop(), 0, W, H, defaultRecipe().transform).tToS, 0.3, 0.6), [0.3, 0.6]);
  });

  it('Vertical keeps the centre and widens the top when negative', () => {
    const m = transformMatrix(t({ vertical: -50 }), W, H);
    close(applyAffine(m, 0.5, 0.5), [0.5, 0.5]);
    const topW = applyAffine(m, 1, 0)[0] - applyAffine(m, 0, 0)[0];
    const botW = applyAffine(m, 1, 1)[0] - applyAffine(m, 0, 1)[0];
    expect(topW).toBeGreaterThan(botW * 1.3);
    // Lines stay straight and vertical lines through the centre stay vertical.
    expect(applyAffine(m, 0.5, 0)[0]).toBeCloseTo(0.5, 9);
    const inv = transformInverse(t({ vertical: -50 }), W, H);
    close(applyAffine(inv, ...applyAffine(m, 0.2, 0.8)), [0.2, 0.8]);
  });

  it('Horizontal widens the left side when negative; rotate, scale and offsets act about the centre', () => {
    const h = transformMatrix(t({ horizontal: -50 }), W, H);
    const leftH = applyAffine(h, 0, 1)[1] - applyAffine(h, 0, 0)[1];
    const rightH = applyAffine(h, 1, 1)[1] - applyAffine(h, 1, 0)[1];
    expect(leftH).toBeGreaterThan(rightH * 1.3);
    const s = transformMatrix(t({ scale: 150 }), W, H);
    close(applyAffine(s, 1, 0.5), [1.25, 0.5]);
    const o = transformMatrix(t({ offsetX: 100, offsetY: -100 }), W, H);
    close(applyAffine(o, 0.5, 0.5), [1, 0]);
    const r = transformMatrix(t({ rotate: 10 }), W, H);
    // Clockwise on screen: a point right of the centre moves down.
    expect(applyAffine(r, 0.9, 0.5)[1]).toBeGreaterThan(0.5);
  });

  it('the edit frame samples the untransformed image', () => {
    const tr = t({ vertical: -40, rotate: 3 });
    const f = editFrame(crop(), 0, W, H, tr);
    const m = transformMatrix(tr, W, H);
    // The output point t shows the source point that the transform moved to t.
    const src = applyAffine(f.tToS, 0.3, 0.2);
    close(applyAffine(m, src[0], src[1]), [0.3, 0.2]);
  });

  it('Constrain Crop keeps the crop inside the transformed image', () => {
    const tr = t({ vertical: -60, horizontal: 20 });
    const limit = transformInverse(tr, W, H);
    const view = maxViewRect(W / H, 0, W, H, limit);
    expect(view.w).toBeGreaterThan(0.3);
    expect(viewRectInside(view, 0, W, H, 1e-6, limit)).toBe(true);
    expect(viewRectInside({ cx: 0.5, cy: 0.5, w: 1, h: 1 }, 0, W, H, 1e-6, limit)).toBe(false);
    const fitted = fitViewRect({ cx: 0.5, cy: 0.5, w: 1, h: 1 }, 0, W, H, limit);
    expect(viewRectInside(fitted, 0, W, H, 1e-6, limit)).toBe(true);
  });
});
