// WebGL2 renderer: fitted preview from a <= 2560 px proxy, 1:1 zoom regions and
// full-resolution tiled export. All three run the same pass chain (see shaders.ts),
// and share one cached analysis per recipe/frame, so they match.
import { canonicalJson, defaultRecipe, isMaskRefined, isPartRefined, type BrushComponent, type ProfileId, type Recipe } from '@immich-raw/recipe';
import { BrushRasterizer, packBrushAtlas, packMaskAtlas, type MaskMap } from './brush.ts';
import { cubeTexels, hueSatTexels, profileExposureEv, profileUniforms, profileWhitePoint, resolveProfile, toGlMat3, type ProfileLooks, type ProfileRender } from './color/index.ts';
import { buildCurveLut, isCurveNeutral, LUT_SIZE } from './curves.ts';
import { estimateDehaze } from './dehaze.ts';
import { Denoiser, effectsUniforms, nrPlan } from './effects.ts';
import { applyAffine, cropViewFrame, editFrame, invertAffine, type Affine, type FrameInfo } from './geometry.ts';
import { GLContext, type Program, type Target } from './gl.ts';
import { NO_LENS, defringeUniforms, lensModel, lensSourcePoint, lensUniforms, type LensData, type LensModel } from './lens.ts';
import { MaskRefiner } from './mask-refine.ts';
import { colorFeature, maskFrameScale, maskUniforms, type MaskResources } from './masks.ts';
import { histogramOf, type Histogram, type ScopeImage } from './scopes.ts';
import * as S from './shaders.ts';
import { developUniforms, finishUniforms, lookUniforms, STATIC_UNIFORMS, type CameraInfo } from './uniforms.ts';

export interface SourceImage {
  width: number;
  height: number;
  /** Interleaved RGB 16-bit, as decoded. */
  data: Uint16Array;
}

export type ViewMode = 'edit' | 'crop';

/**
 * An AI selection map (see setAiMasks): 8-bit coverage over the decoded image, in sensor
 * orientation and before lens corrections. `version` changes whenever the map does.
 */
export interface AiMaskMap extends MaskMap {
  data: Uint8Array;
  version: string;
}

/**
 * Lightroom's Alt-drag views: highlight clipping on black, shadow clipping on white, and the
 * sharpening sliders' grey views (Amount, Radius, Detail, Masking).
 */
export type MaskView = 'none' | 'highlights' | 'shadows' | 'sharpenAmount' | 'sharpenRadius' | 'sharpenDetail' | 'sharpenMask';

/** uShowMask in the finish pass for each sharpening view. */
const SHARPEN_VIEW: Partial<Record<MaskView, number>> = { sharpenMask: 1, sharpenAmount: 2, sharpenRadius: 3, sharpenDetail: 4 };

export interface RenderOptions {
  mode: ViewMode;
  /** Render with default settings (keeping the crop), for before/after. */
  before?: boolean;
  /** Lightroom's J: clipped highlights red, clipped shadows blue. */
  clipping?: boolean;
  maskView?: MaskView;
  /** Colour outside the image (linear 0..1). */
  background?: [number, number, number];
  /** false: render into the offscreen targets only (for the histogram while zoomed). */
  present?: boolean;
  /** Mask whose overlay is drawn in red (Lightroom's O). */
  maskOverlay?: string | null;
}

export interface ZoomView {
  /** Centre of the view in frame coordinates (0..1). */
  cx: number;
  cy: number;
  /** Screen pixels per full-resolution image pixel (1 = 100 %). */
  scale: number;
  /** Canvas size in device pixels. */
  width: number;
  height: number;
}

export interface ExportProgress {
  (done: number, total: number): void;
}

/** A rectangle of the full-resolution image, in pixels. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Analysis {
  key: string;
  abLow: Target;
  abMid: Target;
  /** Haze map and airlight: there when global or local Dehaze is in use. */
  dehaze: { uDehazeMode: number; uAir: number[] };
  trans: WebGLTexture | null;
}

interface ChainTargets {
  lin: Target;
  bl1: Target;
  bl2: Target;
  dev: Target;
  blurA: Target;
  blurB: Target;
  fin: Target;
}

type Programs = Record<
  'prepare' | 'linear' | 'analysis' | 'box' | 'coef' | 'blurL' | 'tone' | 'blur' | 'finish' | 'present' | 'thumb',
  Program
>;

