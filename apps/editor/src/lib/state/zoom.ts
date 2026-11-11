// Zoom maths for the photo view. A zoom scale is device pixels per full-resolution image pixel
// (1 = 100 %); the fitted view has its own, smaller scale.

/** Space around the fitted photo, in CSS pixels. */
export const VIEW_PAD = 24;
/** Highest zoom: 800 %. */
export const ZOOM_MAX = 8;

export interface Viewport {
  /** CSS pixels. */
  width: number;
  height: number;
  dpr: number;
}

/** Scale of the fitted view: the whole frame inside the stage, VIEW_PAD around it. */
export function fitScale(frame: { width: number; height: number }, vp: Viewport): number {
  const w = Math.max(50, vp.width - VIEW_PAD * 2);
  const h = Math.max(50, vp.height - VIEW_PAD * 2);
  return (Math.min(w / frame.width, h / frame.height) || 1) * vp.dpr;
}

/** Zoom factor for a wheel event: a mouse notch (~100 px) zooms by 2^(1/3); pinches give small steps. */
export function wheelFactor(e: { deltaY: number; deltaMode: number }): number {
  const px = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
  return 2 ** (-Math.max(-300, Math.min(300, px)) / 300);
}

/** The scale after zooming `current` by `factor`, or null when that is back at (or below) fit. */
export function nextScale(current: number, factor: number, fit: number): number | null {
  const next = Math.min(Math.max(ZOOM_MAX, fit), current * factor);
  return next <= fit * 1.001 ? null : next;
}

/**
 * View centre (frame coordinates 0..1) at `scale` that keeps frame point `p` under the stage
 * point `at` (CSS pixels from the stage's top left; the zoomed view fills the stage).
 */
export function anchoredCentre(
  p: [number, number],
  at: [number, number],
  scale: number,
  frame: { width: number; height: number },
  vp: Viewport,
): [number, number] {
  const fw = frame.width * scale;
  const fh = frame.height * scale;
  return [p[0] + ((vp.width / 2 - at[0]) * vp.dpr) / fw, p[1] + ((vp.height / 2 - at[1]) * vp.dpr) / fh];
}
