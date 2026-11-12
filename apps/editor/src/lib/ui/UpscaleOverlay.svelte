<script lang="ts">
  // AI Upscale preview: a square on the photo marks a detail (drag it); a loupe in the corner shows
  // that detail upscaled, plain enlargement on the left and the AI model on the right of a divider.
  import { onDestroy, onMount } from 'svelte';
  import { aiConsent } from '../ai.svelte.ts';
  import { editor } from '../state/editor.svelte.ts';
  import { PATCH } from '../state/upscale.svelte.ts';

  let { width, height }: { width: number; height: number } = $props();

  const up = editor.upscale;
  let overlay: HTMLDivElement | undefined = $state();
  let beforeCanvas: HTMLCanvasElement | undefined = $state();
  let afterCanvas: HTMLCanvasElement | undefined = $state();
  /** Where the divider is, 0..1 from the left of the loupe. */
  let split = $state(0.5);
  let drag: { dx: number; dy: number } | null = null;
  let splitting = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const size = $derived(editor.exportSize());
  /** The square in CSS pixels of the view. */
  const square = $derived.by(() => {
    void editor.viewVersion;
    const s = size;
    if (!s) return null;
    const hw = PATCH / 2 / s.width;
    const hh = PATCH / 2 / s.height;
    const a = editor.frameToView(up.patch[0] - hw, up.patch[1] - hh);
    const b = editor.frameToView(up.patch[0] + hw, up.patch[1] + hh);
    if (!a || !b) return null;
    const cx = ((a[0] + b[0]) / 2) * width;
    const cy = ((a[1] + b[1]) / 2) * height;
    // At least big enough to grab.
    const w = Math.max(18, Math.abs(b[0] - a[0]) * width);
    const h = Math.max(18, Math.abs(b[1] - a[1]) * height);
    return { left: cx - w / 2, top: cy - h / 2, width: w, height: h, cx, cy };
  });
  /** The loupe sits in the corner away from the square. */
  const loupeLeft = $derived(!!square && square.cx > width / 2);
  const loupeSize = $derived.by(() => {
    const p = up.preview;
    const native = p ? p.after.width / (window.devicePixelRatio || 1) : PATCH * up.settings.scale;
    return Math.round(Math.max(120, Math.min(native, width * 0.6, height * 0.6, 512)));
  });

  function clampPatch(t: [number, number]): [number, number] {
    const s = size;
    if (!s) return t;
    const hw = Math.min(0.5, PATCH / 2 / s.width);
    const hh = Math.min(0.5, PATCH / 2 / s.height);
    return [Math.min(1 - hw, Math.max(hw, t[0])), Math.min(1 - hh, Math.max(hh, t[1]))];
  }

  function schedule(delay = 350) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void editor.upscalePreview(), delay);
  }

  onMount(() => {
    // Start on the middle of what is on screen (zoomed in: the visible part).
    const t = editor.viewToFrame(0.5, 0.5);
    if (t) up.patch = clampPatch(t);
  });
  onDestroy(() => {
    if (timer) clearTimeout(timer);
  });

  // A new detail, model, scale or edit: preview again.
  $effect(() => {
    void up.patch;
    void up.settings.style;
    void up.settings.scale;
    void editor.historyIndex;
    void editor.historySteps.length;
    schedule();
  });

  // Draw the result: the AI output, and the same detail enlarged plainly for comparison.
  $effect(() => {
    const p = up.preview;
    if (!p || !beforeCanvas || !afterCanvas) return;
    const { width: w, height: h } = p.after;
    afterCanvas.width = beforeCanvas.width = w;
    afterCanvas.height = beforeCanvas.height = h;
    afterCanvas.getContext('2d')!.putImageData(p.after, 0, 0);
    const small = document.createElement('canvas');
    small.width = p.before.width;
    small.height = p.before.height;
    small.getContext('2d')!.putImageData(p.before, 0, 0);
    const ctx = beforeCanvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(small, 0, 0, w, h);
  });

  function startDrag(e: PointerEvent) {
    if (!square) return;
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const r = overlay!.getBoundingClientRect();
    drag = { dx: e.clientX - r.left - square.cx, dy: e.clientY - r.top - square.cy };
  }

  function moveDrag(e: PointerEvent) {
    if (!drag || !overlay) return;
    const r = overlay.getBoundingClientRect();
    const t = editor.viewToFrame((e.clientX - r.left - drag.dx) / width, (e.clientY - r.top - drag.dy) / height);
    if (t) up.patch = clampPatch(t);
  }

  function setSplit(e: PointerEvent) {
    const r = (e.currentTarget as Element).getBoundingClientRect();
    split = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  }

  function retry() {
    aiConsent.again();
    schedule(0);
  }
