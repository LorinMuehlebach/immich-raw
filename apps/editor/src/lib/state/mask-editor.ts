// Mask editing: what the Masking panel and the on-image handles do to the recipe's masks.
//
// A plain class with no Svelte in it. It changes two objects it is given in place: the
// recipe's masks (through the host) and a MaskUi record. The Editor passes both as $state
// proxies, so the panel and the overlay update; tests pass plain objects.
//
// Every change ends in host.changed(commit, label): live while dragging (commit = false), one
// history step when the gesture ends. Refusals (read-only photo, a limit reached) tell the user
// through host.notify and change nothing. Nothing throws; unknown ids are ignored.
import { brushRadius, simplifyPolygon } from '@immich-raw/pipeline';
import {
  BRUSH_DENSITY,
  BRUSH_FEATHER,
  BRUSH_FLOW,
  BRUSH_SIZE,
  COMPONENT_LABELS,
  LOCAL_PARAMS,
  MAX_AI,
  MAX_BRUSHES,
  MAX_BRUSH_POINTS,
  MAX_COLOR_SAMPLES,
  MAX_COMPONENTS,
  MAX_MASKS,
  MAX_OBJECT_POINTS,
  MAX_POLYGON_POINTS,
  aiCount,
  aiLabel,
  brushCount,
  clampParam,
  componentCount,
  componentLabel,
  defaultEdge,
  formatParam,
  getPath,
  isEdgeSet,
  newAiComponent,
  newComponent,
  newMask,
  setPath,
  type AiComponent,
  type AiTarget,
  type ComponentKind,
  type LandscapeClass,
  type LocalKey,
  type Mask,
  type MaskComponent,
  type MaskEdge,
  type MaskMode,
  type ParamSpec,
  type PersonPart,
  type PolygonComponent,
} from '@immich-raw/recipe';

type P = [number, number];

export const READ_ONLY_NOTICE = 'This photo belongs to someone else, so it can only be viewed.';

/** A gradient waiting to be drawn on the photo: a new mask, or a component of an existing one. */
export interface MaskDraft {
  /**
   * object: Lightroom's Objects (drag a box around it, or click it). polygon: click the
   * corners; lasso: drag around the area.
   */
  kind: 'linear' | 'radial' | 'brush' | 'color' | 'object' | 'polygon' | 'lasso';
  mode: MaskMode;
  /** Mask to add it to; null = create a new mask. */
  maskId: string | null;
  /** Polygon: the corners clicked so far, flat [x, y, ...] in the mask frame. */
  points?: number[];
}

/** The People or Landscape choices before the AI mask is made. */
export interface AiPicker {
  target: 'people' | 'landscape';
  mode: MaskMode;
  maskId: string | null;
  parts: PersonPart[];
  classes: LandscapeClass[];
  /** Index into the people found of the person picked; -1 = everyone. */
  who: number;
}

/** Brush settings (Lightroom's brush panel); each stroke keeps the values it was painted with. */
export interface BrushSettings {
  size: number;
  feather: number;
  flow: number;
  density: number;
  /** Paint with the eraser (Alt does the same while held). */
  erase: boolean;
}

/** What is being edited on the selected mask: its shape (the red overlay shows) or its adjustments. */
export type MaskEditMode = 'shape' | 'adjust';

/** The Masking panel's own state (not part of the recipe). */
export interface MaskUi {
  sel: { mask: string | null; comp: string | null };
  draft: MaskDraft | null;
  picker: AiPicker | null;
  /** The red overlay is wanted (checkbox, O). It shows only while the shape is edited. */
  overlay: boolean;
  editing: MaskEditMode;
  brush: BrushSettings;
}

/** What mask editing needs from the editor. */
export interface MaskHost {
  /** The recipe being edited; its masks are changed in place. */
  recipe(): { masks: Mask[] };
  readOnly(): boolean;
  /** The Masking tool is open. */
  toolActive(): boolean;
  /** Opens the Masking tool (the editor then calls toolChanged(true)). */
  openTool(): void;
  /** Names the pending history step (if a label is given), commits it if asked, re-renders. */
  changed(commit: boolean, label?: string): void;
  render(): void;
  notify(message: string): void;
  saveBrush(brush: Omit<BrushSettings, 'erase'>): void;
  /** Starts looking for the people in the photo (for the People picker). */
  findPeople(): void;
  /** Mask-frame point of person `index` of the people found; null = everyone, or not found. */
  personPoint(index: number): { x: number; y: number } | null;
}

