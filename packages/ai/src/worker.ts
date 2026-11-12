// The AI worker: keeps the analysis image of the photos in use, runs the models they need
// (each at most once per photo; results are also kept in IndexedDB) and composes the map of
// each AI component. Start it with `new Worker(..., { type: 'module' })`.
import { analyzeObjectBox, analyzeObjectPoints, analyzePeople, analyzeScene, analyzeSubject, samEmbedding, type SamEmbedding } from './analyze.ts';
import { cacheGet, cachePut } from './cache.ts';
import { composeRaster, listPeople, type Analysis } from './compose.ts';
import { fitSize, luma, normalizeBrightness, resizeRgba } from './image.ts';
import { ANALYSIS_VERSION, tileSide, upscaler } from './models.ts';
import type { Request, Response } from './protocol.ts';
import { Runtime } from './runtime.ts';
import { objectKey } from './spec.ts';
import type { AiSpec, ByteMap, PeopleMaps, RgbaImage, SceneMaps, UpscaleResult } from './types.ts';
import { CANCELLED, upscaleImage } from './upscale/run.ts';

/** Longest side of the image the models and the composing work on. */
export const WORK_SIDE = 2048;

interface Photo {
  image: RgbaImage;
  guide: Float32Array | null;
  subject?: Promise<ByteMap>;
  scene?: Promise<SceneMaps>;
  people?: Promise<PeopleMaps>;
  sam?: Promise<SamEmbedding>;
  objects: Map<string, Promise<ByteMap>>;
}

const scope = self as unknown as { postMessage(m: Response, transfer?: Transferable[]): void; onmessage: ((e: MessageEvent<Request>) => void) | null };
const post = (m: Response, transfer: Transferable[] = []) => scope.postMessage(m, transfer);

let runtime: Runtime | null = null;
/** The photos in use, most recent last (the open one, and one being exported). */
const photos = new Map<string, Photo>();
/** Upscales run one after another (one model session can't run twice at once). */
let upscales: Promise<unknown> = Promise.resolve();
/** The upscale running now: the runtime's progress (a model download) is reported to it. */
let job: number | null = null;
/** Upscales asked to stop. */
const cancelled = new Set<number>();

/** AI Upscale of one image, tile by tile, with progress for request `id`. */
async function upscale(m: Extract<Request, { type: 'upscale' }>): Promise<UpscaleResult> {
  const rt = runtime!;
  const u = upscaler(m.style, m.scale);
  job = m.id;
  try {
    const side = m.side ?? tileSide(u, (await rt.backend()).gpu);
    const { inputs, outputs } = await rt.names(u.model);
    const label = `Upscaling ${m.scale}×`;
    const image: RgbaImage = { width: m.width, height: m.height, data: new Uint8ClampedArray(m.data) };
    const out = await upscaleImage(
      image,
      u,
      m.scale,
      side,
      async (input, s) => {
        const r = await rt.run(u.model, { [inputs[0]!]: await rt.tensor('float32', input, [1, 3, s, s]) }, true);
        return r[outputs[0]!]!.data as Float32Array;
      },
      {
        onTile: (done, total) => post({ type: 'progress', id: m.id, progress: { kind: 'work', label, done, total } }),
        cancelled: () => cancelled.has(m.id),
      },
    );
    return { width: out.width, height: out.height, data: out.data.buffer as ArrayBuffer };
  } finally {
    job = null;
    cancelled.delete(m.id);
  }
}

function photo(key: string): Photo {
  const p = photos.get(key);
  if (!p) throw new Error('The photo is not loaded in the AI worker.');
  photos.delete(key);
  photos.set(key, p);
  return p;
}

/** A per-photo analysis: from memory, the browser's cache, or computed (and stored). */
function cached<T>(key: string, name: string, size: (v: T) => number, compute: () => Promise<T>): Promise<T> {
  const id = `${key}|${name}|v${ANALYSIS_VERSION}`;
  return (async () => {
    const hit = await cacheGet<T>('analyses', id);
    if (hit) return hit;
    const v = await compute();
    void cachePut('analyses', id, v, size(v));
    return v;
  })();
}

const bytesOf = (m: { data: ArrayBufferView }) => m.data.byteLength;
const sceneBytes = (s: SceneMaps) => Object.values(s.maps).reduce((n, m) => n + m!.byteLength, 0);
const peopleBytes = (p: PeopleMaps) => 6 * p.width * p.height + p.faces.length * 4 * 956;

/** Runs `f` once per photo for a slot, forgetting failures so they can be tried again. */
function once<K extends 'subject' | 'scene' | 'people' | 'sam', T>(p: Photo, slot: K, f: () => Promise<T>): Promise<T> {
  let v = p[slot] as Promise<T> | undefined;
  if (!v) {
    v = f();
    (p as unknown as Record<K, Promise<T> | undefined>)[slot] = v;
    v.catch(() => ((p as unknown as Record<K, Promise<T> | undefined>)[slot] = undefined));
  }
  return v;
}

