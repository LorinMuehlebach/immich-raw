// The editor's side of the AI worker.
import type { ModelId, UpscaleScale, UpscaleStyle } from './models.ts';
import type { Request, Response } from './protocol.ts';
import type { Affine, AiSpec, BackendInfo, PersonInfo, Progress, RasterResult, RgbaImage } from './types.ts';

/** A running AI Upscale. */
export interface UpscaleTask {
  promise: Promise<RgbaImage>;
  /** Stops it before its next tile; the promise then rejects with "Cancelled.". */
  cancel(): void;
}

export interface UpscaleRequest {
  style: UpscaleStyle;
  scale: UpscaleScale;
  /** Input tile size; leave out for the best one for the GPU or CPU. */
  side?: number;
  image: RgbaImage;
  /** Hand the pixels over instead of copying them (`image` is unusable afterwards). */
  transfer?: boolean;
}

export interface AiClientOptions {
  /** e.g. () => new Worker(new URL('./ai.worker.ts', import.meta.url), { type: 'module' }) */
  createWorker: () => Worker;
  /** URL prefixes of the ONNX Runtime and MediaPipe files (ending with /). */
  ortBase: string;
  mediapipeBase: string;
}

/** Photos the worker keeps (it drops older ones; see worker.ts). */
const WORKER_PHOTOS = 2;

export class AiClient {
  onProgress: ((p: Progress) => void) | null = null;
  private worker: Worker | null = null;
  private seq = 0;
  private calls = new Map<number, { resolve: (v: never) => void; reject: (e: Error) => void; progress?: (p: Progress) => void }>();
  /** Photos sent to the worker, most recent last. */
  private sent: string[] = [];

  constructor(private opts: AiClientOptions) {}

  private post(m: Request, transfer: Transferable[] = []): void {
    if (!this.worker) {
      const w = this.opts.createWorker();
      w.onmessage = (e: MessageEvent<Response>) => this.receive(e.data);
      w.onerror = (e) => {
        e.preventDefault();
        this.reset(new Error(e.message || 'The AI worker stopped.'));
      };
      this.worker = w;
      w.postMessage({ type: 'init', cfg: { ortBase: this.opts.ortBase, mediapipeBase: this.opts.mediapipeBase } } satisfies Request);
    }
    this.worker.postMessage(m, transfer);
  }

  private reset(error: Error): void {
    this.worker?.terminate();
    this.worker = null;
    this.sent = [];
    for (const c of this.calls.values()) c.reject(error);
    this.calls.clear();
  }

  private receive(m: Response): void {
    if (m.type === 'progress') {
      const own = m.id === undefined ? undefined : this.calls.get(m.id)?.progress;
      if (own) own(m.progress);
      else this.onProgress?.(m.progress);
      return;
    }
    const c = this.calls.get(m.id);
    if (!c) return;
    this.calls.delete(m.id);
    if (m.type === 'error') c.reject(new Error(m.message));
    else c.resolve(m.value as never);
  }

  private call<T>(make: (id: number) => Request, transfer: Transferable[] = [], progress?: (p: Progress) => void): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.calls.set(id, { resolve: resolve as (v: never) => void, reject, progress });
      this.post(make(id), transfer);
    });
  }

  hasPhoto(key: string): boolean {
    return this.sent.includes(key);
  }

  /** Hands the worker the image the models look at for photo `key` (copied). */
  setPhoto(key: string, image: { width: number; height: number; data: Uint8ClampedArray }): void {
    const data = image.data.slice().buffer;
    this.post({ type: 'photo', key, width: image.width, height: image.height, data }, [data]);
    this.sent = [...this.sent.filter((k) => k !== key), key].slice(-WORKER_PHOTOS);
  }

  /** The map of one component, width x height over the decoded image. */
  raster(key: string, spec: AiSpec, out: { width: number; height: number; sToT: Affine }): Promise<RasterResult> {
    return this.call((id) => ({ type: 'raster', id, key, spec, ...out }));
  }

  /** The people in photo `key`, for the People picker. */
  people(key: string): Promise<PersonInfo[]> {
    return this.call((id) => ({ type: 'people', id, key }));
  }

  /** Bytes still to download before these models can run. */
  missingBytes(models: ModelId[]): Promise<number> {
    return this.call((id) => ({ type: 'missing', id, models }));
  }

  /** Where the models run (a GPU, or the CPU and how many threads). */
  backend(): Promise<BackendInfo> {
    return this.call((id) => ({ type: 'backend', id }));
  }

  /**
   * AI Upscale of `req.image` (copied unless `transfer`). `onProgress` gets the model download
   * and one step per tile.
   */
  upscale(req: UpscaleRequest, onProgress?: (p: Progress) => void): UpscaleTask {
    const px = req.image.data;
    const whole = px.byteOffset === 0 && px.byteLength === px.buffer.byteLength && px.buffer instanceof ArrayBuffer;
    const data = req.transfer && whole ? (px.buffer as ArrayBuffer) : px.slice().buffer;
    let taskId = 0;
    const promise = this.call<{ width: number; height: number; data: ArrayBuffer }>(
      (id) => {
        taskId = id;
        return { type: 'upscale', id, style: req.style, scale: req.scale, side: req.side ?? null, width: req.image.width, height: req.image.height, data };
      },
      [data],
      onProgress,
    ).then((r) => ({ width: r.width, height: r.height, data: new Uint8ClampedArray(r.data) }));
    return {
      promise,
      cancel: () => {
        if (this.worker && this.calls.has(taskId)) this.worker.postMessage({ type: 'cancel', id: taskId } satisfies Request);
      },
    };
  }

  dispose(): void {
    this.reset(new Error('Closed.'));
  }
}
