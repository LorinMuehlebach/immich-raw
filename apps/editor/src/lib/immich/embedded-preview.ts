// The camera's own JPEG of a RAF, taken from the start of the download: a Fujifilm RAF keeps it in
// its first few megabytes, so it can show while the other twenty-odd are still on their way.
import { rafPreviewRange, readRafPreview } from '@immich-raw/decoder';

export interface EmbeddedPreview {
  /** Hand it the file's bytes so far (the whole file when `done`); settles `ready` once it knows. */
  onData(bytes: Uint8Array, done: boolean): void;
  /** The camera's JPEG, or null when the file has none (not a RAF) or ended without it. */
  ready: Promise<Blob | null>;
}

export function watchEmbeddedPreview(): EmbeddedPreview {
  let settle!: (blob: Blob | null) => void;
  const ready = new Promise<Blob | null>((resolve) => (settle = resolve));
  let settled = false;
  let end = 0;
  const finish = (blob: Blob | null) => {
    settled = true;
    settle(blob);
  };
  return {
    ready,
    onData(bytes, done) {
      if (settled) return;
      if (!end) {
        if (bytes.length < 92) return done ? finish(null) : undefined;
        const range = rafPreviewRange(bytes);
        if (!range) return finish(null);
        end = range.end;
      }
      if (bytes.length < end) return done ? finish(null) : undefined;
      const jpeg = readRafPreview(bytes);
      finish(jpeg ? new Blob([jpeg as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' }) : null);
    },
  };
}
