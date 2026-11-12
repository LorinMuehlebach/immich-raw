<script lang="ts">
  // Crop box over the crop-mode view (whole image, rotated by the straighten angle).
  // Drag inside to move, handles to resize, outside the box to rotate.
  import { viewRectInside, type ViewRect } from '@immich-raw/pipeline';
  import { PARAMS } from '@immich-raw/recipe';
  import { editor } from '../state/editor.svelte.ts';

  let { width, height }: { width: number; height: number } = $props();

  type Kind = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw' | 'rotate';
  interface Drag {
    kind: Kind;
    x: number;
    y: number;
    view: ViewRect;
    angle: number;
    startAngleRad: number;
  }

  const view = $derived.by(() => {
    // read the crop fields so this updates with the recipe
    const c = editor.recipe.crop;
    void (c.cx + c.cy + c.w + c.h + c.angle + c.rotate90);
    return editor.cropView();
  });
  const box = $derived({
    left: (view.cx - view.w / 2) * width,
    top: (view.cy - view.h / 2) * height,
    width: view.w * width,
    height: view.h * height,
  });

  let drag: Drag | null = $state(null);
  const HANDLES: Kind[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

  function inside(v: ViewRect): boolean {
    const { w, h } = editor.uprightProxySize();
    return viewRectInside(v, editor.recipe.crop.angle, w, h, 1e-6, editor.cropLimit());
  }

  /** Moves from `from` towards `to` as far as the rectangle stays inside the image. */
  function clampTowards(from: ViewRect, to: ViewRect): ViewRect {
    if (inside(to)) return to;
    let lo = 0;
    let hi = 1;
    const lerp = (t: number): ViewRect => ({
      cx: from.cx + (to.cx - from.cx) * t,
      cy: from.cy + (to.cy - from.cy) * t,
      w: from.w + (to.w - from.w) * t,
      h: from.h + (to.h - from.h) * t,
    });
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inside(lerp(mid))) lo = mid;
      else hi = mid;
    }
    return lerp(lo);
  }

  function start(kind: Kind, e: PointerEvent) {
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const rect = (e.currentTarget as Element).closest('.overlay')!.getBoundingClientRect();
    const cx = rect.left + view.cx * width;
    const cy = rect.top + view.cy * height;
    drag = { kind, x: e.clientX, y: e.clientY, view: { ...view }, angle: editor.recipe.crop.angle, startAngleRad: Math.atan2(e.clientY - cy, e.clientX - cx) };
  }

  function resize(d: Drag, dx: number, dy: number): ViewRect {
    const v = d.view;
    let l = v.cx - v.w / 2;
    let r = v.cx + v.w / 2;
    let t = v.cy - v.h / 2;
    let b = v.cy + v.h / 2;
    const k = d.kind;
    if (k.includes('w')) l += dx;
    if (k.includes('e')) r += dx;
    if (k.includes('n')) t += dy;
    if (k.includes('s')) b += dy;
    const minSize = 0.03;
    if (r - l < minSize) k.includes('w') ? (l = r - minSize) : (r = l + minSize);
    if (b - t < minSize) k.includes('n') ? (t = b - minSize) : (b = t + minSize);
    const aspect = editor.cropAspect();
    if (aspect) {
      const { w: Wu, h: Hu } = editor.uprightProxySize();
      const viewAspect = aspect * (Hu / Wu); // width/height in view units
      if (k === 'n' || k === 's') {
        const w = (b - t) * viewAspect;
        const c = (l + r) / 2;
        l = c - w / 2;
        r = c + w / 2;
      } else if (k === 'e' || k === 'w') {
        const h = (r - l) / viewAspect;
        const c = (t + b) / 2;
        t = c - h / 2;
        b = c + h / 2;
      } else {
        const h = (r - l) / viewAspect;
        if (k.includes('n')) t = b - h;
        else b = t + h;
      }
    }
    return { cx: (l + r) / 2, cy: (t + b) / 2, w: r - l, h: b - t };
  }

  function move(e: PointerEvent) {
    const d = drag;
    if (!d) return;
    const dx = (e.clientX - d.x) / width;
    const dy = (e.clientY - d.y) / height;
    if (d.kind === 'rotate') {
      const rect = (e.currentTarget as Element).closest('.overlay')!.getBoundingClientRect();
      const cx = rect.left + d.view.cx * width;
      const cy = rect.top + d.view.cy * height;
      const a = Math.atan2(e.clientY - cy, e.clientX - cx);
      const deg = d.angle + ((a - d.startAngleRad) * 180) / Math.PI;
      editor.setParam(PARAMS.angle, Math.round(deg * 20) / 20);
      return;
    }
    if (d.kind === 'move') {
      editor.setCropView(clampTowards(d.view, { ...d.view, cx: d.view.cx + dx, cy: d.view.cy + dy }));
      return;
    }
    editor.setCropView(clampTowards(d.view, resize(d, dx, dy)), { manual: true });
  }

  function end() {
    if (!drag) return;
    drag = null;
    editor.commit();
  }
