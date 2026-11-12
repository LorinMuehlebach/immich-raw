// Where an album export goes: a folder the user picks (Chrome and Edge, secure pages only), or
// else one ZIP download. Existing files are never overwritten: "a.jpg" becomes "a (2).jpg".
import { downloadBlob } from '../download.ts';
import { ZipWriter } from './zip.ts';

export interface Destination {
  /** "Folder Exports" or "photos.zip". */
  readonly label: string;
  /** Writes one file and returns the name it got. */
  write(name: string, bytes: Uint8Array): Promise<string>;
  /** Called once at the end (the ZIP is downloaded then). */
  finish(): Promise<void>;
}

/** "a.jpg" -> "a (2).jpg" -> "a (3).jpg", case-insensitively unique among `taken`. */
export function uniqueName(name: string, isTaken: (lowerName: string) => boolean): string {
  if (!isTaken(name.toLowerCase())) return name;
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 2; ; n++) {
    const candidate = `${base} (${n})${ext}`;
    if (!isTaken(candidate.toLowerCase())) return candidate;
  }
}

// The File System Access API isn't in TypeScript's DOM types yet.
interface WritableFile {
  write(data: BufferSource | Blob): Promise<void>;
  close(): Promise<void>;
}
interface FileHandle {
  createWritable(): Promise<WritableFile>;
}
interface DirectoryHandle {
  readonly name: string;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FileHandle>;
  keys(): AsyncIterable<string>;
}
type PickerWindow = Window & { showDirectoryPicker?: (opts?: { id?: string; mode?: 'read' | 'readwrite'; startIn?: string }) => Promise<DirectoryHandle> };

/** Whether this browser can write into a folder (else the export is one ZIP). */
export function canPickFolder(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext && typeof (window as PickerWindow).showDirectoryPicker === 'function';
}

/** Asks for a folder (must run from a click). Null when the user cancels. */
export async function pickFolder(): Promise<Destination | null> {
  let dir: DirectoryHandle;
  try {
    dir = await (window as PickerWindow).showDirectoryPicker!({ id: 'immich-raw-export', mode: 'readwrite', startIn: 'pictures' });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return null;
    throw e;
  }
  const taken = new Set<string>();
  for await (const name of dir.keys()) taken.add(name.toLowerCase());
  return {
    label: `folder “${dir.name}”`,
    async write(name, bytes) {
      const final = uniqueName(name, (n) => taken.has(n));
      taken.add(final.toLowerCase());
      const file = await (await dir.getFileHandle(final, { create: true })).createWritable();
      try {
        await file.write(bytes as BufferSource);
      } finally {
        await file.close();
      }
      return final;
    },
    async finish() {},
  };
}

/** Collects the files into one ZIP that is downloaded at the end. */
export function zipDestination(zipName: string): Destination {
  const zip = new ZipWriter();
  const taken = new Set<string>();
  return {
    label: zipName,
    async write(name, bytes) {
      const final = uniqueName(name, (n) => taken.has(n));
      taken.add(final.toLowerCase());
      zip.add(final, bytes);
      return final;
    },
    async finish() {
      if (zip.count) downloadBlob(zip.finish(), zipName);
    },
  };
}
