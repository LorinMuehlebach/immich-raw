// Double-tap on touch screens. The editor resets sliders, renames items and removes curve points
// on dblclick, but mobile browsers don't reliably send dblclick for a double-tap (iOS Safari
// doesn't). So a touch double-tap dispatches a dblclick on the element under the finger, and the
// browser's own dblclick after a touch is dropped, so nothing runs twice.

/** Longest gap between the two taps, in ms. */
export const DOUBLE_TAP_MS = 350;
/** Furthest the second tap may land from the first, in CSS pixels. */
export const DOUBLE_TAP_PX = 24;

interface Tap {
  t: number;
  x: number;
  y: number;
  target: unknown;
}

/** Tells whether a tap completes a double-tap with the one before it. */
export class TapTracker {
  private last: Tap | null = null;

  tap(t: number, x: number, y: number, target: unknown): boolean {
    const prev = this.last;
    if (prev && prev.target === target && t - prev.t <= DOUBLE_TAP_MS && Math.hypot(x - prev.x, y - prev.y) <= DOUBLE_TAP_PX) {
      // A third tap starts over instead of making a second double-tap.
      this.last = null;
      return true;
    }
    this.last = { t, x, y, target };
    return false;
  }
}

/** Installs the touch double-tap → dblclick behaviour on the page. */
export function installDoubleTap(): void {
  const taps = new TapTracker();
  let lastTouchUp = -Infinity;
  window.addEventListener(
    'pointerup',
    (e) => {
      if (e.pointerType !== 'touch') return;
      lastTouchUp = e.timeStamp;
      // A captured pointer reports the capturing element; the dblclick goes to what's under the finger.
      const target = document.elementFromPoint(e.clientX, e.clientY) ?? e.target;
      if (!(target instanceof Element) || !taps.tap(e.timeStamp, e.clientX, e.clientY, target)) return;
      target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, composed: true, detail: 2, clientX: e.clientX, clientY: e.clientY, view: window }));
    },
    true,
  );
  window.addEventListener(
    'dblclick',
    (e) => {
      if (e.isTrusted && e.timeStamp - lastTouchUp < 600) e.stopImmediatePropagation();
    },
    true,
  );
}
