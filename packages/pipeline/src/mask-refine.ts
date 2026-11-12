// Edge refinement (Offset, Feather, Smooth) of mask parts and of whole masks. A refined edge
// can't be evaluated pixel by pixel like the parts: it depends on the neighbourhood. So each
// refined part, and then each refined mask, is rendered once into a map over the decoded image
// (source coordinates s, sensor orientation, square texels), refined there on the GPU, and
// packed into an atlas the develop passes read as a single part:
//   - refined parts  -> uPartRefined (componentWeight kind 7), combined like any other part;
//   - refined masks  -> uMaskRefined (kind 8), rendered from their parts (refined ones read
//     from the parts atlas), so a part is refined first and the whole mask after.
// Preview, zoom and export read the same maps, so they match.
//
// Steps, in texels of the map:
//   render : the part or mask (FS_MASK_RENDER), from the preview proxy
//   smooth : Gaussian, then crisp again around 50 % - wiggles and specks smaller than the
//            radius go away (a soft gradient becomes a crisp edge)
//   offset : grey-level dilation (grow) or erosion (shrink) by an octagon close to a disc
//   feather: Gaussian, so the edge fades over about the feather width, centred on it
import { canonicalJson, isMaskRefined, isPartRefined, type Mask, type MaskComponent, type MaskEdge } from '@immich-raw/recipe';
import type { GLContext, Program, Target, UniformValue } from './gl.ts';
import { maskFrameScale, maskPartsUniforms, type MaskResources } from './masks.ts';
import { FS_MASK_BLUR, FS_MASK_MORPH, FS_MASK_RENDER } from './shaders.ts';

/** Texels on the longer image side of a refined map (as brush and AI maps). */
export const REFINE_RES = 2048;

/** Atlas place of each map, by id: [u0, v0, su, sv] (uv = s * su,sv + u0,v0). */
export type RefinedCells = Map<string, [number, number, number, number]>;

export interface RefinedAtlas {
  tex: WebGLTexture;
  cells: RefinedCells;
  /** Half a texel of the atlas, in uv. */
  half: [number, number];
}

export interface RefinedMaps {
  parts: RefinedAtlas | null;
  masks: RefinedAtlas | null;
}

/** Octagon of inradius r as a square (half side a) plus a diamond (two diagonals of half length c). */
const OCT_AXIS = Math.SQRT2 - 1;
const OCT_DIAG = (1 - OCT_AXIS) / 2;

export interface RefineStep {
  kind: 'blur' | 'morph';
  dir: [number, number];
  sigma?: number;
  sharpen?: number;
  radius?: number;
  mode?: 1 | -1;
}

/** What a map goes through after it is rendered, in map texels. */
export function refineSteps(edge: MaskEdge, texelsPerPx: number): RefineStep[] {
  const steps: RefineStep[] = [];
  if (edge.smooth > 0) {
    const sigma = Math.max(0.3, (edge.smooth / 2) * texelsPerPx);
    // A crisp edge blurred by sigma has a slope of about 0.4 / sigma at 50 %; bring it back
    // to about half a mask unit per texel (a two-texel, anti-aliased edge).
    const h = 0.6 / sigma;
    steps.push({ kind: 'blur', dir: [1, 0], sigma });
    steps.push({ kind: 'blur', dir: [0, 1], sigma, sharpen: h < 0.5 ? h : 0 });
  }
  if (edge.offset !== 0) {
    const r = Math.abs(edge.offset) * texelsPerPx;
    const mode = edge.offset > 0 ? 1 : -1;
    steps.push({ kind: 'morph', dir: [1, 0], radius: r * OCT_AXIS, mode });
    steps.push({ kind: 'morph', dir: [0, 1], radius: r * OCT_AXIS, mode });
    steps.push({ kind: 'morph', dir: [1, 1], radius: r * OCT_DIAG, mode });
    steps.push({ kind: 'morph', dir: [1, -1], radius: r * OCT_DIAG, mode });
  }
  if (edge.feather > 0) {
    // The 10-90 % width of a blurred edge is about 2.56 sigma.
    const sigma = Math.max(0.3, (edge.feather / 2.5) * texelsPerPx);
    steps.push({ kind: 'blur', dir: [1, 0], sigma });
    steps.push({ kind: 'blur', dir: [0, 1], sigma });
  }
  return steps;
}