/** Dragging a part's handle, or the part just drawn: patches arrive live, `end` commits. */
export interface ShapeGesture {
  kind: 'shape';
  maskId: string;
  compId: string;
  /** The part as it is now (live). Snapshot it to compute patches from where the drag started. */
  comp: MaskComponent;
  /** The part was just drawn on the photo (its size comes from the drag). */
  drawing: boolean;
  /** A colour sample being placed (drag to average an area). */
  sampleIndex?: number;
  move(patch: Partial<MaskComponent>): void;
  /** Ends the drag; draggedPx is how far the pointer went (a click gives a drawn part its default size). */
  end(draggedPx: number): void;
}

/** A brush stroke being painted. */
export interface StrokeGesture {
  kind: 'stroke';
  to(p: P): void;
  end(): void;
}

/** Pointing out an object: a box dragged around it, or a click on it. Abandon it to cancel. */
export interface ObjectGesture {
  kind: 'object';
  end(box: [number, number, number, number] | null, click: P | null): void;
}

export type PhotoGesture = ShapeGesture | StrokeGesture | ObjectGesture;

const BRUSH_SPECS = { size: BRUSH_SIZE, feather: BRUSH_FEATHER, flow: BRUSH_FLOW, density: BRUSH_DENSITY } as const;

function normalizeBrush(v: unknown): BrushSettings {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const num = (k: keyof typeof BRUSH_SPECS) => clampParam(BRUSH_SPECS[k], typeof o[k] === 'number' ? (o[k] as number) : BRUSH_SPECS[k].default);
  return { size: num('size'), feather: num('feather'), flow: num('flow'), density: num('density'), erase: false };
}

/** The panel's state for a new session; `storedBrush` is the brush kept in this browser (or null). */
export function initialMaskUi(storedBrush: unknown): MaskUi {
  return { sel: { mask: null, comp: null }, draft: null, picker: null, overlay: true, editing: 'shape', brush: normalizeBrush(storedBrush) };
}

/** Stroke points are stored with 5 decimals. */
const q5 = (v: number) => Math.round(v * 1e5) / 1e5;

const MODE_VERB: Record<MaskMode, string> = { add: 'Add', subtract: 'Subtract', intersect: 'Intersect' };

/** History name of a mask part. */
const partLabel = componentLabel;

/** A drag shorter than this (CSS pixels) is a click. */
const CLICK_PX = 6;

export class MaskEditor {
  /** History label for the gradient being drawn ("New Mask: Radial Gradient"). */
  private drawLabel: string | null = null;
  /** A brush stroke is being painted. */
  private stroking = false;

  constructor(
    readonly ui: MaskUi,
    private readonly host: MaskHost,
  ) {}

  private get masks(): Mask[] {
    return this.host.recipe().masks;
  }

  // ---------------------------------------------------------------- queries

  mask(id: string | null): Mask | null {
    return id ? (this.masks.find((m) => m.id === id) ?? null) : null;
  }

  private part(maskId: string, compId: string): { m: Mask; c: MaskComponent } | null {
    const m = this.mask(maskId);
    const c = m?.components.find((x) => x.id === compId);
    return m && c ? { m, c } : null;
  }

  get selectedMask(): Mask | null {
    return this.mask(this.ui.sel.mask);
  }

  get selectedComponent(): MaskComponent | null {
    return this.selectedMask?.components.find((c) => c.id === this.ui.sel.comp) ?? null;
  }

  /** Mask shown in red: the selected one while its shape is edited (and the overlay is on). */
  get overlayMask(): string | null {
    return this.host.toolActive() && this.ui.overlay && this.ui.editing === 'shape' ? this.ui.sel.mask : null;
  }

  /** Is painting on the photo active (a brush armed, or a brush part selected)? */
  get painting(): boolean {
    const d = this.ui.draft;
    return this.host.toolActive() && !this.host.readOnly() && (d?.kind === 'brush' || (!d && this.selectedComponent?.kind === 'brush'));
  }