function detecting(label: string): void {
  post({ type: 'progress', progress: { kind: 'detect', label } });
}

async function analysis(key: string, spec: AiSpec): Promise<Analysis> {
  const rt = runtime!;
  const p = photo(key);
  const a: Analysis = { image: p.image };
  const scene = () =>
    once(p, 'scene', () =>
      cached(key, 'scene', sceneBytes, () => {
        detecting('Finding sky and landscape…');
        return analyzeScene(rt, p.image);
      }),
    );
  switch (spec.target) {
    case 'subject':
    case 'background':
      a.subject = await once(p, 'subject', () =>
        cached(key, 'subject', bytesOf, () => {
          detecting('Finding the subject…');
          return analyzeSubject(rt, p.image);
        }),
      );
      break;
    case 'sky':
    case 'landscape':
      a.scene = await scene();
      break;
    case 'people': {
      a.scene = await scene();
      const s = a.scene;
      a.people = await once(p, 'people', () =>
        cached(key, 'people', peopleBytes, () => {
          detecting('Finding people…');
          return analyzePeople(rt, p.image, s);
        }),
      );
      break;
    }
    case 'object': {
      const ok = objectKey(spec);
      let m = p.objects.get(ok);
      if (!m) {
        m = cached(key, `object:${ok}`, bytesOf, async () => {
          detecting('Finding the object…');
          if (spec.box) return analyzeObjectBox(rt, p.image, spec.box);
          const emb = await once(p, 'sam', () => samEmbedding(rt, p.image));
          return analyzeObjectPoints(rt, p.image, emb, spec.points ?? []);
        });
        p.objects.set(ok, m);
        m.catch(() => p.objects.delete(ok));
      }
      a.object = await m;
      break;
    }
  }
  return a;
}

async function handle(m: Request): Promise<void> {
  switch (m.type) {
    case 'init':
      runtime = new Runtime(m.cfg, (progress) => post(job === null ? { type: 'progress', progress } : { type: 'progress', progress, id: job }));
      return;
    case 'cancel':
      cancelled.add(m.id);
      return;
    case 'backend':
    case 'upscale': {
      const run = async () => {
        try {
          if (!runtime) throw new Error('The AI worker was not started.');
          if (m.type === 'backend') {
            post({ type: 'result', id: m.id, value: await runtime.backend() });
          } else {
            const r = await upscale(m);
            post({ type: 'result', id: m.id, value: r }, [r.data]);
          }
        } catch (e) {
          if (m.type === 'upscale' && !(e instanceof Error && e.message === CANCELLED)) console.error('AI Upscale:', e);
          post({ type: 'error', id: m.id, message: e instanceof Error ? e.message : String(e) });
        }
      };
      if (m.type === 'backend') return run();
      // Cancelled while waiting for its turn: never starts.
      upscales = upscales.then(() => (cancelled.delete(m.id) ? post({ type: 'error', id: m.id, message: CANCELLED }) : run()));
      return;
    }
    case 'photo': {
      const raw: RgbaImage = { width: m.width, height: m.height, data: new Uint8ClampedArray(m.data) };
      const [w, h] = fitSize(raw.width, raw.height, WORK_SIDE);
      photos.delete(m.key);
      photos.set(m.key, { image: normalizeBrightness(resizeRgba(raw, w, h)), guide: null, objects: new Map() });
      while (photos.size > 2) photos.delete(photos.keys().next().value!);
      return;
    }
    case 'raster':
    case 'people':
    case 'missing':
      try {
        if (!runtime) throw new Error('The AI worker was not started.');
        if (m.type === 'missing') {
          post({ type: 'result', id: m.id, value: await runtime.missingBytes(m.models) });
        } else if (m.type === 'people') {
          const a = await analysis(m.key, { target: 'people', parts: ['person'] });
          post({ type: 'result', id: m.id, value: a.people ? listPeople(a.people) : [] });
        } else {
          const a = await analysis(m.key, m.spec);
          const p = photo(m.key);
          p.guide ??= luma(p.image);
          const r = composeRaster(m.spec, a, { width: m.width, height: m.height, sToT: m.sToT }, p.guide);
          post({ type: 'result', id: m.id, value: r }, [r.data.buffer]);
        }
      } catch (e) {
        console.error('AI masks:', e);
        post({ type: 'error', id: m.id, message: e instanceof Error ? e.message : String(e) });
      }
      return;
  }
}

scope.onmessage = (e) => void handle(e.data);
