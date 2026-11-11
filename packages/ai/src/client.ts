// The editor's side of the AI worker.
import type { ModelId } from './models.ts';
import type { Request, Response } from './protocol.ts';
import type { Affine, AiSpec, PersonInfo, Progress, RasterResult } from './types.ts';

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
  private calls = new Map<number, { resolve: (v: never) => void; reject: (e: Error) => void }>();
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
      this.onProgress?.(m.progress);
      return;
    }
    const c = this.calls.get(m.id);
    if (!c) return;
    this.calls.delete(m.id);
    if (m.type === 'error') c.reject(new Error(m.message));
    else c.resolve(m.value as never);
  }

  private call<T>(make: (id: number) => Request): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.calls.set(id, { resolve: resolve as (v: never) => void, reject });
      this.post(make(id));
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

  dispose(): void {
    this.reset(new Error('Closed.'));
  }
}