  /** Does a press on the photo do something (draw, paint, pick a colour, point out an object)? */
  get photoActive(): boolean {
    if (this.ui.draft) return true;
    if (!this.host.toolActive() || this.host.readOnly()) return false;
    const c = this.selectedComponent;
    return c?.kind === 'brush' || c?.kind === 'color' || this.objectPoints(c);
  }

  /** A clicked object is selected: Shift+click adds points to it. */
  private objectPoints(c: MaskComponent | null): boolean {
    return !this.ui.draft && c?.kind === 'ai' && c.target === 'object' && !c.box;
  }

  /** Value of one of the selected mask's adjustment sliders (or Amount). */
  value(spec: ParamSpec): number {
    const m = this.selectedMask;
    return m ? (getPath(m, spec.path) as number) : spec.default;
  }

  // ---------------------------------------------------------------- mode and selection

  private guard(): boolean {
    if (this.host.readOnly()) this.host.notify(READ_ONLY_NOTICE);
    return this.host.readOnly();
  }

  private editShape(): void {
    if (this.ui.editing === 'shape') return;
    this.ui.editing = 'shape';
    this.host.render();
  }

  private editAdjust(): void {
    if (this.ui.editing === 'adjust') return;
    this.ui.editing = 'adjust';
    this.host.render();
  }

  /** A click in the panel's mask settings ('shape') or adjustments ('adjust') area. */
  setEditing(mode: MaskEditMode): void {
    if (mode === 'shape') this.editShape();
    else this.editAdjust();
  }

  select(maskId: string | null, compId?: string): void {
    const m = this.mask(maskId);
    this.ui.sel = { mask: m?.id ?? null, comp: compId ?? m?.components[0]?.id ?? null };
    this.ui.editing = 'shape';
    this.host.render();
  }

  /** The Overlay checkbox: wanted or not (switched on, it shows right away). */
  setOverlay(on: boolean): void {
    this.ui.overlay = on;
    if (on) this.ui.editing = 'shape';
    this.host.render();
  }

  /** O: an overlay that is wanted but hidden while adjusting comes back; otherwise on/off. */
  toggleOverlay(): void {
    if (this.ui.overlay && this.ui.editing === 'adjust') {
      this.ui.editing = 'shape';
      this.host.render();
    } else this.setOverlay(!this.ui.overlay);
  }

  /** Another photo or copy is in the editor: nothing selected or armed. */
  reset(): void {
    this.ui.sel = { mask: null, comp: null };
    this.ui.draft = null;
    this.ui.picker = null;
    this.ui.editing = 'shape';
    this.drawLabel = null;
    this.stroking = false;
  }

  /** The editor switched tools: leaving Masking disarms; entering it selects the last mask. */
  toolChanged(entering: boolean): void {
    if (!entering) {
      this.ui.draft = null;
      this.ui.picker = null;
      return;
    }
    if (!this.ui.sel.mask && this.masks.length) {
      const last = this.masks[this.masks.length - 1]!;
      this.ui.sel = { mask: last.id, comp: last.components[0]?.id ?? null };
    }
  }

  // ---------------------------------------------------------------- arming

  /** Room for another component (and, for a new mask, another mask)? Tells the user if not. */
  private room(newMask: boolean, ai = false): boolean {
    if (newMask && this.masks.length >= MAX_MASKS) {
      this.host.notify(`Up to ${MAX_MASKS} masks are supported.`);
      return false;
    }
    if (componentCount(this.masks) >= MAX_COMPONENTS) {
      this.host.notify(`Up to ${MAX_COMPONENTS} mask parts are supported in total.`);
      return false;
    }
    if (ai && aiCount(this.masks) >= MAX_AI) {
      this.host.notify(`Up to ${MAX_AI} AI mask parts are supported in total.`);
      return false;
    }
    return true;
  }

  private uniqueName(base: string): string {
    const used = new Set(this.masks.map((m) => m.name));
    if (!used.has(base)) return base;
    let n = 2;
    while (used.has(`${base} ${n}`)) n++;
    return `${base} ${n}`;
  }

  private nextName(): string {
    const used = new Set(this.masks.map((m) => m.name));
    let n = this.masks.length + 1;
    while (used.has(`Mask ${n}`)) n++;
    return `Mask ${n}`;
  }

