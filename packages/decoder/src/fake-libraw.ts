// A stand-in for libraw-wasm's LibRaw class in libraw.test.ts. It logs when instances are made
// and disposed. The log lives on globalThis: the test loads this module by URL, which may give
// it a module instance of its own.
const g = globalThis as { fakeLibRawLog?: string[] };

export function fakeLibRawLog(): string[] {
  g.fakeLibRawLog ??= [];
  return g.fakeLibRawLog;
}

let count = 0;

export default class FakeLibRaw {
  private readonly n = ++count;

  constructor() {
    fakeLibRawLog().push(`new ${this.n}`);
  }

  async open(): Promise<void> {}

  async metadata(): Promise<Record<string, unknown>> {
    return { width: 8, height: 8, top_margin: 0, left_margin: 0, raw_width: 8, raw_height: 8 };
  }

  private stopped: ((e: Error) => void) | null = null;

  /** Runs until the instance is disposed, like a long decode that gets stopped. */
  imageData(): Promise<unknown> {
    return new Promise((_resolve, reject) => (this.stopped = reject));
  }

  dispose(): void {
    fakeLibRawLog().push(`dispose ${this.n}`);
    this.stopped?.(new Error('LibRaw disposed'));
    this.stopped = null;
  }
}
