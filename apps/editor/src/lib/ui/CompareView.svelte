<script lang="ts">
  // Compare (C): another photo next to the one being edited, zoomed and panned with it. It shows
  // the photo's look (looks.ts: as the editor showed it last, else its saved JPEG, else Immich's
  // preview); zoomed in, Immich's full-size image when Immich makes those.
  import { apiUrl, authHeaders, hasApiKey } from '../immich/api.ts';
  import { looks } from '../immich/looks.ts';
  import { VIEW_PAD, fitScale } from '../state/zoom.ts';

  interface Props {
    candidateId: string;
    name: string;
    /** The editor's zoom: device pixels per full-resolution pixel, view centre in frame coordinates. */
    zoom: { on: boolean; cx: number; cy: number; scale: number };
    /** The size of the photo being edited (its zoom scale is relative to it). */
    frame: { width: number; height: number };
  }

  let { candidateId, name, zoom, frame }: Props = $props();

  let paneW = $state(0);
  let paneH = $state(0);
  let src = $state<string | null>(null);
  let aspect = $state<number | null>(null);
  let full = $state(false);
  let owned: string | null = null;

  const fetchBlob = (url: string) =>
    fetch(url, hasApiKey() ? { headers: authHeaders() } : { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.blob() : null))
      .catch(() => null);

  function show(url: string, own: boolean) {
    if (owned) URL.revokeObjectURL(owned);
    owned = own ? url : null;
    src = url;
  }

  // The candidate's look, at once when the filmstrip got it ready.
  $effect(() => {
    const id = candidateId;
    full = false;
    aspect = null;
    const ready = looks.hint(id).look;
    if (ready) {
      show(URL.createObjectURL(ready.image), true);
      return;
    }
    let gone = false;
    void fetchBlob(apiUrl(`/assets/${id}/thumbnail?size=preview`)).then((b) => {
      if (b && !gone) show(URL.createObjectURL(b), true);
    });
    return () => {
      gone = true;
    };
  });

  /** How much bigger than fitted the editor shows its photo. */
  const vp = $derived({ width: paneW, height: paneH, dpr: devicePixelRatio || 1 });
  const magnify = $derived(zoom.on && paneW > 0 ? zoom.scale / fitScale(frame, vp) : 1);

  // Zoomed past the preview's detail: Immich's full-size image, if it makes them.
  $effect(() => {
    if (magnify < 1.5 || full) return;
    const id = candidateId;
    full = true;
    void fetchBlob(apiUrl(`/assets/${id}/thumbnail?size=fullsize`)).then((b) => {
      if (b && id === candidateId) show(URL.createObjectURL(b), true);
    });
  });

  /** Where the photo goes: fitted like the editor's, magnified and centred on the same point. */
  const box = $derived.by(() => {
    if (!aspect || paneW <= 0) return null;
    const maxW = Math.max(50, paneW - VIEW_PAD * 2);
    const maxH = Math.max(50, paneH - VIEW_PAD * 2);
    let w = maxW;
    let h = w / aspect;
    if (h > maxH) {
      h = maxH;
      w = h * aspect;
    }
    w *= magnify;
    h *= magnify;
    const cx = zoom.on ? zoom.cx : 0.5;
    const cy = zoom.on ? zoom.cy : 0.5;
    return { w, h, left: paneW / 2 - cx * w, top: paneH / 2 - cy * h };
  });

  $effect(() => () => {
    if (owned) URL.revokeObjectURL(owned);
  });
</script>

<div class="compare" bind:clientWidth={paneW} bind:clientHeight={paneH}>
  {#if src}
    <img
      {src}
      alt={name}
      class:shown={!!box}
      style:width={box ? `${box.w}px` : null}
      style:height={box ? `${box.h}px` : null}
      style:left={box ? `${box.left}px` : null}
      style:top={box ? `${box.top}px` : null}
      onload={(e) => {
        const img = e.currentTarget as HTMLImageElement;
        if (img.naturalWidth && img.naturalHeight) aspect = img.naturalWidth / img.naturalHeight;
      }}
      draggable="false"
    />
  {/if}
  <div class="label">{name} · <kbd>←</kbd><kbd>→</kbd> another · <kbd>Enter</kbd> open · <kbd>C</kbd> close</div>
</div>

<style>
  .compare {
    position: relative;
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    background: var(--bg-view);
    border-left: 1px solid #111;
  }
  img {
    position: absolute;
    visibility: hidden;
    box-shadow: 0 2px 18px rgba(0, 0, 0, 0.6);
    user-select: none;
  }
  img.shown {
    visibility: visible;
  }
  .label {
    position: absolute;
    top: 8px;
    left: 50%;
    transform: translateX(-50%);
    padding: 3px 8px;
    border-radius: 4px;
    font-size: 11px;
    white-space: nowrap;
    color: var(--text);
    background: rgba(0, 0, 0, 0.6);
    pointer-events: none;
  }
  kbd {
    font-size: 10px;
  }
</style>