</script>

<div
  class="overlay"
  style:width="{width}px"
  style:height="{height}px"
  role="presentation"
  onpointerdown={(e) => start('rotate', e)}
  onpointermove={move}
  onpointerup={end}
  onpointercancel={end}
>
  <svg {width} {height} class="shade">
    <path
      fill-rule="evenodd"
      d="M0 0H{width}V{height}H0Z M{box.left} {box.top}h{box.width}v{box.height}h{-box.width}Z"
      fill="rgba(0,0,0,0.62)"
    />
  </svg>
  <div
    class="box"
    role="presentation"
    style:left="{box.left}px"
    style:top="{box.top}px"
    style:width="{box.width}px"
    style:height="{box.height}px"
    onpointerdown={(e) => start('move', e)}
    onpointermove={move}
    onpointerup={end}
  >
    <div class="grid" class:visible={!!drag}>
      <i style:left="33.333%" class="v"></i><i style:left="66.666%" class="v"></i>
      <i style:top="33.333%" class="h"></i><i style:top="66.666%" class="h"></i>
    </div>
    {#each HANDLES as h (h)}
      <span
        class="handle {h}"
        role="presentation"
        onpointerdown={(e) => start(h, e)}
        onpointermove={move}
        onpointerup={end}
      ></span>
    {/each}
  </div>
</div>

<style>
  .overlay {
    position: absolute;
    inset: 0;
    cursor: grab;
    touch-action: none;
  }
  .shade {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }
  .box {
    position: absolute;
    outline: 1px solid rgba(255, 255, 255, 0.85);
    cursor: move;
  }
  .grid i {
    position: absolute;
    background: rgba(255, 255, 255, 0.28);
  }
  .grid .v {
    top: 0;
    bottom: 0;
    width: 1px;
  }
  .grid .h {
    left: 0;
    right: 0;
    height: 1px;
  }
  .grid {
    opacity: 0.45;
  }
  .grid.visible {
    opacity: 1;
  }
  .handle {
    position: absolute;
    width: 14px;
    height: 14px;
    margin: -7px 0 0 -7px;
  }
  .handle::after {
    content: '';
    position: absolute;
    inset: 4px;
    background: #fff;
    box-shadow: 0 0 2px rgba(0, 0, 0, 0.8);
  }
  /* Touch: a finger-sized grab area around the same small square. */
  @media (pointer: coarse) {
    .handle {
      width: 36px;
      height: 36px;
      margin: -18px 0 0 -18px;
    }
    .handle::after {
      inset: 13px;
    }
  }
  .nw { left: 0; top: 0; cursor: nwse-resize; }
  .n { left: 50%; top: 0; cursor: ns-resize; }
  .ne { left: 100%; top: 0; cursor: nesw-resize; }
  .e { left: 100%; top: 50%; cursor: ew-resize; }
  .se { left: 100%; top: 100%; cursor: nwse-resize; }
  .s { left: 50%; top: 100%; cursor: ns-resize; }
  .sw { left: 0; top: 100%; cursor: nesw-resize; }
  .w { left: 0; top: 50%; cursor: ew-resize; }
</style>
