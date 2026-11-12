// Client for the culler service (services/culler), served next to Immich at /immich-raw/culler/.
// The service is optional: when it isn't installed the proxy answers 404 or 502 with an HTML
// page, every call here returns null, and the editor hides its controls.
import { authHeaders } from './api.ts';

const BASE = `${import.meta.env.BASE_URL}culler/api/v1`;
const ABSENT = new Set([404, 502, 503, 504]);

export type CullRole = 'best' | 'runner-up' | 'rejected';
export type CullReason = 'lighting' | 'blur' | 'eyes';

export interface CullMetrics {
  evVsBest?: number;
  clipHiPct?: number;
  clipLoPct?: number;
  lighting?: number;
  sharpPct?: number | null;
  faces?: number;
  closed?: number;
  /** How open the eyes are, in %: the faces' average, and the least open face. */
  eyesOpen?: number;
  eyesLeast?: number;
  /** What the exposure was judged on first: the faces, the people, or only the whole photo. */
  judgedOn?: 'faces' | 'people' | 'photo';
  /** Brightness of those faces or people vs their ideal, in stops, and their own clipping. */
  subjectEv?: number;
  subjectClipHiPct?: number;
  subjectClipLoPct?: number;
  /** People found (also without a visible face). */
  people?: number;
  /** Smiling faces, of the faces whose smile could be read. */
  smiling?: number;
  smileFaces?: number;
}

/** What the service last decided for one photo. */
export interface CullInfo {
  groupId: string;
  frameId: string;
  role: CullRole | null;
  reason: CullReason | null;
  rank: number | null;
  groupSize: number | null;
  pinned: boolean;
  metrics: CullMetrics;
  runId?: string | null;
}

export type RunScope = { kind: 'day'; date: string } | { kind: 'album'; id: string } | { kind: 'assets'; ids: string[] };

export interface RunCounts {
  photos: number;
  frames: number;
  groups: number;
  runnerUps: number;
  rejected: Record<CullReason, number>;
  released: number;
  pending: number;
  excluded: number;
  /** Of the excluded: shots whose stack the user took apart in Immich (a run with force includes them). */
  takenApart?: number;
  changes: number;
  errors?: number;
}

/** One shot of a stack in a run's report. */
export interface ReportFrame {
  frameId: string;
  name: string;
  /** Every file of the shot (RAW, camera JPEG, edits). */
  assetIds: string[];
  /** The file Immich shows for it: the newest edit, else the camera JPEG, else the RAW. */
  faceId: string;
  taken: string | null;
  role: CullRole;
  reason: CullReason | null;
  rank: number;
  pinned: boolean;
  metrics: CullMetrics;
  /** The user added it to this stack. */
  joined?: boolean;
}

/** A shot of the run's photos that is in no stack. */
export interface ReportSingle {
  frameId: string;
  name: string;
  assetIds: string[];
  faceId: string;
  taken: string | null;
  /** Why the culler leaves it alone (taken out of a stack before), or null. */
  leftAlone: string | null;
  /** Immich hasn't made its preview yet. */
  pending: boolean;
}

/** The user's own changes to the stacks: shots taken out of their stack, shots added to one (by the
 * frame ids of the stack it joins). The culler remembers them for later runs. */
export interface RunEdits {
  remove: string[];
  join: Record<string, string[]>;
}

/** A stack the run made (or, in a preview, would make). */
export interface ReportGroup {
  id: string;
  primaryId: string | null;
  frames: ReportFrame[];
}

export interface RunReport {
  counts?: Partial<RunCounts>;
  groups?: ReportGroup[];
  singles?: ReportSingle[];
  /** Edits the run couldn't follow, and why. */
  edits?: { ignored: { frameId: string; edit: 'remove' | 'join'; why: string }[] };
  errors?: string[];
  notes?: string[];
}

export interface CullRun {
  id: string;
  origin: string;
  scope: Record<string, unknown>;
  dryRun: boolean;
  /** Also stacks the shots whose stack the user took apart. */
  force?: boolean;
  edits?: RunEdits | null;
  status: 'queued' | 'running' | 'done' | 'failed';
  phase: string | null;
  done: number;
  total: number;
  summary: (Partial<RunCounts> & { notes?: string[] }) | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  undoneAt: string | null;
  sourceRun: string | null;
  /** Only when asked for one run (getRun), not in the list. */
  report?: RunReport | null;
}

export interface CullerStatus {
  ok: boolean;
  tagRoot: string;
  eyes: boolean | null;
  /** The people model is there (null until the service's first run). */
  people?: boolean | null;
  owner?: string | null;
  watcher?: { enabled: boolean; autoApply: boolean };
}

export class CullerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
let fetchImpl: FetchLike = (input, init) => fetch(input, init);