  /**
   * Arms a gradient to be drawn on the photo (Lightroom's M / Shift+M); luminance ranges are
   * added right away. mode/maskId: add to, subtract from or intersect with an existing mask.
   */
  start(kind: ComponentKind | 'lasso', mode: MaskMode = 'add', maskId: string | null = null): void {
    if (kind === 'ai') return this.startAi('subject', mode, maskId);
    if (this.guard() || !this.room(!maskId)) return;
    if (!this.host.toolActive()) this.host.openTool();
    this.ui.picker = null;
    this.editShape();
    if (kind === 'luminance') {
      this.addComponent(newComponent('luminance', maskId ? mode : 'add'), maskId);
      this.host.changed(true, `${maskId ? 'Add' : 'New Mask:'} ${COMPONENT_LABELS.luminance}`);
      return;
    }
    if ((kind === 'brush' || kind === 'polygon' || kind === 'lasso') && brushCount(this.masks) >= MAX_BRUSHES) {
      this.host.notify(`Up to ${MAX_BRUSHES} brush, polygon and lasso parts are supported in total.`);
      return;
    }
    this.ui.draft = { kind, mode: maskId ? mode : 'add', maskId, ...(kind === 'polygon' ? { points: [] } : {}) };
  }

  /**
   * Lightroom's AI masks. Subject, Sky and Background are added right away; People and
   * Landscape first show their choices; an object is pointed out on the photo.
   */
  startAi(target: AiTarget, mode: MaskMode = 'add', maskId: string | null = null): void {
    if (this.guard() || !this.room(!maskId, true)) return;
    if (!this.host.toolActive()) this.host.openTool();
    const m = maskId ? mode : 'add';
    this.ui.draft = null;
    this.ui.picker = null;
    this.editShape();
    if (target === 'people' || target === 'landscape') {
      this.ui.picker = { target, mode: m, maskId, parts: ['person'], classes: ['sky'], who: -1 };
      if (target === 'people') this.host.findPeople();
      return;
    }
    if (target === 'object') {
      this.ui.draft = { kind: 'object', mode: m, maskId };
      return;
    }
    this.addAiComponent(newAiComponent(target, m), maskId);
  }

  cancelDraft(): void {
    this.ui.draft = null;
    this.ui.picker = null;
  }

  setPicker(patch: Partial<Pick<AiPicker, 'parts' | 'classes' | 'who'>>): void {
    if (this.ui.picker) this.ui.picker = { ...this.ui.picker, ...patch };
  }

  /** Makes the People or Landscape mask chosen in the picker. */
  confirmPicker(): void {
    const p = this.ui.picker;
    if (!p || this.guard()) return;
    if (p.target === 'landscape' && !p.classes.length) return;
    if (p.target === 'people' && !p.parts.length) return;
    this.ui.picker = null;
    const person = this.host.personPoint(p.who);
    this.addAiComponent(newAiComponent(p.target, p.mode, p.target === 'people' ? { parts: p.parts, person } : { classes: p.classes }), p.maskId);
  }

  private addAiComponent(c: AiComponent, maskId: string | null): void {
    if (!this.room(!maskId, true)) return;
    this.addComponent(c, maskId, this.uniqueName(aiLabel(c)));
    this.host.changed(true, `${maskId ? MODE_VERB[c.mode] : 'New Mask:'} ${aiLabel(c)}`);
  }

  private addComponent(c: MaskComponent, maskId: string | null, name?: string): void {
    this.editShape();
    const target = this.mask(maskId);
    if (target) {
      target.components.push(c);
      this.ui.sel = { mask: target.id, comp: c.id };
    } else {
      const m = newMask(name ?? this.nextName(), c);
      this.masks.push(m);
      this.ui.sel = { mask: m.id, comp: c.id };
    }
  }

  // ---------------------------------------------------------------- polygon and lasso

  /** Polygon being drawn: a corner at mask-frame point p. */
  addPolygonPoint(p: P): void {
    const d = this.ui.draft;
    if (d?.kind !== 'polygon' || this.guard()) return;
    const points = d.points ?? [];
    if (points.length >= MAX_POLYGON_POINTS * 2) {
      this.host.notify(`Up to ${MAX_POLYGON_POINTS} corners per polygon.`);
      return;
    }
    this.ui.draft = { ...d, points: [...points, q5(p[0]), q5(p[1])] };
  }

