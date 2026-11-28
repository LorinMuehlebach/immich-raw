// Timings of the steps that opening a photo waits for. They land in the browser's performance
// timeline as `immich-raw:<name>` measures (DevTools, Performance panel), and e2e/smoke.mjs
// prints them.
const PREFIX = 'immich-raw:';

/** Starts timing a step; call the returned function when the step is done. */
export function startMeasure(name: string): () => void {
  const start = performance.now();
  return () => {
    try {
      performance.measure(PREFIX + name, { start, end: performance.now() });
    } catch {
      // the User Timing API is optional
    }
  };
}
