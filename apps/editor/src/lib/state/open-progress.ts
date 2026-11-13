// The steps of opening a photo, for the loading screen: what is happening now and how long the rest
// will take. The editor keeps the steps in its state and moves them along; the estimates come from
// earlier opens (open-times.ts) and, while the original downloads, from the download's own speed.

export type OpenStepId = 'info' | 'original' | 'decode' | 'show';

export interface OpenStep {
  id: OpenStepId;
  label: string;
  /** Expected duration, ms. */
  estimateMs: number;
  /** performance.now() when the step started and ended (null: not yet). */
  startedAt: number | null;
  endedAt: number | null;
  /** Bytes received so far and in all (the original); null when only the clock tells. */
  bytes: { received: number; total: number } | null;
}

export const OPEN_LABELS = {
  info: 'Loading photo info',
  original: 'Getting the original',
  download: 'Downloading the original',
  originalCached: "Original from this browser's cache",
  decode: 'Decoding the RAW',
  decodeCached: "Decoded photo from this browser's cache",
  show: 'Rendering',
} as const;

export function newOpenSteps(estimates: Record<OpenStepId, number>): OpenStep[] {
  const step = (id: OpenStepId, label: string): OpenStep => ({ id, label, estimateMs: estimates[id], startedAt: null, endedAt: null, bytes: null });
  return [step('info', OPEN_LABELS.info), step('original', OPEN_LABELS.original), step('decode', OPEN_LABELS.decode), step('show', OPEN_LABELS.show)];
}

export function beginStep(steps: OpenStep[], id: OpenStepId, now: number, change: Partial<Pick<OpenStep, 'label' | 'estimateMs'>> = {}): void {
  const s = steps.find((x) => x.id === id);
  if (!s) return;
  Object.assign(s, change);
  s.startedAt ??= now;
}

export function endStep(steps: OpenStep[], id: OpenStepId, now: number): void {
  const s = steps.find((x) => x.id === id);
  if (!s) return;
  s.startedAt ??= now;
  s.endedAt ??= now;
}

/** The step running now (the first one started and not ended), or null. */
export function activeStep(steps: OpenStep[]): OpenStep | null {
  return steps.find((s) => s.startedAt !== null && s.endedAt === null) ?? null;
}

/** Bytes per ms of the running download, once it has run long enough to tell. */
export function byteRate(s: OpenStep, now: number): number | null {
  if (!s.bytes || s.startedAt === null || s.bytes.received <= 0) return null;
  const elapsed = (s.endedAt ?? now) - s.startedAt;
  return elapsed >= 250 ? s.bytes.received / elapsed : null;
}

/** How much longer one step will take. Past its estimate, a step still has a little left. */
export function stepRemainingMs(s: OpenStep, now: number): number {
  if (s.endedAt !== null) return 0;
  if (s.startedAt === null) return s.estimateMs;
  const elapsed = now - s.startedAt;
  const rate = byteRate(s, now);
  if (rate && s.bytes && s.bytes.total > 0) return Math.max(0, s.bytes.total - s.bytes.received) / rate;
  return Math.max(s.estimateMs - elapsed, 0.1 * Math.max(s.estimateMs, elapsed));
}

export function remainingMs(steps: OpenStep[], now: number): number {
  return steps.reduce((sum, s) => sum + stepRemainingMs(s, now), 0);
}

/** 0..1 for the progress bar: the time spent against the time spent plus what is left. */
export function overallFraction(steps: OpenStep[], now: number): number {
  const first = steps.find((s) => s.startedAt !== null)?.startedAt;
  if (first == null) return 0;
  if (steps.every((s) => s.endedAt !== null)) return 1;
  const spent = now - first;
  const left = remainingMs(steps, now);
  return spent + left > 0 ? spent / (spent + left) : 0;
}

/** The running step has taken clearly longer than expected. */
export function isSlow(s: OpenStep, now: number): boolean {
  if (s.startedAt === null || s.endedAt !== null || byteRate(s, now)) return false;
  return now - s.startedAt > 1.5 * s.estimateMs + 1000;
}

/** "0.4 s", "2.3 s", "14 s": how long something took. */
export function formatElapsed(ms: number): string {
  if (ms < 50) return '<0.1 s';
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`;
}

/** "under 1 s", "about 3 s": how long something will take. */
export function formatEstimate(ms: number): string {
  return ms < 1000 ? 'under 1 s' : `about ${Math.round(ms / 1000)} s`;
}

const mb = (bytes: number) => (bytes < 10e6 ? (bytes / 1e6).toFixed(1) : Math.round(bytes / 1e6).toString());

/** The text after a step's label: its time, or for the download, the megabytes and speed. */
export function stepDetail(s: OpenStep, now: number): string {
  if (s.startedAt === null) return formatEstimate(s.estimateMs);
  if (s.endedAt !== null) return formatElapsed(s.endedAt - s.startedAt);
  const elapsed = now - s.startedAt;
  if (s.bytes && s.bytes.total > 0) {
    const rate = byteRate(s, now);
    const speed = rate ? ` · ${mb(rate * 1000)} MB/s` : '';
    return `${mb(s.bytes.received)} of ${mb(s.bytes.total)} MB${speed}`;
  }
  return elapsed >= s.estimateMs || s.estimateMs < 1000 ? formatElapsed(elapsed) : `${formatElapsed(elapsed)} of ${formatEstimate(s.estimateMs)}`;
}

/**
 * Whether the loading screen shows the progress at all: only for an open expected to take more
 * than a second (`since`: when the loading screen appeared). It waits a moment first, while the
 * estimates settle (e.g. a decoded image turns out to be cached), and shows it after a second
 * anyway, when the open took longer than expected.
 */
export function progressWorthShowing(steps: OpenStep[], now: number, since: number): boolean {
  const waited = now - since;
  if (waited >= 1000) return true;
  if (waited < 250) return false;
  const first = steps.find((s) => s.startedAt !== null)?.startedAt ?? since;
  return now - first + remainingMs(steps, now) > 1000;
}

/** The line above the bar: how long the whole open will still take. */
export function remainingText(steps: OpenStep[], now: number): string {
  const active = activeStep(steps);
  if (active && isSlow(active, now)) return 'Taking longer than usual';
  const left = remainingMs(steps, now);
  return left < 1000 ? 'Almost done' : `About ${Math.round(left / 1000)} s left`;
}