  /** Polygon being drawn: takes back the last corner (Backspace). */
  removePolygonPoint(): void {
    const d = this.ui.draft;
    if (d?.kind !== 'polygon' || !d.points?.length) return;
    this.ui.draft = { ...d, points: d.points.slice(0, -2) };
  }

  /** Polygon being drawn: closes it and adds it (needs three corners). */
  closePolygon(): boolean {
    const d = this.ui.draft;
    if (d?.kind !== 'polygon' || (d.points?.length ?? 0) < 6) return false;
    return this.addPolygon(d.points!, false);
  }

  /** Lasso: the outline dragged on the photo (mask frame), closed and simplified. */
  drawLasso(points: number[]): boolean {
    if (this.ui.draft?.kind !== 'lasso') return false;
    // Corners closer than half a brush-map texel to the outline add nothing.
    return this.addPolygon(simplifyPolygon(points, 0.5 / 2048, MAX_POLYGON_POINTS), true);
  }

  private addPolygon(points: number[], freehand: boolean): boolean {
    const d = this.ui.draft;
    if (!d || this.guard() || points.length < 6 || !this.room(!d.maskId)) return false;
    this.ui.draft = null;
    const c = newComponent('polygon', d.mode) as PolygonComponent;
    c.points = points.map(q5);
    if (freehand) c.freehand = true;
    this.addComponent(c, d.maskId);
    this.host.changed(true, `${d.maskId ? MODE_VERB[d.mode] : 'New Mask:'} ${partLabel(c)}`);
    return true;
  }

  /**
   * A press on the edge after corner `after` of a polygon: a new corner at p, returned as a
   * drag of that corner (its index is after + 1).
   */
  addCorner(maskId: string, compId: string, after: number, p: P): ShapeGesture | null {
    const c = this.part(maskId, compId)?.c;
    if (c?.kind !== 'polygon' || this.guard()) return null;
    if (c.points.length >= MAX_POLYGON_POINTS * 2) {
      this.host.notify(`Up to ${MAX_POLYGON_POINTS} corners per polygon.`);
      return null;
    }
    const points = [...c.points];
    points.splice((after + 1) * 2, 0, q5(p[0]), q5(p[1]));
    this.updateComponent(maskId, compId, { points });
    return this.grab(maskId, compId);
  }

  /** Alt+click on corner `index` of a polygon: removes it (a polygon keeps three corners). */
  removeCorner(maskId: string, compId: string, index: number): void {
    const found = this.part(maskId, compId);
    const c = found?.c;
    if (c?.kind !== 'polygon' || c.points.length <= 6 || index < 0 || index * 2 >= c.points.length) return;
    const points = c.points.filter((_, k) => k !== index * 2 && k !== index * 2 + 1);
    this.updateComponent(maskId, compId, { points }, true, `${found!.m.name}: Remove Corner`);
  }

  // ---------------------------------------------------------------- gestures on the photo

  /**
   * A press on the photo at mask-frame point p. Depending on what is armed or selected it
   * paints, points out an object, adds an object point (Shift), picks a colour (Shift adds one)
   * or draws the armed gradient. Returns the gesture to follow the pointer with, or null when
   * the press is done (or did nothing).
   */
  press(p: P, mods: { shift: boolean; erase: boolean }): PhotoGesture | null {
    if (this.painting) return this.beginStroke(p, mods.erase);
    const d = this.ui.draft;
    if (d?.kind === 'object') {
      const object: ObjectGesture = { kind: 'object', end: (box, click) => this.drawObject(box, click) };
      return object;
    }
    const sel = this.selectedComponent;
    if (this.host.toolActive() && !this.host.readOnly() && this.objectPoints(sel)) {
      if (mods.shift) this.addObjectPoint(p);
      return null;
    }
    if (!d && sel?.kind === 'color') {
      const index = this.sampleColor(p, mods.shift);
      return index === null ? null : this.grab(this.ui.sel.mask!, sel.id, index);
    }
    if (!d) return null;
    return this.beginDraw(p);
  }

