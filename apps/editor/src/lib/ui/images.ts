// Immich's previews in <img>. With the session cookie a plain src works. With an API key <img>
// can't send the header, so each image is fetched once as a blob; the object URLs live until
// dispose() (when the window or page that shows them goes away).
import { apiUrl, authHeaders, hasApiKey } from '../immich/api.ts';

export const previewUrl = (id: string) => apiUrl(`/assets/${id}/thumbnail?size=preview`);
export const thumbUrl = (id: string) => apiUrl(`/assets/${id}/thumbnail?size=thumbnail`);

export function imageLoader() {
  const blobs = new Map<string, Promise<string | null>>();

  function blobUrl(url: string): Promise<string | null> {
    let hit = blobs.get(url);
    if (!hit) {
      hit = fetch(url, { headers: authHeaders(), credentials: 'same-origin' })
        .then((r) => (r.ok ? r.blob() : null))
        .then((b) => (b ? URL.createObjectURL(b) : null))
        .catch(() => null);
      blobs.set(url, hit);
    }
    return hit;
  }

  /** Svelte action: `<img use:img={url}>`. */
  function img(node: HTMLImageElement, url: string) {
    let wanted = url;
    const show = (u: string) => {
      wanted = u;
      if (!hasApiKey()) {
        node.src = u;
        return;
      }
      void blobUrl(u).then((b) => {
        if (b && wanted === u) node.src = b;
      });
    };
    show(url);
    return { update: show };
  }

  /** Loads an image ahead, so it shows at once later. */
  function preload(url: string) {
    if (hasApiKey()) void blobUrl(url);
    else new Image().src = url;
  }

  function dispose() {
    for (const p of blobs.values()) void p.then((u) => u && URL.revokeObjectURL(u));
  }

  return { img, preload, dispose };
}
