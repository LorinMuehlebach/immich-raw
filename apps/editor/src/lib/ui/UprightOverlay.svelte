<script lang="ts">
  // Guided Upright (Shift+T): drag along an edge that should be vertical or horizontal to draw a
  // guide, up to four. The photo straightens when you let go, and the guides, pinned to the
  // photo, straighten with it. Drag a guide's ends to adjust it; click a guide to select it,
  // Delete removes it.
  import { MAX_UPRIGHT_GUIDES } from '@immich-raw/recipe';
  import { MediaQuery } from 'svelte/reactivity';
  import { editor } from '../state/editor.svelte.ts';

  let { width, height }: { width: number; height: number } = $props();
  let svg: SVGSVGElement;

  type P = [number, number];
  const coarse = new MediaQuery('(pointer: coarse)');
  const hr = $derived(coarse.current ? 11 : 6);

  /** Mask frame -> CSS pixels on the canvas. */
  function toPx(p: P): P {
    const v = editor.maskToView(p);
    return v ? [v[0] * width, v[1] * height] : [NaN, NaN];
  }

  function pxToMask(p: P): P | null {
    return editor.viewToMask(p[0] / width, p[1] / height);
  }

  function eventPx(e: PointerEvent): P {
    const r = svg.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * width, ((e.clientY - r.top) / r.height) * height];
  }

  /** The guides on screen; they move with every render. */
  const guides = $derived.by((): [P, P][] => {
    void editor.viewVersion;
    void (width + height);
    return editor.uprightGuides.map(([x0, y0, x1, y1]) => [toPx([x0, y0]), toPx([x1, y1])]);
  });

  /** A drag in progress, in CSS pixels: a new guide (index null), or one end of guide `index`. */
  let drag = $state<{ index: number | null; end: 0 | 1; a: P; b: P } | null>(null);

  const shown = $derived.by((): { a: P; b: P; selected: boolean; drawing: boolean }[] => {
    const out = guides.map(([a, b], i) => {
      const d = drag && drag.index === i ? drag : null;
      return { a: d ? d.a : a, b: d ? d.b : b, selected: editor.uprightSel === i, drawing: false };
    });
    if (drag && drag.index === null) out.push({ a: drag.a, b: drag.b, selected: true, drawing: true });
    return out;
  });

  const isVertical = (a: P, b: P) => Math.abs(b[1] - a[1]) >= Math.abs(b[0] - a[0]);

  function begin(e: PointerEvent, d: NonNullable<typeof drag>) {
    e.stopPropagation();
    e.preventDefault();
    drag = d;
    addEventListener('pointermove', onMove);
    addEventListener('pointerup', onUp);
    addEventListener('pointercancel', onUp);
  }

  function onBackgroundDown(e: PointerEvent) {
    if (e.button > 0 || editor.readOnly) return;
    if (editor.uprightGuides.length >= MAX_UPRIGHT_GUIDES) {
      editor.notice = `Up to ${MAX_UPRIGHT_GUIDES} guides: drag the ends of one, or remove one (select it, Delete).`;
      return;
    }
    const p = eventPx(e);
    editor.uprightSel = null;
    begin(e, { index: null, end: 1, a: p, b: p });
  }

  function onEndDown(e: PointerEvent, index: number, end: 0 | 1) {
    if (e.button > 0 || editor.readOnly) return;
    editor.uprightSel = index;
    const [a, b] = guides[index]!;
    begin(e, { index, end, a, b });
  }

  function onMove(e: PointerEvent) {
    const d = drag;
    if (!d) return;
    const p = eventPx(e);
    drag = d.end === 0 ? { ...d, a: p } : { ...d, b: p };
  }

  function onUp(e: PointerEvent) {
    removeEventListener('pointermove', onMove);
    removeEventListener('pointerup', onUp);
    removeEventListener('pointercancel', onUp);
    const d = drag;
    drag = null;
    if (!d || e.type === 'pointercancel') return;
    // Shorter than this is a click, not a guide.
    if (Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1]) < 12) return;
    // Mapped through the view as it is now, before the correction changes it.
    const a = pxToMask(d.a);
    const b = pxToMask(d.b);
    if (!a || !b) return;
    if (d.index === null) editor.addUprightGuide([a[0], a[1], b[0], b[1]]);
    else editor.moveUprightGuide(d.index, [a[0], a[1], b[0], b[1]]);
  }
</script>

<svg bind:this={svg} {width} {height} class="upright" role="presentation" onpointerdown={onBackgroundDown}>
  {#each shown as g, i (i)}
    {#if Number.isFinite(g.a[0]) && Number.isFinite(g.b[0])}
      <g class="guide" class:selected={g.selected} class:drawing={g.drawing} class:vertical={isVertical(g.a, g.b)}>
        <line x1={g.a[0]} y1={g.a[1]} x2={g.b[0]} y2={g.b[1]} class="under" />
        <line x1={g.a[0]} y1={g.a[1]} x2={g.b[0]} y2={g.b[1]} class="main" />
        {#if !g.drawing}
          <line
            x1={g.a[0]}
            y1={g.a[1]}
            x2={g.b[0]}
            y2={g.b[1]}
            class="hit"
            role="presentation"
            onpointerdown={(e) => {
              e.stopPropagation();
              editor.uprightSel = i;
            }}
          />
          <circle cx={g.a[0]} cy={g.a[1]} r={hr} class="end" role="presentation" onpointerdown={(e) => onEndDown(e, i, 0)} />
          <circle cx={g.b[0]} cy={g.b[1]} r={hr} class="end" role="presentation" onpointerdown={(e) => onEndDown(e, i, 1)} />
        {/if}
      </g>
    {/if}
  {/each}
</svg>

<style>
  .upright {
    position: absolute;
    inset: 0;
    overflow: hidden;
    touch-action: none;
    cursor: crosshair;
  }
  .guide line {
    fill: none;
  }
  .guide .under {
    stroke: rgba(0, 0, 0, 0.6);
    stroke-width: 3.5;
    pointer-events: none;
  }
  .guide .main {
    stroke: #ffd84a;
    stroke-width: 1.6;
    pointer-events: none;
  }
  .guide.selected .main {
    stroke: #fff;
    stroke-width: 2;
  }
  .guide.drawing .main {
    stroke-dasharray: 6 4;
  }
  .guide .hit {
    stroke: transparent;
    stroke-width: 12;
    pointer-events: stroke;
    cursor: pointer;
  }
  .end {
    fill: #ffd84a;
    stroke: #222;
    stroke-width: 1.2;
    cursor: move;
  }
  .guide.selected .end {
    fill: #fff;
  }
</style>