  /** A press on a part's handle (or its pin): selects the part and returns the drag. */
  grab(maskId: string, compId: string, sampleIndex?: number): ShapeGesture | null {
    this.select(maskId, compId);
    const found = this.part(maskId, compId);
    if (!found) return null;
    return {
      kind: 'shape',
      maskId,
      compId,
      comp: found.c,
      drawing: false,
      sampleIndex,
      move: (patch) => this.updateComponent(maskId, compId, patch),
      end: () => this.host.changed(true),
    };
  }

  /** Starts drawing the armed gradient (or colour range) at p. */
  private beginDraw(p: P): ShapeGesture | null {
    const d = this.ui.draft;
    // Objects, polygons and lassos are drawn with their own calls.
    if (!d || d.kind === 'object' || d.kind === 'polygon' || d.kind === 'lasso' || this.guard()) return null;
    const c = newComponent(d.kind, d.mode);
    if (c.kind === 'linear') Object.assign(c, { x0: p[0], y0: p[1], x1: p[0], y1: p[1] + 1e-3 });
    else if (c.kind === 'radial') Object.assign(c, { cx: p[0], cy: p[1], rx: 1e-3, ry: 1e-3 });
    else if (c.kind === 'color') c.samples = [{ x: q5(p[0]), y: q5(p[1]), r: 0 }];
    this.addComponent(c, d.maskId);
    this.ui.draft = null;
    const label = `${d.maskId ? MODE_VERB[d.mode] : 'New Mask:'} ${COMPONENT_LABELS[d.kind]}`;
    this.drawLabel = label;
    this.host.changed(false, label);
    const maskId = this.ui.sel.mask!;
    const compId = c.id;
    // The live part (the one in the recipe, not the object built above).
    const comp = this.part(maskId, compId)!.c;
    return {
      kind: 'shape',
      maskId,
      compId,
      comp,
      drawing: true,
      move: (patch) => this.updateComponent(maskId, compId, patch),
      end: (draggedPx) => this.finishDraw(maskId, compId, draggedPx),
    };
  }

  /** Ends a gradient drawn by a click without a drag: gives it a useful default size. */
  private finishDraw(maskId: string, compId: string, draggedPx: number): void {
    const c = this.part(maskId, compId)?.c;
    if (c && draggedPx < CLICK_PX) {
      if (c.kind === 'radial') Object.assign(c, { rx: 0.15, ry: 0.15 });
      else if (c.kind === 'linear') Object.assign(c, { y1: c.y0 + 0.15, x1: c.x0 });
    }
    this.host.changed(true, this.drawLabel ?? undefined);
    this.drawLabel = null;
  }

  /** Starts a stroke at p: on the selected brush part, or a new brush if one is armed. */
  private beginStroke(p: P, erase: boolean): StrokeGesture | null {
    if (this.guard() || this.stroking) return null;
    let label: string;
    if (this.ui.draft?.kind === 'brush') {
      if (erase) return null; // nothing to erase yet
      if (!this.beginDraw(p)) return null;
      label = this.drawLabel ?? 'Brush';
      this.drawLabel = null;
    } else {
      if (this.selectedComponent?.kind !== 'brush') return null;
      label = `${this.selectedMask!.name}: ${erase ? 'Erase' : 'Brush Stroke'}`;
    }
    const m = this.selectedMask;
    const c = this.selectedComponent;
    if (!m || !c || c.kind !== 'brush') return null;
    this.editShape();
    const b = this.ui.brush;
    c.strokes.push({ erase, size: q5(brushRadius(b.size)), feather: b.feather, flow: b.flow, density: b.density, points: [q5(p[0]), q5(p[1])] });
    this.stroking = true;
    this.host.changed(false, label);
    const maskId = m.id;
    const compId = c.id;
    let open = true;
    return {
      kind: 'stroke',
      to: (q) => {
        if (open) this.extendStroke(maskId, compId, q, label);
      },
      end: () => {
        if (!open) return;
        open = false;
        this.stroking = false;
        this.host.changed(true, label);
      },
    };
  }

  private extendStroke(maskId: string, compId: string, p: P, label: string): void {
    const c = this.part(maskId, compId)?.c;
    if (!c || c.kind !== 'brush') return;
    const st = c.strokes[c.strokes.length - 1];
    if (!st) return;
    const n = st.points.length;
    // A point every ~fifth of the radius is plenty; dabs are interpolated between them.
    if (Math.hypot(p[0] - st.points[n - 2]!, p[1] - st.points[n - 1]!) < st.size * 0.2) return;
    if (c.strokes.reduce((k, x) => k + x.points.length, 0) >= MAX_BRUSH_POINTS * 2) {
      this.host.notify('This brush mask is full. Start a new brush part to keep painting.');
      return;
    }
    st.points.push(q5(p[0]), q5(p[1]));
    this.host.changed(false, label);
  }

