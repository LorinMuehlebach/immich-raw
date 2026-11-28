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

export interface ZoomState {
  on: boolean;
  /** Centre in frame coordinates. */
  cx: number;
  cy: number;
  /** Device pixels per full-resolution pixel. */
  scale: number;
}

/** Size of the edit frame in full-resolution pixels. */
export interface Frame {
  width: number;
  height: number;
}

/** The scale the view shows now: the zoom's, or the fitted one when not zoomed. */
export function viewScale(z: ZoomState, frame: Frame, vp: Viewport): number {
  return z.on ? z.scale : fitScale(frame, vp);
}

/**
 * Moves the centre so the view shows no space past the frame's edges. Along an axis the zoomed
 * frame does not fill, it is centred.
 */
export function clampZoom(z: ZoomState, frame: Frame, vp: Viewport): ZoomState {
  const clamp = (c: number, view: number, full: number) => (full <= view ? 0.5 : Math.min(1 - view / 2 / full, Math.max(view / 2 / full, c)));
  return {
    ...z,
    cx: clamp(z.cx, vp.width * vp.dpr, frame.width * z.scale),
    cy: clamp(z.cy, vp.height * vp.dpr, frame.height * z.scale),
  };
}

/** Zoomed in to `scale` with frame point `p` (0..1) in the middle, as far as the edges allow. */
export function zoomTo(p: [number, number], scale: number, frame: Frame, vp: Viewport): ZoomState {
  return clampZoom({ on: true, cx: p[0], cy: p[1], scale }, frame, vp);
}

/**
 * Zoomed to `anchor.scale * factor` with the anchor's frame point under the stage point `at` (CSS
 * pixels from the stage's top left), as far as the edges allow; null when that is back at fit.
 */
export function zoomAnchored(
  anchor: { scale: number; p: [number, number] },
  factor: number,
  at: [number, number],
  frame: Frame,
  vp: Viewport,
): ZoomState | null {
  const scale = nextScale(anchor.scale, factor, fitScale(frame, vp));
  if (scale === null) return null;
  const [cx, cy] = anchoredCentre(anchor.p, at, scale, frame, vp);
  return clampZoom({ on: true, cx, cy, scale }, frame, vp);
}

/** Pans a zoomed view by a drag of (dx, dy) CSS pixels; the fitted view is returned as it is. */
export function panBy(z: ZoomState, dx: number, dy: number, frame: Frame, vp: Viewport): ZoomState {
  if (!z.on) return z;
  return clampZoom({ ...z, cx: z.cx - (dx * vp.dpr) / (frame.width * z.scale), cy: z.cy - (dy * vp.dpr) / (frame.height * z.scale) }, frame, vp);
}