const PROXY_MAX = 2560;
/** Most source pixels the zoomed view uploads at once (the view plus a margin for panning). */
const ZOOM_UPLOAD_MAX = 24e6;
const ANALYSIS_LOW = 512;
const ANALYSIS_MID = 1024;
const GUIDED_LOW_RADIUS = 0.025; // fraction of the analysis diagonal
const GUIDED_LOW_EPS = 0.25; // log2 units²: edges stronger than ~0.5 EV are kept
const GUIDED_MID_RADIUS = 0.006;
const GUIDED_MID_EPS = 0.08;
const TEXTURE_SIGMA = 0.0015; // fraction of the frame diagonal
const DEHAZE_RADIUS = 0.015;
const TILE = 2048;
/** Atlas cache key before anything was uploaded (no real key looks like this). */
const NO_KEY = '<none>';
// Must cover the widest filter: noise reduction reaches NR_REACH (126) full-resolution pixels.
const APRON = 128;

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  private ctx: GLContext;
  private gl: WebGL2RenderingContext;
  private p: Programs;
  private denoiser: Denoiser;
  /** Masks with a refined edge (Offset, Feather, Smooth), rendered into maps. */
  private refiner: MaskRefiner;
  private camera: CameraInfo | null = null;
  private proxy: Target | null = null;
  /** The decoded image the proxy was made from (colour range masks read their samples here). */
  private cpuSource: SourceImage | null = null;
  private brushRaster = new BrushRasterizer();
  private brushTex: WebGLTexture | null = null;
  /** What the brush atlas was built from; NO_KEY = nothing uploaded yet. */
  private brushKey = NO_KEY;
  private brushCells = new Map<string, [number, number, number, number]>();
  private brushHalf: [number, number] = [0, 0];
  /** AI selection maps by component id (computed outside the renderer). */
  private aiMaps = new Map<string, AiMaskMap>();
  private aiTex: WebGLTexture | null = null;
  private aiKey = NO_KEY;
  private aiCells = new Map<string, [number, number, number, number]>();
  private aiHalf: [number, number] = [0, 0];
  /** Proxy size in pixels (sensor orientation). */
  proxyWidth = 0;
  proxyHeight = 0;
  private t: Record<string, Target> = {};
  private analysisCache: Analysis | null = null;
  private lutTex: WebGLTexture | null = null;
  private lutKey = '';
  private dummy: WebGLTexture;
  private dummy3d: WebGLTexture;
  /** Downloaded profile data (Fujifilm film looks); see setProfileLooks. */
  private looks: ProfileLooks = {};
  /** Uploaded profile textures by profile (look table, tone curve, film LUT). */
  private profileTex = new Map<ProfileId, { look?: WebGLTexture; curve?: WebGLTexture; film?: WebGLTexture }>();
  /** The photo's own starting settings (e.g. its in-camera film look): what "before" shows. */
  private photoDefaults: Recipe | null = null;
  /** Zoom source cache: a region of a source image uploaded as RGBA16F. */
  private zoomSrc: { image: SourceImage; x: number; y: number; w: number; h: number; target: Target; int: WebGLTexture } | null = null;
  /** Maps a point of the last presented view (0..1) to frame t and back. */
  private lastView: {
    frame: FrameInfo;
    mode: ViewMode;
    toT: (x: number, y: number) => [number, number];
    fromT: (x: number, y: number) => [number, number];
  } | null = null;
  /** The finished image last drawn to the canvas (for colour sampling). */
  private lastFin: Target | null = null;
  private lost = false;
  /** What is known about the lens (profile, measured CA); see setLens. */
  private lens: LensData = NO_LENS;
  private lensVersion = 0;
  private lensCache: { key: string; model: LensModel } | null = null;
  onContextLost: (() => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      depth: false,
      stencil: false,
      alpha: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('This browser does not support WebGL2.');
    this.gl = gl;
    this.ctx = new GLContext(gl);
    const c = this.ctx;
    this.p = {
      prepare: c.program(S.FS_PREPARE),
      linear: c.program(S.FS_LINEAR),
      analysis: c.program(S.FS_ANALYSIS),
      box: c.program(S.FS_BOX),
      coef: c.program(S.FS_GUIDED_COEF),
      blurL: c.program(S.FS_BLUR_L),
      tone: c.program(S.FS_TONE),
      blur: c.program(S.FS_BLUR),
      finish: c.program(S.FS_FINISH),
      present: c.program(S.FS_PRESENT),
      thumb: c.program(S.FS_THUMB),
    };
    this.denoiser = new Denoiser(c);
    this.refiner = new MaskRefiner(c);
    this.dummy = c.texture(1, 1, gl.RGBA16F);
    this.dummy3d = c.texture3d(1, 1, 1, new Float32Array([0, 1, 1, 1]));
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.lost = true;
      this.onContextLost?.();
    });
  }

  get isLost(): boolean {
    return this.lost || this.gl.isContextLost();
  }

  get maxTextureSize(): number {
    return this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE) as number;
  }

  /** Uploads a decoded image (usually the half-size decode) and builds the preview proxy. */
  setSource(img: SourceImage, camera: CameraInfo): void {
    const gl = this.gl;
    this.camera = camera;
    this.cpuSource = img;
    this.brushKey = NO_KEY;
    this.aiMaps = new Map();
    this.aiKey = NO_KEY;
    this.refiner.reset();
    const scale = Math.max(1, Math.max(img.width, img.height) / PROXY_MAX);
    const pw = Math.max(1, Math.round(img.width / scale));
    const ph = Math.max(1, Math.round(img.height / scale));
    const src = this.uploadRgb16(img, 0, 0, img.width, img.height);
    this.ctx.deleteTarget(this.proxy);
    this.proxy = this.ctx.target(pw, ph, gl.RGBA16F, { mipmaps: true });
    this.ctx.draw(this.p.prepare, this.proxy, { uSrc: src }, { uScale: [img.width / pw, img.height / ph] });
    gl.bindTexture(gl.TEXTURE_2D, this.proxy.tex);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.deleteTexture(src);
    this.proxyWidth = pw;
    this.proxyHeight = ph;
    this.analysisCache = null;
  }

  private uploadRgb16(img: SourceImage, x: number, y: number, w: number, h: number, into?: WebGLTexture): WebGLTexture {
    const gl = this.gl;
    const tex = into ?? gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 2);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, img.width);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, x);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, y);
    if (into) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGB_INTEGER, gl.UNSIGNED_SHORT, img.data);
    } else {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB16UI, w, h, 0, gl.RGB_INTEGER, gl.UNSIGNED_SHORT, img.data);
    }
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    return tex;
  }

  /**
   * The AI selection maps of the loaded photo, by component id. AI components without a map
   * are left out of the render until it arrives.
   */
  setAiMasks(maps: Map<string, AiMaskMap>): void {
    this.aiMaps = new Map(maps);
  }

  /** Sets the lens profile / measured CA for the loaded photo. */
  setLens(data: LensData): void {
    this.lens = data;
    this.lensVersion++;
    this.lensCache = null;
    this.analysisCache = null;
  }

  /** Profile data that is downloaded rather than built in (the Fujifilm film looks). */
  setProfileLooks(looks: ProfileLooks): void {
    this.looks = looks;
    this.freeProfileTextures();
    this.analysisCache = null;
  }

  /** What renders for the recipe's profile (Color when a downloaded look is missing). */
  profileFor(recipe: Recipe): ProfileRender {
    return resolveProfile(recipe.profile, this.looks);
  }

  /** The recipe names a profile whose data isn't loaded, so Color renders instead. */
  profileMissing(recipe: Recipe): boolean {
    return this.profileFor(recipe).missing;
  }

  /** Scene value that renders as white with the recipe's profile and Amount (for Auto). */
  profileWhitePoint(recipe: Recipe): number {
    return profileWhitePoint(this.profileFor(recipe), recipe.profileAmount);
  }

  /** The photo's own starting settings, used as the base of the before view (null = defaults). */
  setPhotoDefaults(recipe: Recipe | null): void {
    this.photoDefaults = recipe;
  }

  private freeProfileTextures(): void {
    for (const t of this.profileTex.values()) for (const tex of Object.values(t)) if (tex) this.gl.deleteTexture(tex);
    this.profileTex.clear();
  }

  /** The profile's textures, uploaded once per profile. */
  private profileTextures(p: ProfileRender): { look?: WebGLTexture; curve?: WebGLTexture; film?: WebGLTexture } {
    if (!p.look) return {};
    let t = this.profileTex.get(p.id);
    if (t) return t;
    const gl = this.gl;
    const { lookTable, toneLut, filmLut } = p.look;
    t = {};
    if (lookTable) {
      // x = saturation, y = hue (wraps), z = value: the DNG storage order.
      t.look = this.ctx.texture3d(lookTable.satDivisions, lookTable.hueDivisions, lookTable.valDivisions, hueSatTexels(lookTable), { repeatY: true });
    }
    if (toneLut) {
      t.curve = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t.curve);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, toneLut.lut.length, 1, 0, gl.RED, gl.FLOAT, toneLut.lut);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    if (filmLut) t.film = this.ctx.texture3d(filmLut.size, filmLut.size, filmLut.size, cubeTexels(filmLut));
    this.profileTex.set(p.id, t);
    return t;
  }

  /** The lens corrections the recipe asks for (cached). */
  lensFor(recipe: Recipe): LensModel {
    const { camera } = this.requireSource();
    const key = `${this.lensVersion}:${canonicalJson(recipe.lens)}`;
    if (this.lensCache?.key !== key) this.lensCache = { key, model: lensModel(recipe, this.lens, camera.fullWidth, camera.fullHeight) };
    return this.lensCache.model;
  }

  private requireSource(): { camera: CameraInfo; proxy: Target } {
    if (!this.camera || !this.proxy) throw new Error('No image loaded');
    return { camera: this.camera, proxy: this.proxy };
  }

  frameFor(recipe: Recipe, mode: ViewMode, srcW = this.proxyWidth, srcH = this.proxyHeight): FrameInfo {
    const flip = this.camera?.flip ?? 0;
    return mode === 'crop' ? cropViewFrame(recipe.crop, flip, srcW, srcH, recipe.transform) : editFrame(recipe.crop, flip, srcW, srcH, recipe.transform);
  }

  private target(name: string, w: number, h: number, format: number, filter: number = this.gl.NEAREST): Target {
    const t = this.ctx.ensureTarget(this.t[name] ?? null, w, h, format, { filter });
    this.t[name] = t;
    return t;
  }

  private chainTargets(prefix: string, w: number, h: number): ChainTargets {
    const gl = this.gl;
    return {
      lin: this.target(`${prefix}.lin`, w, h, gl.RGBA16F),
      bl1: this.target(`${prefix}.bl1`, w, h, gl.R16F),
      bl2: this.target(`${prefix}.bl2`, w, h, gl.R16F),
      dev: this.target(`${prefix}.dev`, w, h, gl.RGBA16F),
      blurA: this.target(`${prefix}.blurA`, w, h, gl.RGBA16F),
      blurB: this.target(`${prefix}.blurB`, w, h, gl.RGBA16F),
      fin: this.target(`${prefix}.fin`, w, h, gl.RGBA8, gl.LINEAR),
    };
  }

  private freeChain(prefix: string): void {
    for (const k of Object.keys(this.t)) {
      if (k.startsWith(`${prefix}.`)) {
        this.ctx.deleteTarget(this.t[k]);
        delete this.t[k];
      }
    }
  }

  private baseUniforms(recipe: Recipe, camera: CameraInfo, frame: FrameInfo, an: Analysis['dehaze'] | null) {
    const u = developUniforms(recipe, camera, this.profileFor(recipe));
    return {
      ...u,
      uCamToWork: toGlMat3(u.uCamToWork),
      uWorkToLms: toGlMat3(STATIC_UNIFORMS.uWorkToLms),
      uLmsToWork: toGlMat3(STATIC_UNIFORMS.uLmsToWork),
      uWorkToSrgb: toGlMat3(STATIC_UNIFORMS.uWorkToSrgb),
      uSrgbToLms: toGlMat3(STATIC_UNIFORMS.uSrgbToLms),
      uLmsToSrgb: toGlMat3(STATIC_UNIFORMS.uLmsToSrgb),
      uGeom: affineToGl(frame.tToS),
      uSrcRect: [0, 0, 1, 1],
      uSrcTexScale: [1, 1],
      uTileOrigin: [0, 0],
      uClampT: 0,
      uDehazeMode: an?.uDehazeMode ?? 0,
      uAir: an?.uAir ?? [0, 0, 0],
      uDehaze: recipe.basic.dehaze / 100,
      // Programs keep uniform values between draws: passes without masks must say so.
      uMaskCount: 0,
      uCompCount: 0,
      uMaskDehaze: 0,
      uMaskSharp: 0,
      uOverlay: -1,
      uMaskFrame: maskFrameScale(camera.fullWidth, camera.fullHeight),
      uMaskLms: toGlMat3(STATIC_UNIFORMS.uWorkToLms),
      ...lensUniforms(this.lensFor(recipe)),
    };
  }

  /**
   * Source region (pixels of a source image of srcW x srcH) that output rectangle
   * [x0, x1] x [y0, y1] (frame t coordinates, clamped to 0..1) needs, every channel and
   * lens correction included. Lens mappings are radial and monotonic, so the border is enough.
   */
  private sourceRegion(recipe: Recipe, tToS: Affine, x0: number, y0: number, x1: number, y1: number, srcW: number, srcH: number) {
    const m = this.lensFor(recipe);
    const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const n = 12;
    for (let i = 0; i <= n; i++) {
      const f = i / n;
      for (const [tx, ty] of [
        [x0 + (x1 - x0) * f, y0],
        [x0 + (x1 - x0) * f, y1],
        [x0, y0 + (y1 - y0) * f],
        [x1, y0 + (y1 - y0) * f],
      ] as const) {
        const s = applyAffine(tToS, clamp01(tx), clamp01(ty));
        for (const ch of [0, 1, 2] as const) {
          const [sx, sy] = lensSourcePoint(m, s, ch);
          minX = Math.min(minX, sx * srcW);
          maxX = Math.max(maxX, sx * srcW);
          minY = Math.min(minY, sy * srcH);
          maxY = Math.max(maxY, sy * srcH);
        }
      }
    }
    return { minX, minY, maxX, maxY };
  }

  /**
   * Brush maps (rasterised, packed and shared with every pass as uBrush), the colours of
   * colour range samples (read from the decoded image with this recipe's white balance), and
   * the maps of masks with a refined edge (uMaskRefined).
   */
  private maskResources(recipe: Recipe, frame: FrameInfo): MaskResources {
    const res = this.partResources(recipe);
    if (!recipe.masks.some((m) => isMaskRefined(m) || m.components.some(isPartRefined))) {
      // The maps stay cached (Before/After, a refinement switched off for a moment).
      this.ctx.setShared('uPartRefined', this.dummy);
      this.ctx.setShared('uMaskRefined', this.dummy);
      return res;
    }
    const { camera, proxy } = this.requireSource();
    const base = this.baseUniforms(recipe, camera, frame, null);
    // What every refined map depends on besides its own part or mask: the brush and AI maps,
    // colour samples, and what the render pass reads of the photo.
    const key = canonicalJson({
      brush: this.brushKey,
      ai: this.aiKey,
      colors: [...res.colors],
      dev: [base.uWb, base.uClip, base.uCamToWork, base.uExposure].map((v) => (typeof v === 'number' ? v : Array.from(v))),
      lens: [this.lensVersion, recipe.lens],
    });
    const maps = this.refiner.update(recipe.masks, {
      fullWidth: camera.fullWidth,
      fullHeight: camera.fullHeight,
      maxTextureSize: this.maxTextureSize,
      res,
      key,
      proxy: proxy.tex,
      dummy: this.dummy,
      uniforms: () => base,
    });
    this.ctx.setShared('uPartRefined', maps.parts?.tex ?? this.dummy);
    this.ctx.setShared('uMaskRefined', maps.masks?.tex ?? this.dummy);
    return {
      ...res,
      partCells: maps.parts?.cells,
      partHalfTexel: maps.parts?.half,
      maskCells: maps.masks?.cells,
      maskHalfTexel: maps.masks?.half,
    };
  }

  /** Brush and AI maps and colour samples: what the masks' parts need. */
  private partResources(recipe: Recipe): MaskResources {
    const { camera } = this.requireSource();
    const [fx, fy] = maskFrameScale(camera.fullWidth, camera.fullHeight);
    const brushes = recipe.masks.flatMap((m) => m.components.filter((c): c is BrushComponent => c.kind === 'brush' && c.strokes.length > 0));
    const key = brushes
      .map((c) => `${c.id}:${c.strokes.map((st) => `${st.erase ? 'e' : 'p'}${st.size},${st.feather},${st.flow},${st.density},${st.points.length},${st.points[0]},${st.points.at(-1)}`).join(';')}`)
      .join('|');
    if (key !== this.brushKey) {
      this.brushKey = key;
      this.brushRaster.retain(new Set(brushes.map((c) => c.id)));
      const atlas = packBrushAtlas(brushes.map((c) => ({ id: c.id, map: this.brushRaster.rasterize(c, fx, fy) })), this.maxTextureSize);
      this.brushTex = this.uploadAtlas(this.brushTex, atlas);
      // No atlas: a texture of zeros, so nothing reads an unbound sampler.
      this.ctx.setShared('uBrush', atlas ? this.brushTex : this.dummy);
      this.brushCells = atlas?.cells ?? new Map();
      if (atlas) this.brushHalf = [0.5 / atlas.width, 0.5 / atlas.height];
    }

    const ai = recipe.masks.flatMap((m) => m.components.filter((c) => c.kind === 'ai' && this.aiMaps.has(c.id)).map((c) => c.id));
    const aiKey = ai.map((id) => `${id}:${this.aiMaps.get(id)!.version}`).join('|');
    if (aiKey !== this.aiKey) {
      this.aiKey = aiKey;
      const atlas = packMaskAtlas(ai.map((id) => ({ id, map: this.aiMaps.get(id)! })), this.maxTextureSize);
      this.aiTex = this.uploadAtlas(this.aiTex, atlas);
      this.ctx.setShared('uAiMask', atlas ? this.aiTex : this.dummy);
      this.aiCells = atlas?.cells ?? new Map();
      if (atlas) this.aiHalf = [0.5 / atlas.width, 0.5 / atlas.height];
    }

    const colors = new Map<string, [number, number][]>();
    const src = this.cpuSource;
    if (src) {
      const dev = developUniforms(recipe, camera, this.profileFor(recipe));
      const M = dev.uCamToWork;
      const lens = this.lensFor(recipe);
      const size = Math.max(src.width, src.height);
      for (const m of recipe.masks) {
        for (const c of m.components) {
          if (c.kind !== 'color' || !c.samples.length) continue;
          const feats: [number, number][] = [];
          for (const smp of c.samples) {
            const p = lensSourcePoint(lens, [smp.x / fx, smp.y / fy]);
            // A dragged sample averages a disc; capped so a big one stays cheap.
            const cam = sampleSource(src, p, Math.min(24, Math.max(1, Math.round(smp.r * size))));
            if (!cam) continue;
            const wb = cam.map((v, i) => v * dev.uWb[i]!);
            const lin = [0, 1, 2].map((r) => M[r * 3]! * wb[0]! + M[r * 3 + 1]! * wb[1]! + M[r * 3 + 2]! * wb[2]!);
            const f = colorFeature(lin);
            feats.push([f[0], f[1]]);
          }
          colors.set(c.id, feats);
        }
      }
    }
    return { brushCells: this.brushCells, brushHalfTexel: this.brushHalf, colors, aiCells: this.aiCells, aiHalfTexel: this.aiHalf };
  }

  /** Uploads an 8-bit atlas into `tex` (created when needed); null atlas: returns tex unchanged. */
  private uploadAtlas(tex: WebGLTexture | null, atlas: { width: number; height: number; data: Uint8Array } | null): WebGLTexture | null {
    if (!atlas) return tex;
    const gl = this.gl;
    tex ??= gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, atlas.width, atlas.height, 0, gl.RED, gl.UNSIGNED_BYTE, atlas.data);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  /** Mask-frame point -> where it lies in the decoded image (normalised, green channel). */
  maskToSource(mx: number, my: number, recipe: Recipe): [number, number] {
    const f = this.maskFrame();
    return lensSourcePoint(this.lensFor(recipe), [mx / f[0], my / f[1]], 1);
  }

  /**
   * The whole photo rendered with `recipe` (meant for one without crop or lens corrections),
   * upright, at most `maxSide` pixels on the long edge, from the preview proxy. What AI masks
   * are computed from. tToS maps the image (0..1) to the decoded image (0..1).
   */
  renderSmall(recipe: Recipe, maxSide: number): { image: ImageData; tToS: Affine } {
    if (this.isLost) throw new Error('Graphics context lost');
    const gl = this.gl;
    const { camera, proxy } = this.requireSource();
    const frame = this.frameFor(recipe, 'edit');
    const k = Math.min(1, maxSide / Math.max(frame.width, frame.height));
    const w = Math.max(8, Math.round(frame.width * k));
    const h = Math.max(8, Math.round(frame.height * k));
    const an = this.analyze(recipe, frame);
    const full = this.frameFor(recipe, 'edit', camera.fullWidth, camera.fullHeight);
    const T = this.chainTargets('small', w, h);
    try {
      this.chain(recipe, frame, an, { tex: proxy.tex, rect: [0, 0, 1, 1], texScale: [1, 1] }, T, [0, 0], [w, h], w / Math.max(1, full.width), false);
      const px = new Uint8ClampedArray(w * h * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, T.fin.fb);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      for (let i = 3; i < px.length; i += 4) px[i] = 255;
      return { image: new ImageData(px, w, h), tToS: frame.tToS };
    } finally {
      this.freeChain('small');
    }
  }

  /** Normalised source coordinates -> mask frame (the longer side is 1). */
  maskFrame(): [number, number] {
    const { camera } = this.requireSource();
    return maskFrameScale(camera.fullWidth, camera.fullHeight);
  }

  // ------------------------------------------------------------------ analysis

  /** Guided-filter coefficients and dehaze maps for this recipe and frame, computed from the proxy. */
  private analyze(recipe: Recipe, frame: FrameInfo): Analysis {
    const gl = this.gl;
    const { camera, proxy } = this.requireSource();
    const needHaze = recipe.basic.dehaze !== 0 || maskUniforms(recipe, [1, 1]).uses.dehaze;
    const key = canonicalJson({
      wb: recipe.wb,
      exposure: recipe.basic.exposure,
      dehaze: recipe.basic.dehaze,
      haze: needHaze,
      // Only the profile's exposure reaches the analysis; its look and tone come later.
      profileEv: profileExposureEv(this.profileFor(recipe), recipe.profileAmount),
      // The primaries change the luminance the local-tone analysis sees.
      calibration: [recipe.calibration.redHue, recipe.calibration.redSaturation, recipe.calibration.greenHue, recipe.calibration.greenSaturation, recipe.calibration.blueHue, recipe.calibration.blueSaturation],
      frame: [frame.width, frame.height, ...frame.tToS.map((v) => Math.round(v * 1e6))],
      lens: [this.lensVersion, recipe.lens],
    });
    if (this.analysisCache?.key === key) return this.analysisCache;

    const size = (max: number) => {
      const s = Math.min(1, max / Math.max(frame.width, frame.height));
      return [Math.max(8, Math.round(frame.width * s)), Math.max(8, Math.round(frame.height * s))] as const;
    };
    const [lw, lh] = size(ANALYSIS_LOW);
    const [mw, mh] = size(ANALYSIS_MID);
    const base = this.baseUniforms(recipe, camera, frame, null);

    // Dehaze: airlight and haze density from the low-resolution image without dehaze. The
    // haze map is estimated at full strength; the shader scales it per pixel by the global
    // amount plus any masks.
    let dehaze: Analysis['dehaze'] = { uDehazeMode: 0, uAir: [0, 0, 0] };
    let trans: WebGLTexture | null = this.analysisCache?.trans ?? null;
    if (needHaze) {
      const dz = this.target('an.dz', lw, lh, gl.RGBA32F);
      this.ctx.draw(this.p.linear, dz, { uSrc: proxy.tex, uTrans: this.dummy }, { ...base, uFramePx: [lw, lh] });
      const px = new Float32Array(lw * lh * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, dz.fb);
      gl.readPixels(0, 0, lw, lh, gl.RGBA, gl.FLOAT, px);
      const radius = Math.max(2, Math.round(DEHAZE_RADIUS * Math.hypot(lw, lh)));
      const est = estimateDehaze(px, lw, lh, 1, radius);
      const haze = est.transmission.map((t) => 1 - t);
      if (!trans) trans = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, trans);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, lw, lh, 0, gl.RED, gl.FLOAT, haze);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      dehaze = { uDehazeMode: 1, uAir: est.airlight };
    }
    const withDehaze = { ...base, ...dehaze };
    const transTex = dehaze.uDehazeMode === 1 && trans ? trans : this.dummy;

    const level = (name: string, w: number, h: number, radiusFrac: number, eps: number): Target => {
      const an = this.target(`${name}.an`, w, h, gl.RGBA32F);
      const a = this.target(`${name}.boxA`, w, h, gl.RGBA32F);
      const b = this.target(`${name}.boxB`, w, h, gl.RGBA32F);
      const coef = this.target(`${name}.coef`, w, h, gl.RGBA32F);
      const ab = this.target(`${name}.ab`, w, h, gl.RGBA32F);
      this.ctx.draw(this.p.analysis, an, { uSrc: proxy.tex, uTrans: transTex }, { ...withDehaze, uFramePx: [w, h] });
      const radius = Math.max(1, Math.min(64, Math.round(radiusFrac * Math.hypot(w, h))));
      this.box(an, a, b, radius);
      this.ctx.draw(this.p.coef, coef, { uMeans: b.tex }, { uEps: eps });
      this.box(coef, a, ab, radius);
      return ab;
    };
    const abLow = level('low', lw, lh, GUIDED_LOW_RADIUS, GUIDED_LOW_EPS);
    const abMid = level('mid', mw, mh, GUIDED_MID_RADIUS, GUIDED_MID_EPS);
    this.analysisCache = { key, abLow, abMid, dehaze, trans };
    return this.analysisCache;
  }

  /**
   * log2 luminance of the cropped frame at low resolution, with the recipe's white balance
   * but Exposure 0 and no Dehaze: what the Auto tone button measures.
   */
  toneSamples(recipe: Recipe, size = 256): Float32Array {
    const gl = this.gl;
    const { camera, proxy } = this.requireSource();
    const r: Recipe = { ...recipe, basic: { ...recipe.basic, exposure: 0, dehaze: 0 }, masks: [] };
    const frame = this.frameFor(r, 'edit');
    const s = Math.min(1, size / Math.max(frame.width, frame.height));
    const w = Math.max(8, Math.round(frame.width * s));
    const h = Math.max(8, Math.round(frame.height * s));
    const t = this.target('an.stats', w, h, gl.RGBA32F);
    this.ctx.draw(this.p.linear, t, { uSrc: proxy.tex, uTrans: this.dummy }, { ...this.baseUniforms(r, camera, frame, null), uFramePx: [w, h] });
    const px = new Float32Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, px);
    const out = new Float32Array(w * h);
    for (let i = 0; i < out.length; i++) out[i] = px[i * 4 + 3]!;
    return out;
  }

  private box(src: Target, tmp: Target, dst: Target, radius: number): void {
    this.ctx.draw(this.p.box, tmp, { uTex: src.tex }, { uDir: new Int32Array([1, 0]), uRadius: radius });
    this.ctx.draw(this.p.box, dst, { uTex: tmp.tex }, { uDir: new Int32Array([0, 1]), uRadius: radius });
  }

  private curveLut(recipe: Recipe): WebGLTexture | null {
    if (isCurveNeutral(recipe.toneCurve)) return null;
    const key = canonicalJson(recipe.toneCurve);
    if (this.lutTex && key === this.lutKey) return this.lutTex;
    const gl = this.gl;
    if (!this.lutTex) this.lutTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, LUT_SIZE, 1, 0, gl.RGBA, gl.FLOAT, buildCurveLut(recipe.toneCurve));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.lutKey = key;
    return this.lutTex;
  }

  // ------------------------------------------------------------------ pass chain

  private chain(
    recipe: Recipe,
    frame: FrameInfo,
    an: Analysis,
    src: { tex: WebGLTexture; rect: [number, number, number, number]; texScale: [number, number] },
    T: ChainTargets,
    origin: [number, number],
    framePx: [number, number],
    scale: number,
    clampT: boolean,
    maskView: MaskView = 'none',
    overlay: string | null = null,
    /** Full-resolution crop frame in pixels, for vignetting and grain; null = no post-crop effects. */
    outPx: [number, number] | null = null,
  ): void {
    const { camera } = this.requireSource();
    const transTex = an.dehaze.uDehazeMode === 1 && an.trans ? an.trans : this.dummy;
    const mu = maskUniforms(recipe, maskFrameScale(camera.fullWidth, camera.fullHeight), overlay, this.maskResources(recipe, frame));
    const { uses, ...masks } = mu;
    const u = {
      ...this.baseUniforms(recipe, camera, frame, an.dehaze),
      ...masks,
      uSrcRect: src.rect,
      uSrcTexScale: src.texScale,
      uFramePx: framePx,
      uTileOrigin: origin,
      uClampT: clampT ? 1 : 0,
      // Edit view and export (outPx set): blank areas after a perspective change are white.
      uBlankWhite: outPx ? 1 : 0,
    };
    this.ctx.draw(this.p.linear, T.lin, { uSrc: src.tex, uTrans: transTex }, { ...u, uMaskDehaze: uses.dehaze && an.dehaze.uDehazeMode === 1 ? 1 : 0 });

    // Noise reduction on the linear image. blurA/blurB are free until the sharpening blur,
    // so they serve as its scratch targets and hold the result for the tone pass.
    const nr = nrPlan(recipe.detail, scale, recipe.basic.exposure, camera.iso);
    const lin = nr ? this.denoiser.run(nr, T.lin, T.blurA, T.blurB) : T.lin;

    const b = recipe.basic;
    const useBlurL = b.clarity !== 0 || b.texture !== 0 || uses.detail;
    if (useBlurL) {
      const sigma = TEXTURE_SIGMA * Math.hypot(framePx[0], framePx[1]);
      this.ctx.draw(this.p.blurL, T.bl1, { uTex: lin.tex }, { uDir: new Int32Array([1, 0]), uSigma: sigma, uChannel: 3 });
      this.ctx.draw(this.p.blurL, T.bl2, { uTex: T.bl1.tex }, { uDir: new Int32Array([0, 1]), uSigma: sigma, uChannel: 0 });
    }
    const lut = this.curveLut(recipe);
    const prof = this.profileFor(recipe);
    const pt = this.profileTextures(prof);
    this.ctx.draw(
      this.p.tone,
      T.dev,
      {
        uLin: lin.tex,
        uBlurL: useBlurL ? T.bl2.tex : this.dummy,
        uABLow: an.abLow.tex,
        uABMid: an.abMid.tex,
        uLut: lut ?? this.dummy,
        // Always bound: an unbound sampler3D would share unit 0 with a 2D texture.
        uLookTable: pt.look ?? this.dummy3d,
        uProfileCurveTex: pt.curve ?? this.dummy,
        uFilmLutTex: pt.film ?? this.dummy3d,
      },
      {
        ...u,
        ...lookUniforms(recipe),
        ...defringeUniforms(recipe),
        ...profileUniforms(prof, recipe.profileAmount),
        uUseBlurL: useBlurL ? 1 : 0,
        uCurve: lut ? 1 : 0,
        uDetailBands: [b.clarity / 100, b.texture / 100],
        uOverlayColor: [0.95, 0.15, 0.2],
      },
    );

    const fu = finishUniforms(recipe, scale);
    const sharpenView = SHARPEN_VIEW[maskView] ?? 0;
    const showMask = sharpenView > 0;
    // Local sharpness needs the blurred image too (same radius as global sharpening).
    const maskSharp = uses.sharpness && fu.blurSigma[0] > 0.25;
    const needBlur = fu.uSharpen[3]! > 0 || showMask || maskSharp;
    if (needBlur) {
      this.ctx.draw(this.p.blur, T.blurA, { uTex: T.dev.tex }, { uDir: new Int32Array([1, 0]), uSigma: fu.blurSigma, uConvert: 1 });
      this.ctx.draw(this.p.blur, T.blurB, { uTex: T.blurA.tex }, { uDir: new Int32Array([0, 1]), uSigma: fu.blurSigma, uConvert: 0 });
    }
    this.ctx.draw(this.p.finish, T.fin, { uDev: T.dev.tex, uBlur: needBlur ? T.blurB.tex : T.dev.tex }, {
      ...u,
      uSharpen: needBlur ? [fu.uSharpen[0]!, fu.uSharpen[1]!, fu.uSharpen[2]!, fu.uSharpen[3]!] : [0, 0, 0, 0],
      uShowMask: sharpenView,
      uMaskSharp: maskSharp ? 1 : 0,
      ...effectsUniforms(recipe.effects, outPx),
    });
  }

  private present(fin: Target, opts: RenderOptions): void {
    this.lastFin = fin;
    const maskView = opts.maskView === 'highlights' ? 1 : opts.maskView === 'shadows' ? 2 : 0;
    if (this.canvas.width !== fin.width || this.canvas.height !== fin.height) {
      this.canvas.width = fin.width;
      this.canvas.height = fin.height;
    }
    this.ctx.draw(this.p.present, null, { uImg: fin.tex }, {
      uSize: [fin.width, fin.height],
      uClipping: opts.clipping ? 1 : 0,
      uMaskView: maskView,
      uBackground: opts.background ?? [0.11, 0.11, 0.12],
    });
  }

  // ------------------------------------------------------------------ public rendering

  /** Renders the fitted preview (canvas size = frame size in proxy pixels). */
  render(recipe: Recipe, opts: RenderOptions): FrameInfo {
    if (this.isLost) throw new Error('Graphics context lost');
    const { camera, proxy } = this.requireSource();
    const r = opts.before ? beforeRecipe(recipe, this.photoDefaults ?? undefined) : recipe;
    const frame = this.frameFor(r, opts.mode);
    const an = this.analyze(r, frame);
    const T = this.chainTargets('fit', frame.width, frame.height);
    const scale = this.proxyWidth / Math.max(1, camera.fullWidth);
    // Vignetting and grain belong to the crop: the crop tool shows the photo without them.
    const full = opts.mode === 'edit' ? this.frameFor(r, 'edit', camera.fullWidth, camera.fullHeight) : null;
    const outPx: [number, number] | null = full ? [full.width, full.height] : null;
    this.chain(r, frame, an, { tex: proxy.tex, rect: [0, 0, 1, 1], texScale: [1, 1] }, T, [0, 0], [frame.width, frame.height], scale, false, opts.maskView, opts.before ? null : opts.maskOverlay, outPx);
    if (opts.present !== false) {
      this.present(T.fin, opts);
      this.lastView = { frame, mode: opts.mode, toT: (x, y) => [x, y], fromT: (x, y) => [x, y] };
    }
    return frame;
  }

  /**
   * Renders a zoomed region (edit mode) from `source` — the full decode if available,
   * else the half decode (upsampled). Zoomed out so far that the preview has a pixel for every
   * screen pixel, it uses the preview instead. Canvas size = view size.
   */
  renderZoom(recipe: Recipe, source: SourceImage, view: ZoomView, opts: Omit<RenderOptions, 'mode'>): FrameInfo {
    if (this.isLost) throw new Error('Graphics context lost');
    const { camera, proxy } = this.requireSource();
    const r = opts.before ? beforeRecipe(recipe, this.photoDefaults ?? undefined) : recipe;
    const an = this.analyze(r, this.frameFor(r, 'edit'));
    // Frame in screen pixels at this zoom: the full-resolution frame scaled by view.scale.
    const fullFrame = this.frameFor(r, 'edit', camera.fullWidth, camera.fullHeight);
    // Whole pixels, and the view never reaches past the photo's edge: a last row or column that
    // hangs a fraction of a pixel over it renders darker.
    const fw = Math.max(1, Math.round(fullFrame.width * view.scale));
    const fh = Math.max(1, Math.round(fullFrame.height * view.scale));
    const place = (c: number, f: number, v: number) => {
      const o = Math.round(c * f - v / 2);
      return f >= v ? Math.min(Math.max(o, 0), f - v) : o;
    };
    const ox = place(view.cx, fw, view.width);
    const oy = place(view.cy, fh, view.height);
    const fromProxy = view.scale <= this.proxyWidth / Math.max(1, camera.fullWidth) + 1e-9;
    const src = fromProxy ? { tex: proxy.tex, rect: [0, 0, 1, 1] as [number, number, number, number], texScale: [1, 1] as [number, number] } : this.zoomSource(r, fullFrame, source, ox, oy, fw, fh, view);
    const T = this.chainTargets('zoom', view.width, view.height);
    this.chain(r, fullFrame, an, src, T, [ox, oy], [fw, fh], view.scale, false, opts.maskView, opts.before ? null : opts.maskOverlay, [fullFrame.width, fullFrame.height]);
    this.present(T.fin, { ...opts, mode: 'edit' });
    this.lastView = {
      frame: fullFrame,
      mode: 'edit',
      toT: (x, y) => [(ox + x * view.width) / fw, (oy + y * view.height) / fh],
      fromT: (x, y) => [(x * fw - ox) / view.width, (y * fh - oy) / view.height],
    };
    return fullFrame;
  }

  /** The part of `source` a zoomed view needs, on the GPU (kept while panning stays inside it). */
  private zoomSource(
    r: Recipe,
    fullFrame: FrameInfo,
    source: SourceImage,
    ox: number,
    oy: number,
    fw: number,
    fh: number,
    view: ZoomView,
  ): { tex: WebGLTexture; rect: [number, number, number, number]; texScale: [number, number] } {
    const gl = this.gl;
    // Source region this view needs, in source-image pixels.
    const { minX, minY, maxX, maxY } = this.sourceRegion(r, fullFrame.tToS, (ox - 8) / fw, (oy - 8) / fh, (ox + view.width + 8) / fw, (oy + view.height + 8) / fh, source.width, source.height);
    const need = {
      x: Math.max(0, Math.floor(minX) - 2),
      y: Math.max(0, Math.floor(minY) - 2),
      x1: Math.min(source.width, Math.ceil(maxX) + 2),
      y1: Math.min(source.height, Math.ceil(maxY) + 2),
    };
    const z = this.zoomSrc;
    const covered = z && z.image === source && need.x >= z.x && need.y >= z.y && need.x1 <= z.x + z.w && need.y1 <= z.y + z.h;
    if (!covered) {
      // Upload a margin around the view so panning re-uses it: half the view on each side, less
      // when zoomed out (the view alone already covers a large area).
      const nw = need.x1 - need.x;
      const nh = need.y1 - need.y;
      const m = Math.min(0.5, Math.max(0, (Math.sqrt(ZOOM_UPLOAD_MAX / Math.max(1, nw * nh)) - 1) / 2));
      const mx = Math.round(nw * m);
      const my = Math.round(nh * m);
      const x = Math.max(0, need.x - mx);
      const y = Math.max(0, need.y - my);
      const w = Math.max(1, Math.min(source.width, need.x1 + mx) - x);
      const h = Math.max(1, Math.min(source.height, need.y1 + my) - y);
      if (z) {
        gl.deleteTexture(z.int);
        this.ctx.deleteTarget(z.target);
      }
      const max = this.maxTextureSize;
      const cw = Math.min(w, max);
      const ch = Math.min(h, max);
      const int = this.uploadRgb16(source, x, y, cw, ch);
      const target = this.ctx.target(cw, ch, gl.RGBA16F);
      this.ctx.draw(this.p.prepare, target, { uSrc: int }, { uScale: [1, 1] });
      this.zoomSrc = { image: source, x, y, w: cw, h: ch, target, int };
    }
    const zs = this.zoomSrc!;
    return { tex: zs.target.tex, rect: [zs.x / source.width, zs.y / source.height, zs.w / source.width, zs.h / source.height], texScale: [1, 1] };
  }

  /** Frees the zoom targets and source region (when returning to the fitted view). */
  releaseZoom(): void {
    if (this.lastFin === this.t['zoom.fin']) this.lastFin = null;
    this.freeChain('zoom');
    if (this.zoomSrc) {
      this.gl.deleteTexture(this.zoomSrc.int);
      this.ctx.deleteTarget(this.zoomSrc.target);
      this.zoomSrc = null;
    }
  }

  /** Histogram of the last fitted render (display values, inside the image only). */
  histogram(): Histogram | null {
    const img = this.scopeImage(256);
    return img && histogramOf(img);
  }

  /**
   * A small copy of the last fitted render for the scopes: `width` pixels wide, display values,
   * alpha below 128 outside the image.
   */
  scopeImage(width: number): ScopeImage | null {
    const gl = this.gl;
    const fin = this.t['fit.fin'];
    if (!fin) return null;
    const tw = Math.max(1, Math.round(width));
    const th = Math.max(1, Math.round((tw * fin.height) / fin.width));
    const thumb = this.target('thumb', tw, th, gl.RGBA8);
    this.ctx.draw(this.p.thumb, thumb, { uImg: fin.tex }, { uSize: [tw, th] });
    // The chain's targets hold the top of the image in row 0 (FS_PRESENT flips), so no flip here.
    const data = new Uint8Array(tw * th * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, thumb.fb);
    gl.readPixels(0, 0, tw, th, gl.RGBA, gl.UNSIGNED_BYTE, data);
    return { width: tw, height: th, data };
  }

  /**
   * Average display colour (sRGB-encoded 0..1) around a point of the last presented view
   * (0..1), ignoring the area outside the image. Used by the targeted adjustment tool.
   */
  sampleDisplay(x: number, y: number, radius = 2): [number, number, number] | null {
    const fin = this.lastFin;
    if (!fin || this.isLost) return null;
    const gl = this.gl;
    const cx = Math.floor(x * fin.width);
    const cy = Math.floor(y * fin.height);
    const x0 = Math.max(0, cx - radius);
    const y0 = Math.max(0, cy - radius);
    const x1 = Math.min(fin.width, cx + radius + 1);
    const y1 = Math.min(fin.height, cy + radius + 1);
    if (x1 <= x0 || y1 <= y0) return null;
    const px = new Uint8Array((x1 - x0) * (y1 - y0) * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fin.fb);
    gl.readPixels(x0, y0, x1 - x0, y1 - y0, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const acc = [0, 0, 0];
    let n = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3]! < 128) continue;
      acc[0]! += px[i]!;
      acc[1]! += px[i + 1]!;
      acc[2]! += px[i + 2]!;
      n++;
    }
    return n ? [acc[0]! / n / 255, acc[1]! / n / 255, acc[2]! / n / 255] : null;
  }

  /** Maps a point in the last presented view (0..1) to the ideal (lens-corrected) source point. */
  previewToIdeal(x: number, y: number): [number, number] | null {
    const v = this.lastView;
    if (!v) return null;
    const [tx, ty] = v.toT(x, y);
    return applyAffine(v.frame.tToS, tx, ty);
  }

  /** Maps a point in the last presented view (0..1) to where it is in the decoded image (green). */
  previewToSource(x: number, y: number, recipe?: Recipe): [number, number] | null {
    const s = this.previewToIdeal(x, y);
    return s && recipe ? lensSourcePoint(this.lensFor(recipe), s, 1) : s;
  }

  /** Point of the last presented view (0..1) -> mask frame. */
  viewToMask(x: number, y: number): [number, number] | null {
    const s = this.previewToIdeal(x, y);
    if (!s) return null;
    const f = this.maskFrame();
    return [s[0] * f[0], s[1] * f[1]];
  }

  /** Mask frame -> point of the last presented view (0..1, may lie outside). */
  maskToView(mx: number, my: number): [number, number] | null {
    const v = this.lastView;
    if (!v || !this.camera) return null;
    const f = this.maskFrame();
    const [tx, ty] = applyAffine(invertAffine(v.frame.tToS), mx / f[0], my / f[1]);
    return v.fromT(tx, ty);
  }

  /** Maps a point in the last presented view (0..1) to frame coordinates (0..1). */
  previewToFrame(x: number, y: number): [number, number] | null {
    return this.lastView ? this.lastView.toT(x, y) : null;
  }

  /** Frame coordinates (0..1) -> point of the last presented view (0..1, may lie outside). */
  frameToPreview(x: number, y: number): [number, number] | null {
    return this.lastView ? this.lastView.fromT(x, y) : null;
  }

  /**
   * Renders the full-resolution image in tiles and returns RGBA8 pixels.
   * `full` must be the full decode; `recipe` is rendered in edit mode (cropped).
   */
  async exportImage(recipe: Recipe, full: SourceImage, onProgress?: ExportProgress): Promise<ImageData> {
    const { width: W, height: H } = this.exportSize(recipe);
    const out = new Uint8ClampedArray(W * H * 4);
    const rects: Rect[] = [];
    for (let y = 0; y < H; y += TILE) {
      for (let x = 0; x < W; x += TILE) rects.push({ x, y, w: Math.min(TILE, W - x), h: Math.min(TILE, H - y) });
    }
    await this.renderRects(recipe, full, rects, TILE, 'export', (r, buf) => {
      for (let row = 0; row < r.h; row++) out.set(buf.subarray(row * r.w * 4, (row + 1) * r.w * 4), ((r.y + row) * W + r.x) * 4);
    }, onProgress);
    for (let i = 3; i < out.length; i += 4) out[i] = 255;
    return new ImageData(out, W, H);
  }

  /** Size of the full-resolution image exportImage renders for `recipe`. */
  exportSize(recipe: Recipe): { width: number; height: number } {
    const { camera } = this.requireSource();
    const frame = this.frameFor(recipe, 'edit', camera.fullWidth, camera.fullHeight);
    return { width: frame.width, height: frame.height };
  }

  /**
   * One rectangle of what exportImage renders (pixels of its result, clipped to it, at most
   * TILE square): the same pixels, for a preview of a detail.
   */
  async exportRegion(recipe: Recipe, full: SourceImage, rect: Rect): Promise<ImageData> {
    const { width: W, height: H } = this.exportSize(recipe);
    const x = Math.max(0, Math.min(W - 1, Math.round(rect.x)));
    const y = Math.max(0, Math.min(H - 1, Math.round(rect.y)));
    const r = { x, y, w: Math.max(1, Math.min(TILE, W - x, Math.round(rect.w))), h: Math.max(1, Math.min(TILE, H - y, Math.round(rect.h))) };
    const out = new Uint8ClampedArray(r.w * r.h * 4);
    await this.renderRects(recipe, full, [r], Math.max(r.w, r.h), 'region', (_, buf) => out.set(buf.subarray(0, out.length)));
    for (let i = 3; i < out.length; i += 4) out[i] = 255;
    return new ImageData(out, r.w, r.h);
  }

  /**
   * Renders rectangles (at most tile x tile) of the full-resolution frame from the full decode and
   * hands each one's RGBA rows (r.w wide, packed) to `sink`.
   */
  private async renderRects(
    recipe: Recipe,
    full: SourceImage,
    rects: Rect[],
    tile: number,
    prefix: 'export' | 'region',
    sink: (r: Rect, rgba: Uint8Array) => void,
    onProgress?: ExportProgress,
  ): Promise<void> {
    const gl = this.gl;
    const an = this.analyze(recipe, this.frameFor(recipe, 'edit'));
    // Same frame as the 1:1 view (the decode can be a pixel larger than the camera size),
    // so grain and every other pixel land on the same output positions.
    const { camera } = this.requireSource();
    const frame = this.frameFor(recipe, 'edit', camera.fullWidth, camera.fullHeight);
    const W = frame.width;
    const H = frame.height;
    const R = tile + 2 * APRON;

    // Plan tiles and the source region each one needs.
    const tiles: { x0: number; y0: number; w: number; h: number; sx: number; sy: number; sw: number; sh: number }[] = [];
    let maxSw = 1;
    let maxSh = 1;
    for (const { x: x0, y: y0, w, h } of rects) {
      const { minX, minY, maxX, maxY } = this.sourceRegion(recipe, frame.tToS, (x0 - APRON) / W, (y0 - APRON) / H, (x0 + R - APRON) / W, (y0 + R - APRON) / H, full.width, full.height);
      const sx = Math.max(0, Math.floor(minX) - 3);
      const sy = Math.max(0, Math.floor(minY) - 3);
      const sw = Math.max(1, Math.min(full.width, Math.ceil(maxX) + 3) - sx);
      const sh = Math.max(1, Math.min(full.height, Math.ceil(maxY) + 3) - sy);
      maxSw = Math.max(maxSw, sw);
      maxSh = Math.max(maxSh, sh);
      tiles.push({ x0, y0, w, h, sx, sy, sw, sh });
    }

    const maxTex = this.maxTextureSize;
    if (maxSw > maxTex || maxSh > maxTex) throw new Error('Image region too large for this GPU');
    // The zoom cache would compete for GPU memory (a small region doesn't need much).
    if (prefix === 'export') this.releaseZoom();
    const srcInt = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, srcInt);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGB16UI, maxSw, maxSh);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    const srcF = this.ctx.target(maxSw, maxSh, gl.RGBA16F);
    const T = this.chainTargets(prefix, R, R);
    const buf = new Uint8Array(tile * tile * 4);
    try {
      for (let i = 0; i < tiles.length; i++) {
        const tl = tiles[i]!;
        this.uploadRgb16(full, tl.sx, tl.sy, tl.sw, tl.sh, srcInt);
        this.ctx.draw(this.p.prepare, srcF, { uSrc: srcInt }, { uScale: [1, 1] }, [0, 0, tl.sw, tl.sh]);
        this.chain(
          recipe,
          frame,
          an,
          {
            tex: srcF.tex,
            rect: [tl.sx / full.width, tl.sy / full.height, tl.sw / full.width, tl.sh / full.height],
            texScale: [tl.sw / maxSw, tl.sh / maxSh],
          },
          T,
          [tl.x0 - APRON, tl.y0 - APRON],
          [W, H],
          1,
          true,
          'none',
          null,
          [W, H],
        );
        gl.bindFramebuffer(gl.FRAMEBUFFER, T.fin.fb);
        gl.readPixels(APRON, APRON, tl.w, tl.h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        sink({ x: tl.x0, y: tl.y0, w: tl.w, h: tl.h }, buf);
        onProgress?.(i + 1, tiles.length);
        await new Promise((res) => setTimeout(res, 0));
      }
    } finally {
      gl.deleteTexture(srcInt);
      this.ctx.deleteTarget(srcF);
      this.freeChain(prefix);
    }
  }

  dispose(): void {
    for (const t of Object.values(this.t)) this.ctx.deleteTarget(t);
    if (this.brushTex) this.gl.deleteTexture(this.brushTex);
    this.brushTex = null;
    this.ctx.setShared('uBrush', null);
    if (this.aiTex) this.gl.deleteTexture(this.aiTex);
    this.aiTex = null;
    this.aiMaps = new Map();
    this.aiKey = NO_KEY;
    this.brushKey = NO_KEY;
    this.ctx.setShared('uAiMask', null);
    this.refiner.dispose();
    this.ctx.setShared('uPartRefined', null);
    this.ctx.setShared('uMaskRefined', null);
    this.releaseZoom();
    this.ctx.deleteTarget(this.proxy);
    this.t = {};
    this.proxy = null;
    this.analysisCache = null;
    this.freeProfileTextures();
  }
}