  /** Objects: the box dragged around it, or the point clicked (mask frame). */
  private drawObject(box: [number, number, number, number] | null, point: P | null): void {
    const d = this.ui.draft;
    if (!d || d.kind !== 'object' || this.guard()) return;
    this.ui.draft = null;
    const c = box
      ? newAiComponent('object', d.mode, { box: [q5(Math.min(box[0], box[2])), q5(Math.min(box[1], box[3])), q5(Math.max(box[0], box[2])), q5(Math.max(box[1], box[3]))] })
      : point
        ? newAiComponent('object', d.mode, { points: [q5(point[0]), q5(point[1])] })
        : null;
    if (c) this.addAiComponent(c, d.maskId);
  }

  /** Shift+click with a clicked object selected: one more point on the object. */
  private addObjectPoint(p: P): void {
    const m = this.selectedMask;
    const c = this.selectedComponent;
    if (!m || !c || c.kind !== 'ai' || c.target !== 'object' || c.box || this.guard()) return;
    const points = c.points ?? [];
    if (points.length >= MAX_OBJECT_POINTS * 2) {
      this.host.notify(`Up to ${MAX_OBJECT_POINTS} points per object.`);
      return;
    }
    this.updateComponent(m.id, c.id, { points: [...points, q5(p[0]), q5(p[1])] }, true, `${m.name}: Add Object Point`);
  }

  /** Adds a colour sample at p to the selected colour range (or replaces its samples); returns its index. */
  private sampleColor(p: P, add: boolean): number | null {
    const m = this.selectedMask;
    const c = this.selectedComponent;
    if (this.guard() || !m || !c || c.kind !== 'color') return null;
    const sample = { x: q5(p[0]), y: q5(p[1]), r: 0 };
    if (add && c.samples.length >= MAX_COLOR_SAMPLES) {
      this.host.notify(`Up to ${MAX_COLOR_SAMPLES} colour samples per range.`);
      return null;
    }
    this.editShape();
    c.samples = add ? [...c.samples, sample] : [sample];
    this.host.changed(false, `${m.name}: ${add ? 'Add Color Sample' : 'Color Sample'}`);
    return c.samples.length - 1;
  }

  // ---------------------------------------------------------------- panel edits

  /** Changes a component's geometry or settings (live while dragging; commit when done). */
  updateComponent(maskId: string, compId: string, patch: Partial<MaskComponent>, commit = false, label?: string): void {
    if (this.guard()) return;
    const found = this.part(maskId, compId);
    if (!found) return;
    const { m, c } = found;
    this.editShape();
    Object.assign(c, patch);
    if (c.kind === 'radial') {
      c.rx = Math.min(4, Math.max(1e-3, c.rx));
      c.ry = Math.min(4, Math.max(1e-3, c.ry));
      c.angle = ((c.angle % 360) + 360) % 360;
    } else if (c.kind === 'luminance' && c.lo > c.hi) {
      [c.lo, c.hi] = [c.hi, c.lo];
    }
    this.host.changed(commit, label ?? `${m.name}: Edit ${partLabel(c)}`);
  }

  /** Changes what an AI part selects (People parts and who, Landscape categories). */
  setAiComponent(maskId: string, compId: string, patch: { parts?: PersonPart[]; classes?: LandscapeClass[]; who?: number }): void {
    const found = this.part(maskId, compId);
    if (!found || found.c.kind !== 'ai' || this.guard()) return;
    const { m, c } = found;
    const next: Partial<AiComponent> = {};
    if (patch.parts) {
      if (!patch.parts.length) return;
      next.parts = patch.parts;
    }
    if (patch.classes) {
      if (!patch.classes.length) return;
      next.classes = patch.classes;
    }
    if (patch.who !== undefined) next.person = this.host.personPoint(patch.who);
    this.updateComponent(maskId, compId, next, true, `${m.name}: ${aiLabel({ ...c, ...next })}`);
  }