/**
 * Cell layout of n maps of w0 x h0 in one atlas: the column count that needs the least
 * scaling to fit maxSize (the GPU's texture limit), then the fewest columns.
 */
export function refineLayout(n: number, w0: number, h0: number, maxSize: number): { cols: number; w: number; h: number; W: number; H: number } {
  let cols = 1;
  let best = Infinity;
  for (let c = 1; c <= Math.max(1, n); c++) {
    const k = Math.max(1, (w0 * c) / maxSize, (h0 * Math.ceil(n / c)) / maxSize);
    if (k < best - 1e-9) {
      best = k;
      cols = c;
    }
  }
  const rows = Math.ceil(n / cols);
  const w = Math.max(1, Math.floor(w0 / best));
  const h = Math.max(1, Math.floor(h0 / best));
  return { cols, w, h, W: w * cols, H: h * rows };
}

export interface RefineSource {
  /** Full-resolution image size (sensor orientation): Offset, Feather and Smooth are in its pixels. */
  fullWidth: number;
  fullHeight: number;
  maxTextureSize: number;
  /** Brush and AI maps and colour samples, for the parts. */
  res: MaskResources;
  /** Everything else the maps depend on (white balance, exposure, lens, brush and AI maps…). */
  key: string;
  /** Proxy (uSrc) and a texture of zeros for samplers that must not be read. */
  proxy: WebGLTexture;
  dummy: WebGLTexture;
  /** Develop and lens uniforms of the render pass. */
  uniforms: () => Record<string, UniformValue>;
}

interface Item {
  id: string;
  key: string;
  edge: MaskEdge;
  parts: () => Pick<Mask, 'components'>;
}

/** One atlas and what each of its cells was rendered from. */
class Atlas {
  target: Target | null = null;
  layout = '';
  done = new Map<string, string>();
}

export class MaskRefiner {
  private ctx: GLContext;
  private render: Program;
  private blur: Program;
  private morph: Program;
  private partAtlas = new Atlas();
  private maskAtlas = new Atlas();
  private a: Target | null = null;
  private b: Target | null = null;

  constructor(ctx: GLContext) {
    this.ctx = ctx;
    this.render = ctx.program(FS_MASK_RENDER);
    this.blur = ctx.program(FS_MASK_BLUR);
    this.morph = ctx.program(FS_MASK_MORPH);
  }

  /** The maps of the refined parts and masks; each is rendered again only when it changes. */
  update(masks: Mask[], src: RefineSource): RefinedMaps {
    const frame = maskFrameScale(src.fullWidth, src.fullHeight);
    let base: Record<string, UniformValue> | null = null;
    const uniforms = () => (base ??= src.uniforms());

    // Parts first. An AI part whose map isn't there yet is left out (as when it isn't refined).
    const partRes: MaskResources = { ...src.res, partCells: undefined, maskCells: undefined };
    const parts: Item[] = masks.flatMap((m) =>
      m.components
        .filter((c) => isPartRefined(c) && (c.kind !== 'ai' || !!src.res.aiCells?.has(c.id)))
        .map((c): Item => {
          // Alone, as a mask of its own (inverted if it is); its mode applies when combined.
          const alone: MaskComponent = { ...c, mode: 'add' };
          return { id: c.id, key: canonicalJson(alone), edge: c.edge!, parts: () => ({ components: [alone] }) };
        }),
    );
    const partMaps = this.pack(this.partAtlas, parts, src, frame, partRes, { uPartRefined: src.dummy }, uniforms);

    // Whole masks, from their parts (refined parts from their maps).
    const maskRes: MaskResources = { ...src.res, partCells: partMaps?.cells, partHalfTexel: partMaps?.half, maskCells: undefined };
    const whole: Item[] = masks
      .filter((m) => isMaskRefined(m) && m.components.length > 0)
      .map((m) => ({
        id: m.id,
        key: canonicalJson({ components: m.components, edge: m.edge, refined: m.components.map((c) => partMaps?.cells.has(c.id) ?? false) }),
        edge: m.edge,
        parts: () => m,
      }));
    const maskMaps = this.pack(this.maskAtlas, whole, src, frame, maskRes, { uPartRefined: partMaps?.tex ?? src.dummy }, uniforms);
    return { parts: partMaps, masks: maskMaps };
  }