</script>

<div class="overlay" bind:this={overlay} style:width="{width}px" style:height="{height}px">
  {#if square}
    <div
      class="square"
      role="slider"
      tabindex="-1"
      aria-label="Detail to preview"
      aria-valuenow={Math.round(up.patch[0] * 100)}
      style:left="{square.left}px"
      style:top="{square.top}px"
      style:width="{square.width}px"
      style:height="{square.height}px"
      onpointerdown={startDrag}
      onpointermove={moveDrag}
      onpointerup={() => (drag = null)}
      onpointercancel={() => (drag = null)}
    ></div>
  {/if}

  <div
    class="loupe"
    class:left={loupeLeft}
    style:width="{loupeSize}px"
    style:height="{loupeSize}px"
    role="presentation"
    onpointerdown={(e) => {
      e.stopPropagation();
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      splitting = true;
      setSplit(e);
    }}
    onpointermove={(e) => splitting && setSplit(e)}
    onpointerup={() => (splitting = false)}
    onpointercancel={() => (splitting = false)}
  >
    <canvas bind:this={afterCanvas} hidden={!up.preview}></canvas>
    <canvas bind:this={beforeCanvas} hidden={!up.preview} style:clip-path="inset(0 {(1 - split) * 100}% 0 0)"></canvas>
    {#if up.preview}
      <i class="divider" style:left="{split * 100}%"></i>
      <span class="tag l">Before</span>
      <span class="tag r">AI {up.preview.scale}×</span>
    {/if}
    {#if up.previewError}
      <div class="msg err">
        {up.previewError}
        <button onclick={retry} onpointerdown={(e) => e.stopPropagation()}>Retry</button>
      </div>
    {:else if up.previewStatus}
      <div class="msg">{up.previewStatus}</div>
    {/if}
  </div>
</div>

<style>
  .overlay {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }
  .square {
    position: absolute;
    box-sizing: border-box;
    border: 2px solid #fff;
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.7);
    cursor: move;
    pointer-events: auto;
    touch-action: none;
  }
  .loupe {
    position: absolute;
    right: 10px;
    bottom: 10px;
    background: #111;
    border: 1px solid var(--line, #444);
    box-shadow: 0 4px 18px rgba(0, 0, 0, 0.6);
    overflow: hidden;
    pointer-events: auto;
    touch-action: none;
    cursor: ew-resize;
  }
  .loupe.left {
    right: auto;
    left: 10px;
  }
  canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }
  .divider {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 2px;
    margin-left: -1px;
    background: #fff;
    box-shadow: 0 0 2px rgba(0, 0, 0, 0.8);
  }
  .tag {
    position: absolute;
    top: 4px;
    padding: 1px 5px;
    font-size: 10px;
    background: rgba(0, 0, 0, 0.6);
    color: #fff;
    border-radius: 3px;
  }
  .tag.l {
    left: 4px;
  }
  .tag.r {
    right: 4px;
  }
  .msg {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    padding: 6px 8px;
    font-size: 11px;
    background: rgba(0, 0, 0, 0.7);
    color: var(--text, #ccc);
    cursor: default;
  }
  .msg.err {
    color: #e0a040;
  }
  .msg button {
    margin-left: 6px;
    padding: 1px 6px;
    font-size: 11px;
  }
</style>