  removeColorSample(index: number): void {
    const m = this.selectedMask;
    const c = this.selectedComponent;
    if (this.guard() || !m || !c || c.kind !== 'color') return;
    this.editShape();
    c.samples = c.samples.filter((_, i) => i !== index);
    this.host.changed(true, `${m.name}: Remove Color Sample`);
  }

  /** Sets one of the selected mask's adjustment sliders (or Amount). */
  setParam(spec: ParamSpec, value: number, commit = false): void {
    const m = this.selectedMask;
    if (!m || this.guard()) return;
    this.editAdjust();
    const v = clampParam(spec, value);
    setPath(m, spec.path, v);
    this.host.changed(commit, `${m.name}: ${spec.label} ${formatParam(spec, v)}`);
  }

  /**
   * Edge refinement (Offset, Feather, Smooth; spec paths "edge.*") of part `compId` of a
   * mask, or of the whole mask when compId is null. A part keeps a refinement only while it
   * does something.
   */
  setEdge(maskId: string, compId: string | null, spec: ParamSpec, value: number, commit = false): void {
    const m = this.mask(maskId);
    const c = compId ? m?.components.find((x) => x.id === compId) : null;
    if (!m || (compId && !c) || this.guard()) return;
    this.editShape();
    const v = Math.round(clampParam(spec, value));
    const key = spec.path.slice('edge.'.length) as keyof MaskEdge;
    if (c) {
      const e = { ...defaultEdge(), ...c.edge, [key]: v };
      if (isEdgeSet(e)) c.edge = e;
      else delete c.edge;
    } else {
      m.edge[key] = v;
    }
    this.host.changed(commit, `${m.name}: ${c ? `${partLabel(c)} ` : ''}${spec.label} ${formatParam(spec, v)}`);
  }

  resetAdjust(): void {
    const m = this.selectedMask;
    if (!m || this.guard()) return;
    this.editAdjust();
    for (const k of Object.keys(LOCAL_PARAMS) as LocalKey[]) m.adjust[k] = 0;
    m.amount = 100;
    this.host.changed(true, `${m.name}: Reset`);
  }

  deleteComponent(maskId: string, compId: string): void {
    const m = this.mask(maskId);
    if (!m || this.guard()) return;
    if (m.components.length <= 1) return this.deleteMask(maskId);
    const c = m.components.find((x) => x.id === compId);
    m.components = m.components.filter((x) => x.id !== compId);
    m.components[0]!.mode = 'add';
    this.ui.sel = { mask: m.id, comp: m.components[0]!.id };
    this.editShape();
    this.host.changed(true, `${m.name}: Remove ${c ? partLabel(c) : 'part'}`);
  }

  deleteMask(maskId: string): void {
    const m = this.mask(maskId);
    if (!m || this.guard()) return;
    const recipe = this.host.recipe();
    recipe.masks = recipe.masks.filter((x) => x.id !== maskId);
    if (this.ui.sel.mask === maskId) {
      const last = recipe.masks[recipe.masks.length - 1];
      this.ui.sel = { mask: last?.id ?? null, comp: last?.components[0]?.id ?? null };
    }
    this.host.changed(true, `Delete ${m.name}`);
  }

  rename(maskId: string, name: string): void {
    const m = this.mask(maskId);
    const n = name.trim().slice(0, 60);
    if (!m || !n || n === m.name || this.guard()) return;
    m.name = n;
    this.host.changed(true, `Rename Mask: ${n}`);
  }

  toggleVisible(maskId: string): void {
    const m = this.mask(maskId);
    if (!m || this.guard()) return;
    m.visible = !m.visible;
    this.host.changed(true, `${m.name}: ${m.visible ? 'Show' : 'Hide'}`);
  }

  invert(maskId: string, compId: string): void {
    const found = this.part(maskId, compId);
    if (found) this.updateComponent(maskId, compId, { invert: !found.c.invert }, true, `${found.m.name}: Invert ${partLabel(found.c)}`);
  }

  setBrush(patch: Partial<BrushSettings>): void {
    const b = { ...this.ui.brush, ...patch };
    this.ui.brush = { ...normalizeBrush(b), erase: !!b.erase };
    const { size, feather, flow, density } = this.ui.brush;
    this.host.saveBrush({ size, feather, flow, density });
  }
}
