<script lang="ts">
  // On-image handles for masks (Lightroom's pins). Linear gradient: three lines (full effect,
  // middle, none), drag the end handles, the pin to move, the round handle to rotate.
  // Radial gradient: drag the pin to move, the four edge handles to resize (Shift keeps the
  // shape), the round handle to rotate. With a gradient armed, drag on the photo to draw it.
  // Brush: paint on the photo (Alt erases); the circle shows the brush size and feather.
  // Colour range: click to pick a colour (Shift+click adds one, drag to average an area).
  // Polygon: click the corners, then click the first one, double-click or press Enter to close;
  // afterwards drag a corner to move it, drag an edge to add one, Alt+click a corner to remove
  // it. Lasso: drag around the area.
  import { brushRadius } from '@immich-raw/pipeline';
  import type { MaskComponent } from '@immich-raw/recipe';
  import { MediaQuery } from 'svelte/reactivity';
  import { editor } from '../state/editor.svelte.ts';

  let { width, height }: { width: number; height: number } = $props();
  let svg: SVGSVGElement;

  type P = [number, number];
  // Touch screens get finger-sized handles: half the square's side, the round handle's radius,
  // and how much the pins grow.
  const coarse = new MediaQuery('(pointer: coarse)');
  const hs = $derived(coarse.current ? 9 : 5);
  const hr = $derived(coarse.current ? 10 : 6);
  const pinGrow = $derived(coarse.current ? 4 : 0);
  type Kind = 'move' | 'rx' | 'ry' | 'rotate' | 'p0' | 'p1' | 'draw' | 'sample' | 'vertex';

  const sub = (a: P, b: P): P => [a[0] - b[0], a[1] - b[1]];
  const add = (a: P, b: P): P => [a[0] + b[0], a[1] + b[1]];
  const mul = (a: P, k: number): P => [a[0] * k, a[1] * k];
  const len = (a: P) => Math.hypot(a[0], a[1]);
  const deg = (a: P) => (Math.atan2(a[1], a[0]) * 180) / Math.PI;

  /** Mask frame -> CSS pixels on the canvas. */
  function toPx(p: P): P {
    const v = editor.maskToView(p);
    return v ? [v[0] * width, v[1] * height] : [NaN, NaN];
  }

  /** CSS pixels on the canvas -> mask frame. */
  function pxToMask(p: P): P | null {
    return editor.viewToMask(p[0] / width, p[1] / height);
  }

  function eventPx(e: PointerEvent): P {
    const r = svg.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * width, ((e.clientY - r.top) / r.height) * height];
  }

  interface Radial {
    type: 'radial';
    c: P;
    rx: number;
    ry: number;
    rot: number;
    inner: number;
    hx: P;
    hx2: P;
    hy: P;
    hy2: P;
    hr: P;
  }
  interface Linear {
    type: 'linear';
    p0: P;
    p1: P;
    mid: P;
    perp: P;
    hr: P;
  }
  interface Samples {
    type: 'samples';
    /** Each sample: centre and radius in CSS pixels. */
    points: { c: P; r: number }[];
  }
  /** An AI part's prompt: the box drawn around an object, or the points clicked on it. */
  interface AiPrompt {
    type: 'ai';
    /** Box corners in order (the box may be turned on screen). */
    box: P[] | null;
    points: P[];
  }
  /** A polygon or lasso: its corners in CSS pixels. */
  interface Poly {
    type: 'polygon';
    pts: P[];
    freehand: boolean;
  }
  interface Shape {
    maskId: string;
    comp: MaskComponent;
    maskSelected: boolean;
    selected: boolean;
    pin: P;
    geo: Radial | Linear | Samples | AiPrompt | Poly | null;
    /** AI parts: the pin only selects (moving it would mean finding the object again). */
    fixed?: boolean;
  }

  const shapes = $derived.by((): Shape[] => {
    void editor.viewVersion;
    void (width + height);
    const out: Shape[] = [];
    for (const m of editor.recipe.masks) {
      for (const c of m.components) {
        const maskSelected = m.id === editor.maskSel.mask;
        const selected = maskSelected && c.id === editor.maskSel.comp;
        if (c.kind === 'radial') {
          const a = (c.angle * Math.PI) / 180;
          const u: P = [Math.cos(a), Math.sin(a)];
          const v: P = [-Math.sin(a), Math.cos(a)];
          const cm: P = [c.cx, c.cy];
          const C = toPx(cm);
          const hx = toPx(add(cm, mul(u, c.rx)));
          const hy = toPx(add(cm, mul(v, c.ry)));
          if (!Number.isFinite(C[0]) || !Number.isFinite(hx[0])) continue;
          const ryPx = len(sub(hy, C));
          out.push({
            maskId: m.id,
            comp: c,
            maskSelected,
            selected,
            pin: C,
            geo: {
              type: 'radial',
              c: C,
              rx: len(sub(hx, C)),
              ry: ryPx,
              rot: deg(sub(hx, C)),
              inner: Math.max(0, 1 - c.feather / 100),
              hx,
              hx2: sub(mul(C, 2), hx),
              hy,
              hy2: sub(mul(C, 2), hy),
              hr: add(C, mul(sub(hy, C), (ryPx + 26) / Math.max(ryPx, 1e-6))),
            },
          });
        } else if (c.kind === 'linear') {
          const p0 = toPx([c.x0, c.y0]);
          const p1 = toPx([c.x1, c.y1]);
          if (!Number.isFinite(p0[0]) || !Number.isFinite(p1[0])) continue;
          const d = sub(p1, p0);
          const l = Math.max(len(d), 1e-6);
          const perp: P = [-d[1] / l, d[0] / l];
          const mid = mul(add(p0, p1), 0.5);
          out.push({ maskId: m.id, comp: c, maskSelected, selected, pin: mid, geo: { type: 'linear', p0, p1, mid, perp, hr: add(mid, mul(perp, 70)) } });
        } else if (c.kind === 'brush') {
          const first = c.strokes.find((st) => !st.erase && st.points.length >= 2);
          if (!first) continue;
          const pin = toPx([first.points[0]!, first.points[1]!]);
          if (Number.isFinite(pin[0])) out.push({ maskId: m.id, comp: c, maskSelected, selected, pin, geo: null });
        } else if (c.kind === 'polygon') {
          const pts: P[] = [];
          for (let i = 0; i + 1 < c.points.length; i += 2) pts.push(toPx([c.points[i]!, c.points[i + 1]!]));
          if (!pts.length || !pts.every((q) => Number.isFinite(q[0]))) continue;
          // The pin sits in the middle of the shape's bounding box.
          const xs = pts.map((q) => q[0]);
          const ys = pts.map((q) => q[1]);
          const pin: P = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
          out.push({ maskId: m.id, comp: c, maskSelected, selected, pin, geo: { type: 'polygon', pts, freehand: !!c.freehand } });
        } else if (c.kind === 'color') {
          const points = c.samples
            .map((sm) => {
              const cp = toPx([sm.x, sm.y]);
              const e = toPx([sm.x + sm.r, sm.y]);
              return { c: cp, r: len(sub(e, cp)) };
            })
            .filter((q) => Number.isFinite(q.c[0]));
          if (points.length) out.push({ maskId: m.id, comp: c, maskSelected, selected, pin: points[0]!.c, geo: { type: 'samples', points } });
        } else if (c.kind === 'ai' && c.target === 'object') {
          const box = c.box ? ([[c.box[0], c.box[1]], [c.box[2], c.box[1]], [c.box[2], c.box[3]], [c.box[0], c.box[3]]] as P[]).map(toPx) : null;
          const points: P[] = [];
          for (let i = 0; c.points && i + 1 < c.points.length; i += 2) points.push(toPx([c.points[i]!, c.points[i + 1]!]));
          const pin = box ? mul(add(box[0]!, box[2]!), 0.5) : points[0];
          if (pin && Number.isFinite(pin[0])) out.push({ maskId: m.id, comp: c, maskSelected, selected, pin, geo: { type: 'ai', box, points }, fixed: true });
        } else if (c.kind === 'ai' && c.target === 'people' && c.person) {
          const pin = toPx([c.person.x, c.person.y]);
          if (Number.isFinite(pin[0])) out.push({ maskId: m.id, comp: c, maskSelected, selected, pin, geo: null, fixed: true });
        }
      }
    }
    return out;
  });

  const line = (p: P, dir: P, half = 4000) => ({ x1: p[0] - dir[0] * half, y1: p[1] - dir[1] * half, x2: p[0] + dir[0] * half, y2: p[1] + dir[1] * half });

  // ---------------------------------------------------------------- dragging

  let drag: {
    kind: Kind;
    maskId: string;
    compId: string;
    orig: MaskComponent;
    startPx: P;
    startMask: P;
    moved: number;
    /** Colour sample being placed. */
    index?: number;
  } | null = null;

  function begin(kind: Kind, s: Shape | { maskId: string; compId: string }, e: PointerEvent, index?: number) {
    e.stopPropagation();
    e.preventDefault();
    const maskId = s.maskId;
    const compId = 'comp' in s ? s.comp.id : s.compId;
    if (kind !== 'draw') editor.selectMask(maskId, compId);
    const comp = editor.mask(maskId)?.components.find((c) => c.id === compId);
    const startPx = eventPx(e);
    const startMask = pxToMask(startPx);
    if (!comp || !startMask) return;
    drag = { kind, maskId, compId, orig: $state.snapshot(comp) as MaskComponent, startPx, startMask, moved: 0, index };
    addEventListener('pointermove', onMove);
    addEventListener('pointerup', onUp);
    addEventListener('pointercancel', onUp);
  }

  function onMove(e: PointerEvent) {
    const d = drag;
    if (!d) return;
    const px = eventPx(e);
    d.moved = Math.max(d.moved, len(sub(px, d.startPx)));
    const p = pxToMask(px);
    if (!p) return;
    const o = d.orig;
    const delta = sub(p, d.startMask);
    let patch: Partial<MaskComponent> = {};
    if (o.kind === 'radial') {
      const c: P = [o.cx, o.cy];
      const a = (o.angle * Math.PI) / 180;
      const u: P = [Math.cos(a), Math.sin(a)];
      const v: P = [-Math.sin(a), Math.cos(a)];
      const q = sub(p, c);
      if (d.kind === 'move') patch = { cx: o.cx + delta[0], cy: o.cy + delta[1] };
      else if (d.kind === 'rx' || d.kind === 'ry') {
        const r = Math.max(1e-3, Math.abs(q[0] * (d.kind === 'rx' ? u : v)[0] + q[1] * (d.kind === 'rx' ? u : v)[1]));
        if (e.shiftKey) {
          const k = r / (d.kind === 'rx' ? o.rx : o.ry);
          patch = { rx: o.rx * k, ry: o.ry * k };
        } else patch = d.kind === 'rx' ? { rx: r } : { ry: r };
      } else if (d.kind === 'rotate') patch = { angle: deg(q) - 90 };
      else if (d.kind === 'draw') {
        // Drawn from the centre, axes along the screen: measure in screen pixels.
        const cPx = d.startPx;
        const right = pxToMask(add(cPx, [1, 0]));
        if (!right) return;
        const unit = sub(right, c);
        const scale = len(unit);
        let dx = Math.abs(px[0] - cPx[0]) * scale;
        let dy = Math.abs(px[1] - cPx[1]) * scale;
        if (e.shiftKey) dx = dy = Math.max(dx, dy);
        patch = { rx: Math.max(1e-3, dx), ry: Math.max(1e-3, dy), angle: deg(unit) };
      }
    } else if (o.kind === 'polygon') {
      if (d.kind === 'move') patch = { points: o.points.map((v, i) => v + delta[i % 2]!) };
      else if (d.kind === 'vertex' && d.index !== undefined) {
        const k = d.index * 2;
        patch = { points: o.points.map((v, i) => (i === k ? p[0] : i === k + 1 ? p[1] : v)) };
      }
    } else if (o.kind === 'color') {
      // Dragging out a sample averages the colours inside the circle.
      const i = d.kind === 'draw' ? 0 : (d.index ?? -1);
      if (d.kind === 'move') patch = { samples: o.samples.map((sm) => ({ ...sm, x: sm.x + delta[0], y: sm.y + delta[1] })) };
      else if (i >= 0) patch = { samples: o.samples.map((sm, k) => (k === i ? { ...sm, r: Math.min(0.25, len(sub(p, [sm.x, sm.y]))) } : sm)) };
    } else if (o.kind === 'linear') {
      const p0: P = [o.x0, o.y0];
      const p1: P = [o.x1, o.y1];
      if (d.kind === 'move') patch = { x0: o.x0 + delta[0], y0: o.y0 + delta[1], x1: o.x1 + delta[0], y1: o.y1 + delta[1] };
      else if (d.kind === 'p0') patch = { x0: p[0], y0: p[1] };
      else if (d.kind === 'p1' || d.kind === 'draw') patch = { x1: p[0], y1: p[1] };
      else if (d.kind === 'rotate') {
        const m = mul(add(p0, p1), 0.5);
        const da = Math.atan2(p[1] - m[1], p[0] - m[0]) - Math.atan2(d.startMask[1] - m[1], d.startMask[0] - m[0]);
        const rot = (x: P): P => {
          const r = sub(x, m);
          return add(m, [r[0] * Math.cos(da) - r[1] * Math.sin(da), r[0] * Math.sin(da) + r[1] * Math.cos(da)]);
        };
        const [a, b] = [rot(p0), rot(p1)];
        patch = { x0: a[0], y0: a[1], x1: b[0], y1: b[1] };
      }
      // Keep a direction even when both ends meet.
      const n = { x0: o.x0, y0: o.y0, x1: o.x1, y1: o.y1, ...patch } as { x0: number; y0: number; x1: number; y1: number };
      if (Math.hypot(n.x1 - n.x0, n.y1 - n.y0) < 1e-3) return;
    }
    editor.updateComponent(d.maskId, d.compId, patch);
  }

  function onUp() {
    const d = drag;
    drag = null;
    removeEventListener('pointermove', onMove);
    removeEventListener('pointerup', onUp);
    removeEventListener('pointercancel', onUp);
    if (!d) return;
    if (d.kind === 'draw') editor.finishMaskDraw(d.maskId, d.compId, d.moved);
    else editor.commit();
  }

  // ---------------------------------------------------------------- brush and colour picking

  const sampling = $derived(editor.tool === 'mask' && !editor.readOnly && (editor.maskDraft?.kind === 'color' || (!editor.maskDraft && editor.selectedComponent?.kind === 'color')));
  /** A clicked object is selected: Shift+click adds points to it. */
  const objectPoints = $derived.by(() => {
    const c = editor.selectedComponent;
    return editor.tool === 'mask' && !editor.readOnly && !editor.maskDraft && c?.kind === 'ai' && c.target === 'object' && !c.box;
  });
  /** Objects: the box being dragged, in CSS pixels. */
  let objectDrag = $state<{ start: P; end: P } | null>(null);

  function onObjectMove(e: PointerEvent) {
    if (objectDrag) objectDrag = { ...objectDrag, end: eventPx(e) };
  }

  function onObjectUp(e: PointerEvent) {
    removeEventListener('pointermove', onObjectMove);
    removeEventListener('pointerup', onObjectUp);
    removeEventListener('pointercancel', onObjectUp);
    const d = objectDrag;
    objectDrag = null;
    if (!d || e.type === 'pointercancel') return;
    const end = eventPx(e);
    if (len(sub(end, d.start)) < 6) {
      // A click: the object under it.
      const p = pxToMask(d.start);
      if (p) editor.drawObject(null, p);
      return;
    }
    const a = pxToMask(d.start);
    const b = pxToMask(end);
    if (a && b) editor.drawObject([a[0], a[1], b[0], b[1]], null);
  }
  let cursor = $state<P | null>(null);
  let altHeld = $state(false);

  /** Brush outline at the pointer: outer radius and where the feather starts, in CSS pixels. */
  const brushRing = $derived.by(() => {
    void editor.viewVersion;
    if (!editor.painting || !cursor) return null;
    const m = pxToMask(cursor);
    if (!m) return null;
    const r = brushRadius(editor.brush.size);
    const e = toPx([m[0] + r, m[1]]);
    const R = len(sub(e, cursor));
    return { c: cursor, r: R, inner: R * Math.max(0, 1 - editor.brush.feather / 100) };
  });

  function onPaintMove(e: PointerEvent) {
    const p = pxToMask(eventPx(e));
    if (p) editor.extendStroke(p);
  }

  function onPaintUp() {
    removeEventListener('pointermove', onPaintMove);
    removeEventListener('pointerup', onPaintUp);
    removeEventListener('pointercancel', onPaintUp);
    editor.endStroke();
  }

  function onBackgroundDown(e: PointerEvent) {
    if (e.button > 0) return;
    const p = pxToMask(eventPx(e));
    if (!p) return;
    if (editor.painting) {
      e.preventDefault();
      if (!editor.beginStroke(p, e.altKey || editor.brush.erase)) return;
      addEventListener('pointermove', onPaintMove);
      addEventListener('pointerup', onPaintUp);
      addEventListener('pointercancel', onPaintUp);
      return;
    }
    if (editor.maskDraft?.kind === 'polygon') {
      // Not a tap on the view: a double-click closes the polygon, it doesn't zoom to 100 %.
      e.stopPropagation();
      e.preventDefault();
      // preventDefault keeps the focus where it was, often the panel's Add… menu; leave it so
      // that Enter and Backspace reach the polygon.
      if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) document.activeElement.blur();
      polygonClick(e, p);
      return;
    }
    if (editor.maskDraft?.kind === 'lasso') {
      e.stopPropagation();
      e.preventDefault();
      lasso = { px: [eventPx(e)], mask: [p[0], p[1]] };
      addEventListener('pointermove', onLassoMove);
      addEventListener('pointerup', onLassoUp);
      addEventListener('pointercancel', onLassoUp);
      return;
    }
    if (editor.maskDraft?.kind === 'object') {
      e.preventDefault();
      const start = eventPx(e);
      objectDrag = { start, end: start };
      addEventListener('pointermove', onObjectMove);
      addEventListener('pointerup', onObjectUp);
      addEventListener('pointercancel', onObjectUp);
      return;
    }
    if (objectPoints) {
      if (e.shiftKey) editor.addObjectPoint(p);
      return;
    }
    if (!editor.maskDraft && editor.selectedComponent?.kind === 'color' && editor.maskSel.mask && editor.maskSel.comp) {
      const index = editor.sampleColor(p, e.shiftKey);
      if (index !== null) begin('sample', { maskId: editor.maskSel.mask, compId: editor.maskSel.comp }, e, index);
      return;
    }
    if (!editor.maskDraft) return;
    const compId = editor.beginMaskDraw(p);
    const maskId = editor.maskSel.mask;
    if (compId && maskId) begin('draw', { maskId, compId }, e);
  }

  // ---------------------------------------------------------------- polygon and lasso

  /** Within this many CSS pixels of the first corner, a click closes the polygon. */
  const snap = $derived(coarse.current ? 16 : 9);
  /** The polygon being drawn: its corners in CSS pixels. */
  const draftPts = $derived.by((): P[] => {
    void editor.viewVersion;
    void (width + height);
    const pts = editor.maskDraft?.kind === 'polygon' ? (editor.maskDraft.points ?? []) : [];
    const out: P[] = [];
    for (let i = 0; i + 1 < pts.length; i += 2) out.push(toPx([pts[i]!, pts[i + 1]!]));
    return out;
  });
  const nearFirst = $derived(!!cursor && draftPts.length >= 3 && len(sub(cursor, draftPts[0]!)) <= snap);
  let lastClick: { t: number; px: P } | null = null;

  function polygonClick(e: PointerEvent, p: P) {
    const px = eventPx(e);
    const now = performance.now();
    const double = !!lastClick && now - lastClick.t < 350 && len(sub(px, lastClick.px)) < 6;
    lastClick = { t: now, px };
    // Click the first corner, or double-click, to close it.
    if ((draftPts.length >= 3 && len(sub(px, draftPts[0]!)) <= snap) || double) {
      lastClick = null;
      editor.closePolygon();
      return;
    }
    editor.addPolygonPoint(p);
  }

  /** The lasso being dragged, in CSS pixels (shown) and in the mask frame (kept). */
  let lasso = $state<{ px: P[]; mask: number[] } | null>(null);

  function onLassoMove(e: PointerEvent) {
    const l = lasso;
    if (!l) return;
    const px = [...l.px];
    const mask = [...l.mask];
    // The browser hands over fast moves once per frame; the coalesced events hold every point.
    for (const ev of e.getCoalescedEvents?.() ?? [e]) {
      const q = eventPx(ev);
      if (len(sub(q, px[px.length - 1]!)) < 2) continue;
      const p = pxToMask(q);
      if (!p) continue;
      px.push(q);
      mask.push(p[0], p[1]);
    }
    if (px.length > l.px.length) lasso = { px, mask };
  }

  function onLassoUp(e: PointerEvent) {
    removeEventListener('pointermove', onLassoMove);
    removeEventListener('pointerup', onLassoUp);
    removeEventListener('pointercancel', onLassoUp);
    const l = lasso;
    lasso = null;
    if (!l || e.type === 'pointercancel' || l.px.length < 3) return;
    editor.drawLasso(l.mask);
  }

  /** Corner i of a polygon: drag it, or Alt+click it to remove it. */
  function onCorner(s: Shape, i: number, e: PointerEvent) {
    if (s.comp.kind !== 'polygon') return;
    if (e.altKey) {
      e.stopPropagation();
      e.preventDefault();
      if (s.comp.points.length <= 6) return;
      const points = s.comp.points.filter((_, k) => k !== i * 2 && k !== i * 2 + 1);
      editor.updateComponent(s.maskId, s.comp.id, { points }, true, `${editor.mask(s.maskId)?.name}: Remove Corner`);
      return;
    }
    begin('vertex', s, e, i);
  }

  /** The edge after corner i of a polygon: a new corner where it was grabbed, dragged from there. */
  function onEdge(s: Shape, i: number, e: PointerEvent) {
    if (s.comp.kind !== 'polygon') return;
    const p = pxToMask(eventPx(e));
    if (!p) return;
    const points = [...s.comp.points];
    points.splice((i + 1) * 2, 0, p[0], p[1]);
    editor.updateComponent(s.maskId, s.comp.id, { points });
    begin('vertex', s, e, i + 1);
  }

  function onHover(e: PointerEvent) {
    cursor = eventPx(e);
    altHeld = e.altKey;
  }
