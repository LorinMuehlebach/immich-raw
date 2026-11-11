// Runs the models (inside the AI worker): downloads and caches the files, and keeps
// ONNX Runtime and MediaPipe sessions. Both runtimes are loaded from the editor's own origin
// (copied there by the build, like LibRaw), only the model weights come from the CDN.
import type * as OrtModule from 'onnxruntime-web';
import type * as VisionModule from '@mediapipe/tasks-vision';
import { cacheGet, cacheHas, cachePut } from './cache.ts';
import { MODELS, type ModelId } from './models.ts';
import type { Progress } from './types.ts';

export interface RuntimeConfig {
  /** URL prefix of the ONNX Runtime files (ends with /). */
  ortBase: string;
  /** URL prefix of the MediaPipe files (ends with /). */
  mediapipeBase: string;
}

type Ort = typeof OrtModule;
type Vision = typeof VisionModule;
/** What FilesetResolver.forVisionTasks resolves to (the type isn't exported). */
type WasmFileset = Awaited<ReturnType<Vision['FilesetResolver']['forVisionTasks']>>;
export type Tensor = OrtModule.Tensor;

export class Runtime {
  private ort: Promise<Ort> | null = null;
  private vision: Promise<{ v: Vision; fileset: WasmFileset; factory: unknown }> | null = null;
  private downloads = new Map<ModelId, Promise<Uint8Array>>();
  /** Loaded ONNX sessions, most recently used last (big ones are let go, see session()). */
  private sessions = new Map<ModelId, Promise<OrtModule.InferenceSession>>();
  private gpuFailed = false;
  private segmenter: Promise<VisionModule.ImageSegmenter> | null = null;
  private landmarker: Promise<VisionModule.FaceLandmarker> | null = null;

  constructor(
    private cfg: RuntimeConfig,
    private progress: (p: Progress) => void,
  ) {}

  /** Bytes still to download for these models. */
  async missingBytes(ids: ModelId[]): Promise<number> {
    let n = 0;
    for (const id of new Set(ids)) if (!(await cacheHas('models', MODELS[id].url))) n += MODELS[id].bytes;
    return n;
  }

  /** The model file, from the browser's cache or downloaded (with progress). */
  model(id: ModelId): Promise<Uint8Array> {
    let p = this.downloads.get(id);
    if (!p) {
      p = this.download(id);
      this.downloads.set(id, p);
      p.catch(() => this.downloads.delete(id));
    }
    return p;
  }