/** Default settings (or the photo's own starting settings) with the current crop: what "before" shows. */
export function beforeRecipe(recipe: Recipe, base: Recipe = defaultRecipe()): Recipe {
  const r = structuredClone(base);
  r.crop = { ...recipe.crop };
  r.transform = { ...recipe.transform };
  return r;
}

function affineToGl(m: Affine | readonly number[]): Float32Array {
  // row-major 3x3 -> column-major for uniformMatrix3fv
  return new Float32Array([m[0]!, m[3]!, m[6]!, m[1]!, m[4]!, m[7]!, m[2]!, m[5]!, m[8]!]);
}

/** Average source colour (as decoded) around normalised point s, for the white-balance picker. */
export function sampleSource(img: SourceImage, s: [number, number], radius = 3): [number, number, number] | null {
  const cx = Math.round(s[0] * img.width);
  const cy = Math.round(s[1] * img.height);
  if (cx < 0 || cy < 0 || cx >= img.width || cy >= img.height) return null;
  const acc = [0, 0, 0];
  let n = 0;
  for (let y = Math.max(0, cy - radius); y <= Math.min(img.height - 1, cy + radius); y++) {
    for (let x = Math.max(0, cx - radius); x <= Math.min(img.width - 1, cx + radius); x++) {
      const i = (y * img.width + x) * 3;
      acc[0]! += img.data[i]!;
      acc[1]! += img.data[i + 1]!;
      acc[2]! += img.data[i + 2]!;
      n++;
    }
  }
  return [acc[0]! / n, acc[1]! / n, acc[2]! / n];
}
