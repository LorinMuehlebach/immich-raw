// How many photos a batch export works on at once. Each photo decodes in a worker of its own on
// one core, so more at once uses more cores; each photo in progress adds about 0.5 GB (26 MP) to
// 1 GB (40-61 MP) of browser memory. Measured: docs/export-speed.md.

/** The most photos the user can pick. */
export const MAX_PARALLEL = 16;

export interface DeviceSpecs {
  /** Phone or tablet. */
  mobile: boolean;
  /** navigator.hardwareConcurrency (logical cores). */
  cores?: number;
  /**
   * navigator.deviceMemory in GB, rounded: Chromium on HTTPS (or localhost) only. Older versions
   * never report more than 8; Edge 157 reports 32 on a 32 GB computer.
   */
  memoryGb?: number;
}

/**
 * The number picked unless the user chooses one: 4 on every computer (measured: about 3-4 times
 * faster than one at a time; 8 was at most 23 % faster and needed 11 GB for 40-65 MP RAWs).
 * 2 on phones and tablets, 1 where a phone's browser reports under 4 GB (HTTPS only).
 */
export function defaultParallel(d: DeviceSpecs): number {
  if (d.mobile) return d.memoryGb !== undefined && d.memoryGb < 4 ? 1 : 2;
  return 4;
}

interface NavigatorLike {
  userAgent: string;
  platform?: string;
  maxTouchPoints?: number;
  hardwareConcurrency?: number;
  deviceMemory?: number;
  /** User-Agent Client Hints (Chromium, HTTPS only). */
  userAgentData?: { mobile?: boolean; platform?: string };
}

/** Phones and tablets. iPads report themselves as a Mac with a touch screen. */
export function isMobileDevice(n: NavigatorLike): boolean {
  if (n.userAgentData?.mobile) return true;
  if (/^(Android|iOS)$/i.test(n.userAgentData?.platform ?? '')) return true;
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(n.userAgent)) return true;
  return n.platform === 'MacIntel' && (n.maxTouchPoints ?? 0) > 1;
}

/** This device, read from `navigator`. */
export function deviceSpecs(n: NavigatorLike = navigator as unknown as NavigatorLike): DeviceSpecs {
  return { mobile: isMobileDevice(n), cores: n.hardwareConcurrency || undefined, memoryGb: n.deviceMemory };
}

/** A stored "photos at once" value, or `fallback` when it isn't a whole number from 1 to MAX_PARALLEL. */
export function parallelOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_PARALLEL ? value : fallback;
}

/** A queue that runs the tasks given to it one at a time, in call order. A failed task doesn't stop the next. */
export function oneAtATime(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return (task) => {
    const run = tail.then(task);
    tail = run.catch(() => {});
    return run;
  };
}
