// Upload through XMLHttpRequest instead of the SDK: we need upload progress and the
// x-immich-checksum header.
import { sha1 } from '@noble/hashes/legacy.js';
import { apiUrl, authHeaders } from './api.ts';

export interface UploadOptions {
  file: Blob;
  filename: string;
  fileCreatedAt: string;
  fileModifiedAt: string;
  isFavorite?: boolean;
  metadata?: { key: string; value: Record<string, unknown> }[];
  /** Base64 SHA-1 of the file, used by Immich for duplicate detection. */
  checksum: string;
}

export interface UploadResult {
  id: string;
  status: 'created' | 'duplicate';
}

/** Base64 SHA-1 of a file, the checksum Immich uses to find duplicates. */
export async function sha1Base64(blob: Blob): Promise<string> {
  // WebCrypto exists only on secure pages (HTTPS, localhost).
  const digest = globalThis.crypto?.subtle ? new Uint8Array(await crypto.subtle.digest('SHA-1', await blob.arrayBuffer())) : await sha1Js(blob);
  let binary = '';
  for (const b of digest) binary += String.fromCharCode(b);
  return btoa(binary);
}

const SHA1_CHUNK = 4 * 1024 * 1024;

/** SHA-1 in JavaScript, 4 MB at a time with a pause in between, so a 60 MB DNG doesn't freeze the page. */
export async function sha1Js(blob: Blob, chunk = SHA1_CHUNK): Promise<Uint8Array> {
  const hash = sha1.create();
  for (let at = 0; at < blob.size; at += chunk) {
    hash.update(new Uint8Array(await blob.slice(at, at + chunk).arrayBuffer()));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return hash.digest();
}

export function uploadAsset(opts: UploadOptions, onProgress?: (fraction: number) => void): Promise<UploadResult> {
  const form = new FormData();
  form.append('assetData', opts.file, opts.filename);
  form.append('fileCreatedAt', opts.fileCreatedAt);
  form.append('fileModifiedAt', opts.fileModifiedAt);
  form.append('filename', opts.filename);
  if (opts.isFavorite !== undefined) form.append('isFavorite', String(opts.isFavorite));
  // Immich parses the metadata field as a JSON string (verified in M0).
  if (opts.metadata?.length) form.append('metadata', JSON.stringify(opts.metadata));

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', apiUrl('/assets'));
    xhr.withCredentials = true;
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.setRequestHeader('x-immich-checksum', opts.checksum);
    for (const [k, v] of Object.entries(authHeaders())) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onerror = () => reject(new Error('Upload failed: network error.'));
    xhr.onabort = () => reject(new Error('Upload was cancelled.'));
    xhr.onload = () => {
      let body: { id?: string; status?: string; message?: string } | null = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // fall through to the status check
      }
      if ((xhr.status === 200 || xhr.status === 201) && body?.id) {
        onProgress?.(1);
        resolve({ id: body.id, status: body.status === 'duplicate' ? 'duplicate' : 'created' });
      } else {
        const detail = body?.message ? `: ${body.message}` : '';
        reject(new Error(`Upload failed (HTTP ${xhr.status})${detail}`));
      }
    };
    xhr.send(form);
  });
}