/** Tests swap in a fake fetch. */
export function setCullerFetch(f: FetchLike): void {
  fetchImpl = f;
  status = null;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T | null> {
  const headers: Record<string, string> = { Accept: 'application/json', ...authHeaders() };
  if (method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    headers['X-Raw-Editor'] = '1';
  }
  let res: Response;
  try {
    res = await fetchImpl(`${BASE}${path}`, {
      method,
      credentials: 'same-origin',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    return null; // network error: treat like a missing service
  }
  const isJson = (res.headers.get('content-type') ?? '').includes('application/json');
  if (!res.ok) {
    if (ABSENT.has(res.status) && !isJson) return null;
    const message = isJson ? (((await res.json()) as { message?: string }).message ?? res.statusText) : res.statusText;
    throw new CullerError(res.status, message);
  }
  return isJson ? ((await res.json()) as T) : null;
}

let status: Promise<CullerStatus | null> | null = null;

/** The service's state for the logged-in user, or null when it isn't installed (cached). */
export function cullerStatus(refresh = false): Promise<CullerStatus | null> {
  if (!status || refresh) {
    status = call<CullerStatus>('GET', '/me').catch((e) => {
      console.warn('Culler: not available', e);
      return null;
    });
  }
  return status;
}

export async function lookupCull(ids: string[]): Promise<Record<string, CullInfo> | null> {
  if (!ids.length) return {};
  const out: Record<string, CullInfo> = {};
  for (let i = 0; i < ids.length; i += 2000) {
    const res = await call<{ items: Record<string, CullInfo> }>('POST', '/assets/lookup', { ids: ids.slice(i, i + 2000) });
    if (!res) return null;
    Object.assign(out, res.items);
  }
  return out;
}

const runId = (r: { runId: string } | null): string => {
  if (!r) throw new CullerError(502, 'the culler service is not reachable');
  return r.runId;
};

/** What a run started from the editor takes into account (the Auto-stack panel's checkboxes). */
export interface CullOptions {
  /** The exposure of the faces, or else of the people, counts most. */
  peopleFirst: boolean;
  /** Also find people without a visible face. */
  people: boolean;
  /** Among the good shots, the one with the most smiles is the best. */
  smiles: boolean;
  /** Set aside shots with closed eyes. */
  eyes: boolean;
}

export const DEFAULT_CULL_OPTIONS: CullOptions = { peopleFirst: true, people: true, smiles: true, eyes: true };

/** Stored or partial options, with the defaults for anything missing or of the wrong type. */
export function parseCullOptions(value: unknown): CullOptions {
  const o = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const flag = (k: keyof CullOptions) => (typeof o[k] === 'boolean' ? (o[k] as boolean) : DEFAULT_CULL_OPTIONS[k]);
  return { peopleFirst: flag('peopleFirst'), people: flag('people'), smiles: flag('smiles'), eyes: flag('eyes') };
}

const OPTIONS_KEY = 'raw-editor.cull.options';

/** The choices last made in this browser (the Auto-stack panel and page share them). */
export function loadCullOptions(): CullOptions {
  try {
    return parseCullOptions(JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? 'null'));
  } catch {
    return parseCullOptions(null);
  }
}

export function saveCullOptions(o: CullOptions): void {
  try {
    localStorage.setItem(OPTIONS_KEY, JSON.stringify(o));
  } catch {
    // storage blocked: the choice holds while the page is open
  }
}

/** The service's `options` (its settings sections) for these choices. */
export function runOptions(o: CullOptions): Record<string, Record<string, boolean>> {
  return {
    lighting: { people_first: o.peopleFirst },
    people: { enabled: o.people },
    smiles: { enabled: o.smiles },
    eyes: { enabled: o.eyes },
  };
}

export interface RunExtras {
  options?: CullOptions;
  /** Also stack the shots whose stack the user took apart (a preview forgets nothing). */
  force?: boolean;
  edits?: RunEdits;
}

export async function startRun(scope: RunScope, dryRun: boolean, { options, force, edits }: RunExtras = {}): Promise<string> {
  const body: Record<string, unknown> = { scope, dryRun };
  if (options) body.options = runOptions(options);
  if (force) body.force = true;
  if (edits && (edits.remove.length || Object.keys(edits.join).length)) body.edits = edits;
  return runId(await call('POST', '/runs', body));
}
export const applyRun = async (id: string): Promise<string> => runId(await call('POST', `/runs/${encodeURIComponent(id)}/apply`));
export const undoRun = async (id: string): Promise<string> => runId(await call('POST', `/runs/${encodeURIComponent(id)}/undo`));
export const makeBest = async (groupId: string, assetId: string): Promise<string> =>
  runId(await call('POST', `/groups/${encodeURIComponent(groupId)}/best`, { assetId }));
/** Sorts the group again, e.g. after photos of it were trashed (a group of one is taken apart). */
export const recullGroup = async (groupId: string): Promise<string> => runId(await call('POST', `/groups/${encodeURIComponent(groupId)}/recull`));

export async function getRun(id: string): Promise<CullRun | null> {
  return call<CullRun>('GET', `/runs/${encodeURIComponent(id)}`);
}

export async function listRuns(limit = 20): Promise<CullRun[]> {
  return (await call<{ runs: CullRun[] }>('GET', `/runs?limit=${limit}`))?.runs ?? [];
}

/** The newest applied run that changed something and can still be undone. */
export async function lastUndoableRun(): Promise<CullRun | null> {
  const runs = await listRuns(50);
  return runs.find((r) => !r.dryRun && r.status === 'done' && !r.undoneAt && r.origin !== 'undo' && (r.summary?.changes ?? 0) > 0) ?? null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls until the run has finished; reports progress on the way. */
export async function waitForRun(id: string, onProgress?: (run: CullRun) => void, signal?: AbortSignal, intervalMs = 1000): Promise<CullRun> {
  for (;;) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const run = await getRun(id);
    if (!run) throw new CullerError(502, 'the culler service is not reachable');
    onProgress?.(run);
    if (run.status === 'done' || run.status === 'failed') return run;
    await sleep(intervalMs);
  }
}