  private async download(id: ModelId): Promise<Uint8Array> {
    const m = MODELS[id];
    const cached = await cacheGet<ArrayBuffer>('models', m.url);
    if (cached && cached.byteLength === m.bytes) return new Uint8Array(cached);
    const res = await fetch(m.url, { mode: 'cors', credentials: 'omit' });
    if (!res.ok || !res.body) throw new Error(`The ${m.label} could not be downloaded (HTTP ${res.status}).`);
    const buf = new Uint8Array(m.bytes);
    const reader = res.body.getReader();
    let loaded = 0;
    let last = 0;
    this.progress({ kind: 'download', label: m.label, loaded: 0, total: m.bytes });
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (loaded + value.length > buf.length) throw new Error(`The ${m.label} download is larger than expected.`);
      buf.set(value, loaded);
      loaded += value.length;
      if (performance.now() - last > 200) {
        last = performance.now();
        this.progress({ kind: 'download', label: m.label, loaded, total: m.bytes });
      }
    }
    if (loaded !== m.bytes) throw new Error(`The ${m.label} download was incomplete.`);
    this.progress({ kind: 'download', label: m.label, loaded, total: m.bytes });
    await cachePut('models', m.url, buf.buffer, buf.length);
    return buf;
  }

  private loadOrt(): Promise<Ort> {
    this.ort ??= (async () => {
      const ort = (await import(/* @vite-ignore */ `${this.cfg.ortBase}ort.webgpu.min.js`)) as Ort;
      ort.env.wasm.wasmPaths = { mjs: `${this.cfg.ortBase}ort-wasm-simd-threaded.asyncify.js`, wasm: `${this.cfg.ortBase}ort-wasm-simd-threaded.asyncify.wasm` };
      // Threads need cross-origin isolation (HTTPS with the editor's headers).
      ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)) : 1;
      ort.env.logLevel = 'error';
      return ort;
    })();
    return this.ort;
  }

  private gpu: Promise<boolean> | null = null;

  /**
   * Is a real GPU there? navigator.gpu can exist without an adapter, or with a software one
   * (much slower than the CPU path).
   */
  private gpuUsable(): Promise<boolean> {
    type Adapter = { isFallbackAdapter?: boolean; info?: { isFallbackAdapter?: boolean } };
    this.gpu ??= (async () => {
      const gpu = (navigator as unknown as { gpu?: { requestAdapter(o?: object): Promise<unknown> } }).gpu;
      try {
        const a = (await gpu?.requestAdapter({ powerPreference: 'high-performance' })) as Adapter | null | undefined;
        return !!a && !a.isFallbackAdapter && !a.info?.isFallbackAdapter;
      } catch {
        return false;
      }
    })();
    return this.gpu;
  }

  private async createSession(id: ModelId, gpu: boolean): Promise<OrtModule.InferenceSession> {
    const ort = await this.loadOrt();
    const bytes = await this.model(id);
    this.progress({ kind: 'detect', label: `Loading the ${MODELS[id].label}…` });
    console.info(`AI masks: ${MODELS[id].label} on ${gpu ? 'WebGPU' : `the CPU (${ort.env.wasm.numThreads} thread${ort.env.wasm.numThreads === 1 ? '' : 's'})`}`);
    return ort.InferenceSession.create(bytes, {
      executionProviders: gpu ? ['webgpu', 'wasm'] : ['wasm'],
      graphOptimizationLevel: 'all',
      // The arena grows in big doubling steps that a 4 GB WASM heap can't always take (the
      // spike saw it fail at 800 MB); plain allocations keep the peak lower.
      enableCpuMemArena: false,
      // Errors only (it warns about every op it keeps on the CPU next to WebGPU).
      logSeverityLevel: 3,
    });
  }

  /** Lets go of every session but `keep`'s (their memory goes back to the WASM heap). */
  private async releaseAll(keep?: ModelId): Promise<void> {
    const all = [...this.sessions].filter(([id]) => id !== keep);
    for (const [id] of all) this.sessions.delete(id);
    await Promise.all(all.map(([, sp]) => sp.then((x) => x.release()).catch(() => {})));
  }

  /** Creates the session of `id` (registered in this.sessions by the caller while it loads). */
  private async open(id: ModelId): Promise<OrtModule.InferenceSession> {
    // A big model gets the memory to itself.
    if (MODELS[id].bytes > 1e8) await this.releaseAll(id);
    const gpu = !this.gpuFailed && (await this.gpuUsable());
    try {
      return await this.createSession(id, gpu);
    } catch (e) {
      // Out of memory, or a GPU that fails: start over on the CPU with nothing else loaded.
      console.warn(`AI masks: loading the ${MODELS[id].label} failed (${e instanceof Error ? e.message : e}); trying again on the CPU.`);
      if (gpu) this.gpuFailed = true;
      await this.releaseAll(id);
      try {
        return await this.createSession(id, false);
      } catch (e2) {
        const msg = e2 instanceof Error ? e2.message : String(e2);
        throw new Error(/allocate|memory/i.test(msg) ? `Not enough memory in this browser tab for the ${MODELS[id].label}. Close other tabs and try again.` : msg);
      }
    }
  }

  private async session(id: ModelId): Promise<OrtModule.InferenceSession> {
    let s = this.sessions.get(id);
    if (s) {
      this.sessions.delete(id);
      this.sessions.set(id, s);
      return s;
    }
    s = this.open(id);
    this.sessions.set(id, s);
    s.catch(() => this.sessions.delete(id));
    // Keep the two most recent sessions: the big models need a lot of memory.
    while (this.sessions.size > 2) {
      const [old, sp] = this.sessions.entries().next().value!;
      this.sessions.delete(old);
      sp.then((x) => x.release()).catch(() => {});
    }
    return s;
  }

  async tensor(type: 'float32', data: Float32Array, dims: number[]): Promise<Tensor>;
  async tensor(type: 'int64', data: BigInt64Array, dims: number[]): Promise<Tensor>;
  async tensor(type: 'float32' | 'int64', data: Float32Array | BigInt64Array, dims: number[]): Promise<Tensor> {
    const ort = await this.loadOrt();
    return new ort.Tensor(type, data, dims);
  }

  /** Runs a model; on a GPU failure it starts over on the CPU once. */
  async run(id: ModelId, feeds: Record<string, Tensor>): Promise<Record<string, Tensor>> {
    const s = await this.session(id);
    this.progress({ kind: 'detect', label: `Running the ${MODELS[id].label}…` });
    try {
      return await s.run(feeds);
    } catch (e) {
      if (this.gpuFailed || !(await this.gpuUsable())) throw e;
      console.warn(`AI masks: the GPU failed (${e instanceof Error ? e.message : e}); using the CPU.`);
      this.gpuFailed = true;
      await this.releaseAll();
      return (await this.session(id)).run(feeds);
    }
  }

  /** Input and output names of a model. */
  async names(id: ModelId): Promise<{ inputs: readonly string[]; outputs: readonly string[] }> {
    const s = await this.session(id);
    return { inputs: s.inputNames, outputs: s.outputNames };
  }

  private loadVision(): Promise<{ v: Vision; fileset: WasmFileset; factory: unknown }> {
    this.vision ??= (async () => {
      const base = this.cfg.mediapipeBase;
      const v = (await import(/* @vite-ignore */ `${base}vision_bundle.js`)) as Vision;
      // true: the ES module build of the WASM loader (this is a module worker).
      const fileset = await v.FilesetResolver.forVisionTasks(base.replace(/\/$/, ''), true);
      // MediaPipe loads that loader again for every task and expects it to set
      // self.ModuleFactory each time, which it then clears. A module runs only once, so the
      // second task would find nothing: keep the factory and hand it over before each task.
      const factory = ((await import(/* @vite-ignore */ fileset.wasmLoaderPath)) as { default: unknown }).default;
      return { v, fileset, factory };
    })();
    this.vision.catch(() => (this.vision = null));
    return this.vision;
  }

  /** Tasks are created one at a time (each takes the module factory). */
  private creating: Promise<unknown> = Promise.resolve();

  private createTask<T>(make: (v: Vision, fileset: WasmFileset) => Promise<T>): Promise<T> {
    const run = this.creating.then(async () => {
      const { v, fileset, factory } = await this.loadVision();
      (self as unknown as { ModuleFactory?: unknown }).ModuleFactory = factory;
      return make(v, fileset);
    });
    this.creating = run.catch(() => {});
    return run;
  }

  segmenterTask(): Promise<VisionModule.ImageSegmenter> {
    this.segmenter ??= (async () => {
      const bytes = await this.model('peopleParts');
      return this.createTask((v, fileset) =>
        v.ImageSegmenter.createFromOptions(fileset, {
          baseOptions: { modelAssetBuffer: bytes, delegate: 'CPU' },
          runningMode: 'IMAGE',
          outputCategoryMask: false,
          outputConfidenceMasks: true,
        }),
      );
    })();
    this.segmenter.catch(() => (this.segmenter = null));
    return this.segmenter;
  }

  landmarkerTask(): Promise<VisionModule.FaceLandmarker> {
    this.landmarker ??= (async () => {
      const bytes = await this.model('faceLandmarks');
      return this.createTask((v, fileset) =>
        v.FaceLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetBuffer: bytes, delegate: 'CPU' },
          runningMode: 'IMAGE',
          numFaces: 1,
          minFaceDetectionConfidence: 0.3,
          minFacePresenceConfidence: 0.3,
        }),
      );
    })();
    this.landmarker.catch(() => (this.landmarker = null));
    return this.landmarker;
  }
}