  private pack(
    atlas: Atlas,
    items: Item[],
    src: RefineSource,
    frame: [number, number],
    res: MaskResources,
    textures: Record<string, WebGLTexture>,
    uniforms: () => Record<string, UniformValue>,
  ): RefinedAtlas | null {
    if (!items.length) return null;
    const gl = this.ctx.gl;
    const w0 = Math.max(1, Math.round(frame[0] * REFINE_RES));
    const h0 = Math.max(1, Math.round(frame[1] * REFINE_RES));
    const L = refineLayout(items.length, w0, h0, src.maxTextureSize);
    const before = atlas.target;
    atlas.target = this.ctx.ensureTarget(atlas.target, L.W, L.H, gl.R8, { filter: gl.LINEAR });
    const layout = `${L.cols}:${L.w}x${L.h}`;
    // A new texture or other cells: everything is drawn again.
    if (atlas.target !== before || layout !== atlas.layout) atlas.done.clear();
    atlas.layout = layout;
    const texelsPerPx = L.w / Math.max(1, src.fullWidth);
    const cells: RefinedCells = new Map();
    const done = new Map<string, string>();

    items.forEach((item, i) => {
      const ox = (i % L.cols) * L.w;
      const oy = Math.floor(i / L.cols) * L.h;
      cells.set(item.id, [ox / L.W, oy / L.H, L.w / L.W, L.h / L.H]);
      const key = `${i}|${src.key}|${item.key}`;
      done.set(item.id, key);
      if (atlas.done.get(item.id) === key) return;
      this.a = this.ctx.ensureTarget(this.a, L.w, L.h, gl.R16F, { filter: gl.LINEAR });
      this.b = this.ctx.ensureTarget(this.b, L.w, L.h, gl.R16F, { filter: gl.LINEAR });
      const { uses: _, ...packed } = maskPartsUniforms(item.parts(), frame, res);
      // The atlases being written are never read while they are.
      this.ctx.draw(this.render, this.a, { uSrc: src.proxy, uTrans: src.dummy, uMaskRefined: src.dummy, ...textures }, { ...uniforms(), ...packed, uOverlay: -1, uMaskPx: [L.w, L.h] });
      const steps = refineSteps(item.edge, texelsPerPx);
      let from = this.a;
      let to = this.b;
      steps.forEach((s, j) => {
        const last = j === steps.length - 1;
        const program: Program = s.kind === 'blur' ? this.blur : this.morph;
        const u: Record<string, UniformValue> = s.kind === 'blur' ? { uDir: new Int32Array(s.dir), uSigma: s.sigma!, uSharpen: s.sharpen ?? 0 } : { uDir: new Int32Array(s.dir), uRadius: s.radius!, uMode: s.mode! };
        this.ctx.draw(program, last ? atlas.target : to, { uTex: from.tex }, { ...u, uOrigin: last ? [ox, oy] : [0, 0] }, last ? [ox, oy, L.w, L.h] : undefined);
        [from, to] = [to, from];
      });
    });
    atlas.done = done;
    return { tex: atlas.target.tex, cells, half: [0.5 / L.W, 0.5 / L.H] };
  }

  /** Forgets what the maps hold (a new photo). */
  reset(): void {
    this.partAtlas.done.clear();
    this.maskAtlas.done.clear();
  }

  dispose(): void {
    for (const t of [this.partAtlas.target, this.maskAtlas.target, this.a, this.b]) this.ctx.deleteTarget(t);
    this.partAtlas = new Atlas();
    this.maskAtlas = new Atlas();
    this.a = this.b = null;
  }
}
