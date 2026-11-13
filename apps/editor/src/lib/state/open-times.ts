// How long opening photos took in this browser, so the loading screen can say how long the next
// open will take. Every number is a moving average, kept in localStorage. Decode times are kept
// per camera (make, model and file type), with averages over all cameras for new ones.

const KEY = 'raw-editor.openTimes';
/** Weight of the newest measurement in each average. */
const WEIGHT = 0.4;
const MAX_CAMERAS = 40;
const MB = 1e6;

/** Starting points for a browser that hasn't opened a photo yet (a desktop on a home network). */
export const DEFAULT_TIMES = {
  /** Photo info from Immich, ms. */
  infoMs: 60,
  /** Download speed, bytes per ms (20 MB/s). */
  downloadRate: 20_000,
  /** Reading a cached file, bytes per ms (400 MB/s). */
  readRate: 400_000,
  /** Half-size decode, ms per MB of RAW file. */
  decodeMsPerMB: 30,
  /** Full-resolution decode, ms per MB of RAW file. */
  fullMsPerMB: 110,
  /** From the decoded image to the first picture, ms. */
  showMs: 150,
};

export interface CameraTimes {
  decodeMs?: number;
  fullMs?: number;
  showMs?: number;
  /** Date.now() of the last open, to forget cameras not seen for a long time. */
  used: number;
}

export interface OpenTimes {
  infoMs?: number;
  downloadRate?: number;
  readRate?: number;
  decodeMsPerMB?: number;
  fullMsPerMB?: number;
  showMs?: number;
  cameras: Record<string, CameraTimes>;
}

/** What one open measured. Steps that didn't happen (e.g. the decode, for a cached image) are left out. */
export interface OpenSample {
  camera: string;
  /** Size of the RAW file. */
  bytes: number;
  infoMs?: number;
  /** Downloaded from Immich: bytes and ms. */
  download?: { bytes: number; ms: number };
  /** Read from this browser's cache (the original or the decoded image): bytes and ms. */
  read?: { bytes: number; ms: number };
  decodeMs?: number;
  showMs?: number;
}

/** The camera's key: make, model and file type, e.g. "sony ilce-7rm5 arw". */
export function cameraKey(make: string | null | undefined, model: string | null | undefined, fileName: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(fileName)?.[1] ?? '';
  return [make, model, ext]
    .map((s) => (s ?? '').trim().toLowerCase())
    .filter(Boolean)
    .join(' ');
}

export const estimateInfoMs = (t: OpenTimes) => t.infoMs ?? DEFAULT_TIMES.infoMs;

export const estimateDownloadMs = (t: OpenTimes, bytes: number) => bytes / (t.downloadRate ?? DEFAULT_TIMES.downloadRate);

export const estimateReadMs = (t: OpenTimes, bytes: number) => 20 + bytes / (t.readRate ?? DEFAULT_TIMES.readRate);

export function estimateDecodeMs(t: OpenTimes, camera: string, bytes: number): number {
  return t.cameras[camera]?.decodeMs ?? (t.decodeMsPerMB ?? DEFAULT_TIMES.decodeMsPerMB) * (bytes / MB);
}

export function estimateFullMs(t: OpenTimes, camera: string, bytes: number): number {
  return t.cameras[camera]?.fullMs ?? (t.fullMsPerMB ?? DEFAULT_TIMES.fullMsPerMB) * (bytes / MB);
}

export function estimateShowMs(t: OpenTimes, camera: string): number {
  return t.cameras[camera]?.showMs ?? t.showMs ?? DEFAULT_TIMES.showMs;
}

const average = (old: number | undefined, x: number) => (old === undefined ? x : old + WEIGHT * (x - old));
const usable = (x: number | undefined): x is number => x !== undefined && Number.isFinite(x) && x > 0;

/** The averages with one open added. */
export function recordOpen(t: OpenTimes, s: OpenSample, now = Date.now()): OpenTimes {
  const out: OpenTimes = { ...t, cameras: { ...t.cameras } };
  const cam: CameraTimes = { ...out.cameras[s.camera], used: now };
  if (usable(s.infoMs)) out.infoMs = average(out.infoMs, s.infoMs);
  // Small files say more about the round trip than the speed.
  if (s.download && s.download.bytes > 2 * MB && usable(s.download.ms)) {
    out.downloadRate = average(out.downloadRate, s.download.bytes / s.download.ms);
  }
  if (s.read && s.read.bytes > 2 * MB && usable(s.read.ms)) out.readRate = average(out.readRate, s.read.bytes / s.read.ms);
  if (usable(s.decodeMs)) {
    cam.decodeMs = average(cam.decodeMs, s.decodeMs);
    if (s.bytes > MB) out.decodeMsPerMB = average(out.decodeMsPerMB, s.decodeMs / (s.bytes / MB));
  }
  if (usable(s.showMs)) {
    cam.showMs = average(cam.showMs, s.showMs);
    out.showMs = average(out.showMs, s.showMs);
  }
  out.cameras[s.camera] = cam;
  return prune(out);
}

/** The averages with one full-resolution decode added. */
export function recordFull(t: OpenTimes, camera: string, bytes: number, ms: number, now = Date.now()): OpenTimes {
  if (!usable(ms)) return t;
  const out: OpenTimes = { ...t, cameras: { ...t.cameras } };
  const cam: CameraTimes = { ...out.cameras[camera], used: now };
  cam.fullMs = average(cam.fullMs, ms);
  if (bytes > MB) out.fullMsPerMB = average(out.fullMsPerMB, ms / (bytes / MB));
  out.cameras[camera] = cam;
  return prune(out);
}

function prune(t: OpenTimes): OpenTimes {
  const names = Object.keys(t.cameras);
  if (names.length <= MAX_CAMERAS) return t;
  const keep = names.sort((a, b) => t.cameras[b]!.used - t.cameras[a]!.used).slice(0, MAX_CAMERAS);
  return { ...t, cameras: Object.fromEntries(keep.map((k) => [k, t.cameras[k]!])) };
}

/** Keeps only sensible numbers from stored (possibly old or damaged) data. */
export function normalizeOpenTimes(raw: unknown): OpenTimes {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);
  const out: OpenTimes = { cameras: {} };
  for (const k of ['infoMs', 'downloadRate', 'readRate', 'decodeMsPerMB', 'fullMsPerMB', 'showMs'] as const) {
    const v = num(src[k]);
    if (v !== undefined) out[k] = v;
  }
  const cams = src.cameras && typeof src.cameras === 'object' ? (src.cameras as Record<string, unknown>) : {};
  for (const [name, c] of Object.entries(cams)) {
    if (!c || typeof c !== 'object') continue;
    const r = c as Record<string, unknown>;
    const cam: CameraTimes = { used: num(r.used) ?? 0 };
    for (const k of ['decodeMs', 'fullMs', 'showMs'] as const) {
      const v = num(r[k]);
      if (v !== undefined) cam[k] = v;
    }
    out.cameras[name] = cam;
  }
  return prune(out);
}

export function loadOpenTimes(): OpenTimes {
  try {
    const v = localStorage.getItem(KEY);
    return normalizeOpenTimes(v ? JSON.parse(v) : null);
  } catch {
    return { cameras: {} };
  }
}

export function saveOpenTimes(t: OpenTimes): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(t));
  } catch {
    // blocked storage: the next open guesses from the defaults
  }
}
