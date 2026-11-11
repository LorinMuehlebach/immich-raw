<script lang="ts">
  // Curve graph in Lightroom's 0..255 units. Point mode: click the curve to add a point,
  // drag to move, double-click (or drag out of the graph) to remove. Read-only otherwise.
  import type { CurvePoint } from '@immich-raw/recipe';

  interface Props {
    /** Curve to draw, x -> y in 0..1. */
    curve: (x: number) => number;
    /** Editable points (point mode), or null for a read-only graph. */
    points: CurvePoint[] | null;
    color?: string;
    /** Luminance histogram (256 bins) drawn behind the curve. */
    histogram?: ArrayLike<number> | null;
    /** Region boundaries (0..1) shaded in parametric mode. */
    splits?: number[];
    disabled?: boolean;
    onchange?: (points: CurvePoint[]) => void;
    oncommit?: () => void;
  }

  let { curve, points, color = '#e6e6e6', histogram = null, splits = [], disabled = false, onchange, oncommit }: Props = $props();

  const S = 256;
  let svg: SVGSVGElement | undefined = $state();
  let dragIndex: number | null = $state(null);

  const path = $derived.by(() => {
    let d = '';
    for (let i = 0; i <= 128; i++) {
      const x = i / 128;
      d += `${i ? 'L' : 'M'}${(x * S).toFixed(2)} ${((1 - curve(x)) * S).toFixed(2)}`;
    }
    return d;
  });

  const histPath = $derived.by(() => {
    if (!histogram) return '';
    let peak = 1;
    for (let i = 2; i < 254; i++) peak = Math.max(peak, histogram[i]!);
    let d = `M0 ${S}`;
    for (let i = 0; i < 256; i++) d += `L${i} ${S - Math.min(1, histogram[i]! / peak) * S * 0.9}`;
    return `${d}L${S} ${S}Z`;
  });

  function toCurve(e: PointerEvent): [number, number] {
    const r = svg!.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * 255, (1 - (e.clientY - r.top) / r.height) * 255];
  }

  function update(i: number, x: number, y: number) {
    if (!points || !onchange) return;
    const next = points.map((p) => [...p] as CurvePoint);
    const last = next.length - 1;
    // Ends keep their input value; inner points stay between their neighbours.
    const lo = i === 0 ? 0 : next[i - 1]![0] + 1;
    const hi = i === last ? 255 : next[i + 1]![0] - 1;
    next[i] = [i === 0 ? 0 : i === last ? 255 : Math.min(hi, Math.max(lo, x)), Math.min(255, Math.max(0, y))];
    onchange(next);
  }

  function onDown(e: PointerEvent) {
    if (disabled || !points || !onchange) return;
    e.preventDefault();
    svg!.setPointerCapture(e.pointerId);
    const [x, y] = toCurve(e);
    // Grab a nearby point, else add one on the curve at this x.
    const near = points.findIndex((p) => Math.hypot(p[0] - x, p[1] - y) < 10);
    if (near >= 0) {
      dragIndex = near;
      return;
    }
    if (x <= 1 || x >= 254) return;
    const next = [...points.map((p) => [...p] as CurvePoint), [x, curve(x / 255) * 255] as CurvePoint].sort((a, b) => a[0] - b[0]);
    dragIndex = next.findIndex((p) => p[0] === x);
    onchange(next);
  }

  function onMove(e: PointerEvent) {
    if (dragIndex === null || !points) return;
    const [x, y] = toCurve(e);
    const inner = dragIndex > 0 && dragIndex < points.length - 1;
    // Dragging an inner point well outside the graph removes it.
    if (inner && (y < -25 || y > 280)) {
      onchange?.(points.filter((_, i) => i !== dragIndex));
      dragIndex = null;
      return;
    }
    update(dragIndex, x, y);
  }

  function onUp() {
    if (dragIndex === null) return;
    dragIndex = null;
    oncommit?.();
  }

  function remove(i: number) {
    if (!points || i === 0 || i === points.length - 1) return;
    onchange?.(points.filter((_, k) => k !== i));
    oncommit?.();
  }
</script>

<svg
  bind:this={svg}
  viewBox="0 0 {S} {S}"
  class:editable={!!points && !disabled}
  role="presentation"
  onpointerdown={onDown}
  onpointermove={onMove}
  onpointerup={onUp}
  onpointercancel={onUp}
>
  <rect width={S} height={S} fill="#1b1b1b" />
  {#if histPath}<path d={histPath} fill="rgba(255,255,255,0.08)" />{/if}
  {#each splits as s (s)}
    <line x1={s * S} x2={s * S} y1="0" y2={S} stroke="rgba(255,255,255,0.12)" stroke-dasharray="3 3" />
  {/each}
  {#each [0.25, 0.5, 0.75] as g (g)}
    <line x1={g * S} x2={g * S} y1="0" y2={S} stroke="rgba(255,255,255,0.06)" />
    <line y1={g * S} y2={g * S} x1="0" x2={S} stroke="rgba(255,255,255,0.06)" />
  {/each}
  <line x1="0" y1={S} x2={S} y2="0" stroke="rgba(255,255,255,0.15)" />
  <path d={path} fill="none" stroke={color} stroke-width="1.6" vector-effect="non-scaling-stroke" />
  {#if points}
    {#each points as p, i (i)}
      <circle
        cx={(p[0] / 255) * S}
        cy={(1 - p[1] / 255) * S}
        r="4.5"
        fill={dragIndex === i ? color : '#1b1b1b'}
        stroke={color}
        stroke-width="1.4"
        vector-effect="non-scaling-stroke"
        role="presentation"
        ondblclick={() => remove(i)}
      />
    {/each}
  {/if}
</svg>

<style>
  svg {
    width: 100%;
    aspect-ratio: 1;
    display: block;
    border: 1px solid #111;
    touch-action: none;
  }
  svg.editable {
    cursor: crosshair;
  }
</style>
