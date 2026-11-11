// Upload through XMLHttpRequest instead of the SDK: we need upload progress and the
// x-immich-checksum header.
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

export async function sha1Base64(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', await blob.arrayBuffer());
  let binary = '';
  for (const b of new Uint8Array(digest)) binary += String.fromCharCode(b);
  return btoa(binary);
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