</script>

<svg
  bind:this={svg}
  {width}
  {height}
  class="masks"
  class:drawing={!!editor.maskDraft || sampling || objectPoints}
  class:painting={editor.painting}
  role="presentation"
  onpointerdown={onBackgroundDown}
  onpointermove={onHover}
  onpointerleave={() => (cursor = null)}
>
  {#each shapes as s (s.comp.id)}
    {#if s.maskSelected}
      {#if s.geo?.type === 'polygon'}
        {@const g = s.geo}
        {@const pts = g.pts.map((q) => q.join(',')).join(' ')}
        <g class="outline" class:dim={!s.selected}>
          <polygon points={pts} class="under" />
          <polygon points={pts} />
        </g>
        <!-- Not while another shape is being drawn: its clicks must reach the photo. -->
        {#if s.selected && !g.freehand && !editor.readOnly && !editor.maskDraft}
          {#each g.pts as q, i (i)}
            {@const r = g.pts[(i + 1) % g.pts.length]!}
            <line x1={q[0]} y1={q[1]} x2={r[0]} y2={r[1]} class="edge-hit" role="presentation" onpointerdown={(e) => onEdge(s, i, e)}>
              <title>Drag to add a corner</title>
            </line>
          {/each}
          {#each g.pts as q, i (i)}
            <rect x={q[0] - hs} y={q[1] - hs} width={hs * 2} height={hs * 2} class="handle corner" role="presentation" onpointerdown={(e) => onCorner(s, i, e)}>
              <title>Drag to move; Alt+click to remove</title>
            </rect>
          {/each}
        {/if}
      {:else if s.geo?.type === 'radial'}
        {@const g = s.geo}
        <g transform="translate({g.c[0]} {g.c[1]}) rotate({g.rot})" class="outline" class:dim={!s.selected}>
          <ellipse rx={g.rx} ry={g.ry} class="under" />
          <ellipse rx={g.rx} ry={g.ry} />
          {#if s.selected && g.inner > 0.01 && g.inner < 0.99}<ellipse rx={g.rx * g.inner} ry={g.ry * g.inner} class="feather" />{/if}
        </g>
        {#if s.selected}
          <line x1={g.c[0]} y1={g.c[1]} x2={g.hr[0]} y2={g.hr[1]} class="stem" />
          {#each [['rx', g.hx], ['rx', g.hx2], ['ry', g.hy], ['ry', g.hy2]] as [k, h], i (i)}
            <rect
              x={(h as P)[0] - hs}
              y={(h as P)[1] - hs}
              width={hs * 2}
              height={hs * 2}
              class="handle"
              role="presentation"
              onpointerdown={(e) => begin(k as Kind, s, e)}
            />
          {/each}
          <circle cx={g.hr[0]} cy={g.hr[1]} r={hr} class="handle rotate" role="presentation" onpointerdown={(e) => begin('rotate', s, e)} />
        {/if}
      {:else if s.geo?.type === 'ai'}
        <g class="outline prompt" class:dim={!s.selected}>
          {#if s.geo.box}
            {@const pts = s.geo.box.map((q) => q.join(',')).join(' ')}
            <polygon points={pts} class="under" />
            <polygon points={pts} />
          {/if}
          {#each s.geo.points as q, i (i)}<circle cx={q[0]} cy={q[1]} r="3.5" class="dot" />{/each}
        </g>
      {:else if s.geo?.type === 'samples'}
        {#each s.geo.points as q, i (i)}
          <g class="sample" class:dim={!s.selected}>
            {#if q.r > 3}<circle cx={q.c[0]} cy={q.c[1]} r={q.r} class="area" />{/if}
            <line x1={q.c[0] - 7} y1={q.c[1]} x2={q.c[0] + 7} y2={q.c[1]} />
            <line x1={q.c[0]} y1={q.c[1] - 7} x2={q.c[0]} y2={q.c[1] + 7} />
          </g>
        {/each}
      {:else if s.geo?.type === 'linear'}
        {@const g = s.geo}
        <g class="outline" class:dim={!s.selected}>
          {#each [g.p0, g.mid, g.p1] as pt, i (i)}
            {@const l = line(pt, g.perp)}
            <line {...l} class="under" />
            <line {...l} class:mid={i === 1} />
          {/each}
        </g>
        {#if s.selected}
          <line x1={g.mid[0]} y1={g.mid[1]} x2={g.hr[0]} y2={g.hr[1]} class="stem" />
          <rect x={g.p0[0] - hs} y={g.p0[1] - hs} width={hs * 2} height={hs * 2} class="handle" role="presentation" onpointerdown={(e) => begin('p0', s, e)} />
          <rect x={g.p1[0] - hs} y={g.p1[1] - hs} width={hs * 2} height={hs * 2} class="handle" role="presentation" onpointerdown={(e) => begin('p1', s, e)} />
          <circle cx={g.hr[0]} cy={g.hr[1]} r={hr} class="handle rotate" role="presentation" onpointerdown={(e) => begin('rotate', s, e)} />
        {/if}
      {/if}
    {/if}
    <circle
      cx={s.pin[0]}
      cy={s.pin[1]}
      r={(s.selected ? 7 : 6) + pinGrow}
      class="pin"
      class:active={s.selected}
      class:other={!s.maskSelected}
      role="presentation"
      onpointerdown={(e) => {
        if (!s.fixed) return begin('move', s, e);
        e.stopPropagation();
        editor.selectMask(s.maskId, s.comp.id);
      }}
    >
      <title>{editor.mask(s.maskId)?.name}</title>
    </circle>
  {/each}
  {#if objectDrag && len(sub(objectDrag.end, objectDrag.start)) >= 6}
    {@const x = Math.min(objectDrag.start[0], objectDrag.end[0])}
    {@const y = Math.min(objectDrag.start[1], objectDrag.end[1])}
    {@const w = Math.abs(objectDrag.end[0] - objectDrag.start[0])}
    {@const h = Math.abs(objectDrag.end[1] - objectDrag.start[1])}
    <g class="outline prompt">
      <rect {x} {y} width={w} height={h} class="under" />
      <rect {x} {y} width={w} height={h} />
    </g>
  {/if}
  {#if draftPts.length}
    {@const last = draftPts[draftPts.length - 1]!}
    {@const corners = draftPts.map((q) => q.join(',')).join(' ')}
    <g class="outline draft">
      <polyline points={corners} class="under" />
      <polyline points={corners} />
      {#if cursor}
        {@const to = nearFirst ? draftPts[0]! : cursor}
        <line x1={last[0]} y1={last[1]} x2={to[0]} y2={to[1]} class="band" />
      {/if}
    </g>
    {#each draftPts as q, i (i)}
      <circle cx={q[0]} cy={q[1]} r={i === 0 ? (nearFirst ? 7 : 5) : 3.5} class="corner-dot" class:first={i === 0} class:snap={i === 0 && nearFirst} />
    {/each}
  {/if}
  {#if lasso && lasso.px.length > 1}
    {@const pts = lasso.px.map((q) => q.join(',')).join(' ')}
    <g class="outline draft">
      <polygon points={pts} class="under" />
      <polygon points={pts} />
    </g>
  {/if}
  {#if brushRing}
    <g class="brush" class:erase={editor.brush.erase || altHeld}>
      <circle cx={brushRing.c[0]} cy={brushRing.c[1]} r={brushRing.r} class="under" />
      <circle cx={brushRing.c[0]} cy={brushRing.c[1]} r={brushRing.r} />
      {#if brushRing.inner > 2 && brushRing.inner < brushRing.r - 2}<circle cx={brushRing.c[0]} cy={brushRing.c[1]} r={brushRing.inner} class="feather" />{/if}
      {#if editor.brush.erase || altHeld}<line x1={brushRing.c[0] - 5} y1={brushRing.c[1]} x2={brushRing.c[0] + 5} y2={brushRing.c[1]} />{/if}
    </g>
  {/if}
</svg>

<style>
  .masks {
    position: absolute;
    inset: 0;
    overflow: hidden;
    pointer-events: none;
    touch-action: none;
  }
  .masks.drawing {
    pointer-events: all;
    cursor: crosshair;
  }
  .masks.painting {
    pointer-events: all;
    cursor: none;
  }
  .brush {
    fill: none;
    stroke: #fff;
    stroke-width: 1.2;
    pointer-events: none;
  }
  .brush .under {
    stroke: rgba(0, 0, 0, 0.6);
    stroke-width: 3;
  }
  .brush .feather {
    stroke-dasharray: 3 3;
    opacity: 0.8;
  }
  .brush.erase {
    stroke: #ffb4a8;
  }
  .sample {
    stroke: #fff;
    stroke-width: 1.5;
    fill: none;
    pointer-events: none;
    filter: drop-shadow(0 0 1px rgba(0, 0, 0, 0.9));
  }
  .sample.dim {
    opacity: 0.55;
  }
  .sample .area {
    stroke-dasharray: 4 3;
  }
  .outline {
    fill: none;
    stroke: #fff;
    stroke-width: 1.4;
    pointer-events: none;
  }
  .outline.dim {
    opacity: 0.55;
  }
  .outline .under {
    stroke: rgba(0, 0, 0, 0.55);
    stroke-width: 3.2;
  }
  .outline .mid {
    stroke-dasharray: 6 4;
  }
  .prompt polygon:not(.under),
  .prompt rect:not(.under) {
    stroke-dasharray: 6 4;
  }
  .prompt .dot {
    fill: #fff;
    stroke: rgba(0, 0, 0, 0.7);
    stroke-width: 1.5;
  }
  .feather {
    stroke-dasharray: 4 4;
    opacity: 0.8;
  }
  .stem {
    stroke: #fff;
    stroke-width: 1;
    opacity: 0.7;
    pointer-events: none;
  }
  .handle {
    fill: #fff;
    stroke: #222;
    stroke-width: 1.2;
    pointer-events: all;
    cursor: pointer;
  }
  .handle.corner {
    cursor: move;
  }
  .edge-hit {
    stroke: transparent;
    stroke-width: 12;
    pointer-events: stroke;
    cursor: copy;
  }
  .draft polyline:not(.under),
  .draft polygon:not(.under) {
    stroke-dasharray: 6 4;
  }
  .draft .band {
    stroke-dasharray: 3 4;
    opacity: 0.85;
  }
  .corner-dot {
    fill: #fff;
    stroke: rgba(0, 0, 0, 0.7);
    stroke-width: 1.5;
    pointer-events: none;
  }
  .corner-dot.first {
    fill: var(--accent, #4c9aff);
  }
  .corner-dot.snap {
    stroke: #fff;
    stroke-width: 2;
  }
  .handle.rotate {
    fill: #ddd;
    cursor: grab;
  }
  .pin {
    fill: #fff;
    stroke: #222;
    stroke-width: 2;
    pointer-events: all;
    cursor: move;
  }
  .pin.active {
    fill: var(--accent, #4c9aff);
    stroke: #fff;
  }
  .pin.other {
    fill: #9a9a9a;
    cursor: pointer;
  }
</style>
