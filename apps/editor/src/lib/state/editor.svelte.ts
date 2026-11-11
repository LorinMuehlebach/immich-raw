// Editor state and actions. Components read the $state fields and call the methods;
// every change to the recipe goes through here so history and re-rendering stay in sync.
import {
  AssetFileType,
  downloadAssetFile,
  getAssetInfo,
  getAssetMetadata,
  searchAssetFiles,
  updateAssetMetadata,
  type AssetResponseDto,
  type UserAdminResponseDto,
} from '@immich/sdk';
import { RawSession, setLibRawUrl, type LinearImage } from '@immich-raw/decoder';
import { isRawFilename } from '@immich-raw/inject/raw';
import {
  dngCorrection,
  estimateLateralCA,
  findCamera,
  lensDisplayName,
  lensfunCorrection,
  loadLensfun,
  parseDngOpcodes,
  searchLenses,
  type LensCorrection,
  type LensQuery,
  type LensfunDb,
  type LensfunJson,
} from '@immich-raw/lens';
import { isSafeReturnPath } from '@immich-raw/inject/routes';
import { crsToPatch, isLightroomSidecar, parseXmp } from '@immich-raw/xmp';
import {
  NO_LENS,
  Renderer,
  aspectRatioFor,
  AUTO_PARAM_SPECS,
  DEFAULT_AUTO_PARAMS,
  autoTone,
  bandWeights,
  brushRadius,
  normalizeAutoParams,
  cameraInfo,
  displayHue,
  cropToView,
  encodeJpeg,
  exifFromImmich,
  fitViewRect,
  insertExif,
  isTransformActive,
  profileWhitePoint,
  maxViewRect,
  quarterTurnsFromFlip,
  sampleSource,
  tempTintForNeutral,
  totalTurns,
  transformInverse,
  uprightSize,
  viewToCrop,
  withAspect,
  type Affine,
  type AutoParams,
  type CameraInfo,
  type Histogram,
  type LensData,
  type MaskView,
  type ViewRect,
} from '@immich-raw/pipeline';
import {
  APP_ID,
  BANDS,
  COMPONENT_LABELS,
  LOCAL_PARAMS,
  BRUSH_DENSITY,
  BRUSH_FEATHER,
  BRUSH_FLOW,
  BRUSH_SIZE,
  MAX_BRUSHES,
  MAX_BRUSH_POINTS,
  MAX_COLOR_SAMPLES,
  MAX_COMPONENTS,
  MAX_MASKS,
  brushCount,
  componentCount,
  newComponent,
  newMask,
  BAND_LABELS,
  BW_PARAMS,
  DEFAULT_GROUPS,
  GRADING_PARAMS,
  HISTORY_KEY,
  MIXER_PARAMS,
  PARAMS,
  WHEEL_LABELS,
  applyPatch,
  canonicalJson,
  clampParam,
  cloneRecipe,
  defaultRecipe,
  formatParam,
  getPath,
  normalizeRecipe,
  pickGroups,
  setPath,
  type AspectId,
  type CurveChannel,
  type CurvePoint,
  type ComponentKind,
  type GroupId,
  type LocalKey,
  type Mask,
  type MaskComponent,
  type MaskMode,
  type MixerChannel,
  type ParamSpec,
  type ProfileId,
  type Recipe,
  type SettingsPatch,
  type Wheel,
} from '@immich-raw/recipe';
import { apiUrl, authHeaders, getServerVersionInfo, getSession, initApi, serverVersionWarning, setApiKey } from '../immich/api.ts';
import { buildDng, LOSSY_QUALITY, type BuiltDng, type DngMode, type Verification } from '../dng/convert.ts';
import { downloadOriginal } from '../immich/download.ts';
import { cacheDng, convertBlocked, replaceWithDng, type DeleteMode, type ReplaceStep } from '../immich/replace.ts';
import { canEdit, loadRecipe, saveRender, type SaveStep } from '../immich/save.ts';
import { History, editable, editableJson, type HistoryStep } from './history.ts';

export type Status = 'loading' | 'auth' | 'error' | 'ready';
/**
 * 'tat': Lightroom's targeted adjustment tool (drag on the photo to change the Color Mixer).
 * 'mask': the Masking panel with its on-image handles.
 */
export type Tool = 'edit' | 'crop' | 'wb' | 'tat' | 'mask';

/** A gradient waiting to be drawn on the photo: a new mask, or a component of an existing one. */
export interface MaskDraft {
  kind: 'linear' | 'radial' | 'brush' | 'color';
  mode: MaskMode;
  /** Mask to add it to; null = create a new mask. */
  maskId: string | null;
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

const BRUSH_KEY = 'raw-editor.brush';
const BRUSH_SPECS = { size: BRUSH_SIZE, feather: BRUSH_FEATHER, flow: BRUSH_FLOW, density: BRUSH_DENSITY } as const;

function normalizeBrush(v: unknown): BrushSettings {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const num = (k: keyof typeof BRUSH_SPECS) => clampParam(BRUSH_SPECS[k], typeof o[k] === 'number' ? (o[k] as number) : BRUSH_SPECS[k].default);
  return { size: num('size'), feather: num('feather'), flow: num('flow'), density: num('density'), erase: false };
}

/** Stroke points are stored with 5 decimals. */
const q5 = (v: number) => Math.round(v * 1e5) / 1e5;

/** What the targeted adjustment tool changes. */
export type TatTarget = MixerChannel | 'bw';

export interface Snapshot {
  id: string;
  name: string;
  createdAt: string;
  /** Editable fields (profile, wb, basic, toneCurve, detail, crop) as JSON. */
  state: string;
}

export interface ZoomState {
  on: boolean;
  /** Centre in frame coordinates. */
  cx: number;
  cy: number;
  /** Device pixels per full-resolution pixel. */
  scale: number;
}

/** What the Lens Corrections panel shows. */
export interface LensInfo {
  searching: boolean;
  /** The profile in use, for display ("Lensfun: …", "Built into the DNG"), or null. */
  profile: string | null;
  /** The lens as the photo's EXIF names it. */
  lensName: string;
  /** Lensfun's automatic match, shown next to "Auto". */
  autoName: string;
  /** Lenses that fit the camera, for choosing by hand. */
  candidates: { id: string; name: string }[];
  /** Result of the chromatic aberration measurement. */
  caText: string;
}

/** The Convert to DNG dialog. */
export interface DngDialog {
  phase: 'options' | 'building' | 'ready' | 'replacing' | 'error';
  mode: DngMode;
  deleteMode: DeleteMode;
  /** Why converting isn't possible right now, or null. */
  blocked: string | null;
  label: string;
  fraction: number;
  originalSize: number;
  dngSize: number;
  /** Mode the built DNG was made with. */
  builtMode: DngMode | null;
  verification: Verification | null;
  error: string | null;
}

const REPLACE_LABEL: Record<ReplaceStep, string> = {
  upload: 'Uploading the DNG',
  copy: 'Copying albums, tags and details',
  stack: 'Updating the stack',
  delete: 'Deleting the original',
};

/** Lightroom settings found in the RAW's XMP sidecar, waiting for the user's OK. */
export interface SidecarOffer {
  patch: SettingsPatch;
  applied: number;
  unmapped: number;
  warnings: string[];
}

const STEP_LABEL: Record<SaveStep | 'decode' | 'render' | 'encode', string> = {
  decode: 'Decoding full resolution',
  render: 'Rendering',
  encode: 'Encoding JPEG',
  prepare: 'Preparing',
  upload: 'Uploading',
  metadata: 'Copying date, location and albums',
  stack: 'Stacking with the RAW',
  recipe: 'Saving edit settings',
  cleanup: 'Moving the previous version to trash',
};

const CHANNEL_LABEL: Record<MixerChannel, string> = { hue: 'Hue', saturation: 'Saturation', luminance: 'Luminance' };

/** History label for a slider change, e.g. "Exposure +0.50", "Saturation: Blue -30". */
function historyLabel(spec: ParamSpec, value: number): string {
  const v = formatParam(spec, value);
  const parts = spec.path.split('.');
  if (parts[0] === 'toneCurve') return `Tone Curve: ${spec.label} ${v}`;
  if (parts[0] === 'colorMixer') return `${CHANNEL_LABEL[parts[1] as MixerChannel]}: ${spec.label} ${v}`;
  if (parts[0] === 'bwMix') return `B&W: ${spec.label} ${v}`;
  if (parts[0] === 'transform') return `Transform: ${spec.label} ${v}`;
  if (parts[0] === 'effects') return `${parts[1]!.startsWith('grain') ? 'Grain' : 'Post-Crop Vignetting'}: ${spec.label} ${v}`;
  if (parts[0] === 'detail') {
    if (parts[1]!.startsWith('sharpen')) return `Sharpening: ${spec.label} ${v}`;
    const kind = parts[1]!.startsWith('nrColor') ? 'Color' : 'Luminance';
    return `Noise Reduction: ${spec.label === kind ? kind : `${kind} ${spec.label}`} ${v}`;
  }
  if (parts[0] === 'lens') return `Lens Corrections: ${parts[1]!.startsWith('profile') ? 'Profile ' : ''}${spec.label} ${v}`;
  if (parts[0] === 'colorGrading') return parts.length === 3 ? `Color Grading: ${WHEEL_LABELS[parts[1] as Wheel]} ${spec.label} ${v}` : `Color Grading: ${spec.label} ${v}`;
  if (parts[0] === 'calibration') {
    const primary = /^(red|green|blue)/.exec(parts[1]!)?.[1];
    return `Calibration: ${primary ? `${primary[0]!.toUpperCase()}${primary.slice(1)} Primary ` : 'Shadows '}${spec.label} ${v}`;
  }
  return `${spec.label} ${v}`;
}

const CLIPBOARD_KEY = 'raw-editor.clipboard';
const PREVIOUS_KEY = 'raw-editor.previous';
const AUTO_PARAMS_KEY = 'raw-editor.autoParams';

function storageGet<T>(key: string): T | null {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : null;
  } catch {
    return null;
  }
}

function storageSet(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // private mode or blocked storage: copy/paste just won't survive a reload
  }
}

/** Alt-drag preview for each slider, as in Lightroom. */
export const ALT_VIEW: Partial<Record<string, MaskView>> = {
  [PARAMS.exposure.path]: 'highlights',
  [PARAMS.highlights.path]: 'highlights',
  [PARAMS.whites.path]: 'highlights',
  [PARAMS.shadows.path]: 'shadows',
  [PARAMS.blacks.path]: 'shadows',
  [PARAMS.sharpenAmount.path]: 'sharpenAmount',
  [PARAMS.sharpenRadius.path]: 'sharpenRadius',
  [PARAMS.sharpenDetail.path]: 'sharpenDetail',
  [PARAMS.sharpenMasking.path]: 'sharpenMask',
};

export class Editor {
  status = $state<Status>('loading');
  loadingText = $state('Loading…');
  loadingProgress = $state<number | null>(null);
  error = $state<string | null>(null);
  warning = $state<string | null>(null);
  notice = $state<string | null>(null);

  asset = $state<AssetResponseDto | null>(null);
  me = $state<UserAdminResponseDto | null>(null);
  readOnly = $state(false);
  previewUrl = $state<string | null>(null);

  recipe = $state<Recipe>(defaultRecipe());
  private savedJson = $state<string>(editableJson(defaultRecipe()));
  tool = $state<Tool>('edit');
  before = $state(false);
  clipping = $state(false);
  maskView = $state<MaskView>('none');
  histogram = $state<Histogram | null>(null);
  fullStatus = $state<'idle' | 'decoding' | 'ready' | 'error'>('idle');
  saving = $state<{ label: string; fraction: number } | null>(null);
  canUndo = $state(false);
  canRedo = $state(false);
  historySteps = $state<HistoryStep[]>([]);
  historyIndex = $state(0);
  snapshots = $state<Snapshot[]>([]);
  hasClipboard = $state(false);
  hasPrevious = $state(false);
  sidecarOffer = $state<SidecarOffer | null>(null);
  /** Size of the last fitted frame, for laying out the canvas. */
  frame = $state<{ width: number; height: number }>({ width: 3, height: 2 });
  zoom = $state<ZoomState>({ on: false, cx: 0.5, cy: 0.5, scale: 1 });
  /** Stage size in CSS pixels and the device pixel ratio (set by the app layout). */
  viewport = { width: 800, height: 600, dpr: 1 };
  /** Crop tool: true until the user resizes the box by hand; then straightening only shrinks it. */
  cropAuto = $state(true);
  /** Which Color Mixer sliders the targeted adjustment tool drives. */
  tatTarget = $state<TatTarget>('saturation');
  /** How Auto behaves (the user's taste, kept in this browser). */
  autoParams = $state<AutoParams>(normalizeAutoParams(storageGet(AUTO_PARAMS_KEY)));
  /** Masking: the selected mask and component, the gradient about to be drawn, the red overlay. */
  maskSel = $state<{ mask: string | null; comp: string | null }>({ mask: null, comp: null });
  maskDraft = $state<MaskDraft | null>(null);
  maskOverlay = $state(true);
  brush = $state<BrushSettings>(normalizeBrush(storageGet(BRUSH_KEY)));
  /** Bumped after every render, so on-image handles follow zoom, pan and crop. */
  viewVersion = $state(0);
  lensInfo = $state<LensInfo>({ searching: false, profile: null, lensName: '', autoName: '', candidates: [], caText: '' });
  dngDialog = $state<DngDialog | null>(null);

  camera: CameraInfo | null = null;
  session: RawSession | null = null;
  fullImage: LinearImage | null = null;
  renderer: Renderer | null = null;
  private history = new History();
  private pendingLabel = 'Edit';
  private previewRecipe: Recipe | null = null;
  private renderQueued = false;
  private lastHistogram = 0;
  private histogramTimer: ReturnType<typeof setTimeout> | null = null;
  private tatDrag: { specs: ParamSpec[]; weights: number[]; start: number[] } | null = null;
  /** The recipe right after the last full Auto, so new Auto settings can re-apply it in place. */
  private autoApplied = $state<string | null>(null);
  private autoSamples: { key: string; samples: Float32Array } | null = null;
  /** History label for the gradient being drawn ("New Mask: Radial Gradient"). */
  private drawLabel: string | null = null;
  /** The brush stroke being painted. */
  private stroke: { maskId: string; compId: string; label: string } | null = null;
  // Lens corrections: the Lensfun database, the DNG's own correction, the measured CA.
  private lensDb: LensfunDb | null = null;
  private lensQuery: LensQuery | null = null;
  private dngLens: LensCorrection | null = null;
  private lensData: LensData = NO_LENS;
  /** lensId the current profile was looked up for (null = not yet). */
  private lensFor: string | null = null;
  private caFrom: 'half' | 'full' | null = null;
  /** The DNG built in the Convert to DNG dialog, waiting for the user's OK. */
  private dngBuilt: BuiltDng | null = null;
  returnPath: string | null = null;
  ctx: string | null = null;
  /** Renders this RAW had before (the page Immich returns to may show one of them). */
  private pastRenders = new Set<string>();
  /** The render made by a save in this session (Immich may still be making its preview). */
  private savedRenderId: string | null = null;

  dirty = $derived(editableJson(this.recipe) !== this.savedJson);

  // ---------------------------------------------------------------- loading

  async load(canvas: HTMLCanvasElement): Promise<void> {
    const params = new URLSearchParams(location.search);
    const assetId = params.get('asset');
    const ret = params.get('return');
    this.returnPath = ret && isSafeReturnPath(ret) ? ret : null;
    this.ctx = params.get('ctx');
    this.hasClipboard = !!storageGet(CLIPBOARD_KEY);
    this.hasPrevious = !!storageGet(PREVIOUS_KEY);
    setLibRawUrl(`${import.meta.env.BASE_URL}libraw/index.js`);
    initApi();

    try {
      if (!crossOriginIsolated) throw new Error('This page must be served with cross-origin isolation headers (COOP/COEP). Check the proxy setup.');
      this.me = await getSession();
      if (!this.me) {
        this.status = 'auth';
        return;
      }
      if (!assetId) throw new Error('No photo selected. Open a RAW in Immich and click "Edit RAW".');
      getServerVersionInfo()
        .then((v) => (this.warning = serverVersionWarning(v)))
        .catch(() => {});

      this.loadingText = 'Loading photo info…';
      const asset = await getAssetInfo({ id: assetId });
      if (!isRawFilename(asset.originalFileName)) throw new Error(`${asset.originalFileName} is not a RAW file.`);
      this.asset = asset;
      this.readOnly = !canEdit(asset, this.me);
      document.title = `${asset.originalFileName} · immich-raw`;
      this.showServerPreview(asset.id);

      const [stored, snapshots] = await Promise.all([loadRecipe(asset.id).catch(() => null), this.loadSnapshots(asset.id)]);
      this.snapshots = snapshots;
      if (stored) {
        this.recipe = stored;
        this.savedJson = editableJson(stored);
        if (stored.render?.assetId) this.pastRenders.add(stored.render.assetId);
      }

      this.loadingText = 'Downloading original…';
      const bytes = await downloadOriginal({ id: asset.id, checksum: asset.checksum }, (f) => (this.loadingProgress = f));
      this.loadingProgress = null;
      this.loadingText = 'Decoding RAW…';
      const session = await RawSession.open(bytes);
      this.session = session;
      this.camera = cameraInfo(session.meta);

      this.renderer = new Renderer(canvas);
      this.renderer.onContextLost = () => (this.error = 'The graphics context was lost. Reload the page to continue.');
      this.renderer.setSource(session.half, this.camera);
      this.history.reset($state.snapshot(this.recipe) as Recipe, stored ? 'Open (saved edit)' : 'Open');
      this.loadLens(bytes);
      this.syncHistory();
      this.status = 'ready';
      this.renderNow();
      // Full resolution is needed for saving and 1:1 zoom; start it in the background.
      this.startFullDecode();
      if (!stored) this.checkSidecar(asset.id);
    } catch (e) {
      this.fail(e);
    }
  }

  private showServerPreview(id: string): void {
    fetch(apiUrl(`/assets/${id}/thumbnail?size=preview`), { headers: authHeaders(), credentials: 'same-origin' })
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => {
        if (b && this.status !== 'ready') this.previewUrl = URL.createObjectURL(b);
      })
      .catch(() => {});
  }

  private startFullDecode(): void {
    if (!this.session || this.fullStatus === 'decoding' || this.fullStatus === 'ready') return;
    this.fullStatus = 'decoding';
    this.session
      .full()
      .then((img) => {
        this.fullImage = img;
        this.fullStatus = 'ready';
        // Fringes are a pixel or two wide: measure them again at full resolution.
        this.measureCA();
        if (this.zoom.on) this.requestRender();
      })
      .catch(() => (this.fullStatus = 'error'));
  }

  /** Offers the RAW's Lightroom settings (XMP sidecar), if Immich has one with crs: data. */
  private async checkSidecar(assetId: string): Promise<void> {
    try {
      const files = await searchAssetFiles({ assetId, $type: AssetFileType.Sidecar });
      const file = files[0];
      if (!file) return;
      const text = await (await downloadAssetFile({ id: file.id })).text();
      if (!isLightroomSidecar(text)) return;
      const crs = parseXmp(text);
      if (!crs) return;
      const result = crsToPatch(crs, this.cropContext() ?? undefined);
      if (!result.applied.length) return;
      this.sidecarOffer = {
        patch: result.patch,
        applied: result.applied.length,
        unmapped: result.unmapped.length,
        warnings: result.warnings,
      };
    } catch (e) {
      console.warn('Sidecar check failed', e);
    }
  }

  /** Image size after the camera orientation only (what Lightroom crop import/export expects). */
  cropContext(): { flip: number; uprightWidth: number; uprightHeight: number } | null {
    const r = this.renderer;
    if (!r || !this.camera) return null;
    const { w, h } = uprightSize(r.proxyWidth, r.proxyHeight, quarterTurnsFromFlip(this.camera.flip));
    return { flip: this.camera.flip, uprightWidth: w, uprightHeight: h };
  }

  /** Turns a Lightroom .xmp preset into a settings patch (for the Presets panel import). */
  parseXmpPreset(text: string, filename: string): { name: string; patch: SettingsPatch } | null {
    const crs = parseXmp(text);
    if (!crs) return null;
    const result = crsToPatch(crs, this.cropContext() ?? undefined);
    if (!result.applied.length) return null;
    return { name: crs.name ?? filename.replace(/\.xmp$/i, ''), patch: result.patch };
  }

  applySidecar(): void {
    const offer = this.sidecarOffer;
    this.sidecarOffer = null;
    if (offer) this.applyPatch(offer.patch, 'Lightroom settings');
  }

  dismissSidecar(): void {
    this.sidecarOffer = null;
  }

  useApiKey(key: string): void {
    setApiKey(key.trim() || null);
    location.reload();
  }

  private fail(e: unknown): void {
    console.error(e);
    this.error = e instanceof Error ? e.message : String(e);
    this.status = 'error';
  }

  // ---------------------------------------------------------------- rendering

  requestRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.renderNow();
    });
  }

  private currentRecipe(): Recipe {
    return this.previewRecipe ?? ($state.snapshot(this.recipe) as Recipe);
  }

  private renderNow(): void {
    const renderer = this.renderer;
    if (!renderer || this.status !== 'ready') return;
    try {
      this.syncLens();
      const recipe = this.currentRecipe();
      const overlay = this.tool === 'mask' && this.maskOverlay ? this.maskSel.mask : null;
      const opts = { before: this.before, clipping: this.clipping, maskView: this.maskView, maskOverlay: overlay };
      if (this.zoom.on && this.tool !== 'crop' && this.session) {
        const vp = this.viewport;
        renderer.renderZoom(recipe, this.fullImage ?? this.session.half, {
          cx: this.zoom.cx,
          cy: this.zoom.cy,
          scale: this.zoom.scale,
          width: Math.max(1, Math.round(vp.width * vp.dpr)),
          height: Math.max(1, Math.round(vp.height * vp.dpr)),
        }, opts);
      } else {
        const f = renderer.render(recipe, { mode: this.tool === 'crop' ? 'crop' : 'edit', ...opts });
        if (f.width !== this.frame.width || f.height !== this.frame.height) this.frame = { width: f.width, height: f.height };
      }
      this.viewVersion++;
      this.scheduleHistogram();
    } catch (e) {
      this.fail(e);
    }
  }

  private scheduleHistogram(): void {
    if (this.histogramTimer) return;
    const wait = Math.max(0, 120 - (performance.now() - this.lastHistogram));
    this.histogramTimer = setTimeout(() => {
      this.histogramTimer = null;
      this.lastHistogram = performance.now();
      const r = this.renderer;
      if (!r || this.status !== 'ready') return;
      // While zoomed the canvas shows a region; the histogram is of the whole image.
      if (this.zoom.on && this.tool !== 'crop') r.render(this.currentRecipe(), { mode: 'edit', before: this.before, present: false });
      else if (this.tool === 'mask' && this.maskOverlay && this.maskSel.mask) r.render(this.currentRecipe(), { mode: 'edit', before: this.before, present: false });
      this.histogram = r.histogram();
    }, wait);
  }

  // ---------------------------------------------------------------- editing

  private syncHistory(): void {
    const { steps, index } = this.history.list();
    this.historySteps = steps;
    this.historyIndex = index;
    this.canUndo = this.history.canUndo;
    this.canRedo = this.history.canRedo;
  }

  private changed(commit: boolean, label?: string): void {
    if (label) this.pendingLabel = label;
    if (commit) this.commit();
    this.requestRender();
  }

  /** Call when a gesture ends (slider released, key up, menu choice). */
  commit(): void {
    this.history.commit($state.snapshot(this.recipe) as Recipe, this.pendingLabel);
    this.syncHistory();
  }

  private applyEditable(state: ReturnType<typeof editable> | null): void {
    if (!state) return;
    Object.assign(this.recipe, structuredClone(state));
    this.syncHistory();
    this.requestRender();
  }

  value(spec: ParamSpec): number {
    if ((spec === PARAMS.temp || spec === PARAMS.tint) && this.recipe.wb.mode === 'asShot' && this.camera) {
      return spec === PARAMS.temp ? this.camera.asShot.temp : this.camera.asShot.tint;
    }
    return getPath(this.recipe, spec.path) as number;
  }

  setParam(spec: ParamSpec, value: number, commit = false): void {
    if (this.readOnlyGuard()) return;
    if ((spec === PARAMS.temp || spec === PARAMS.tint) && this.recipe.wb.mode === 'asShot') {
      this.recipe.wb.mode = 'custom';
      if (this.camera) {
        this.recipe.wb.temp = this.camera.asShot.temp;
        this.recipe.wb.tint = this.camera.asShot.tint;
      }
    }
    const v = clampParam(spec, value);
    setPath(this.recipe, spec.path, v);
    if (spec === PARAMS.angle) this.fitCropAfterRotate();
    else if (spec.path.startsWith('transform.') && this.recipe.transform.constrain) this.constrainCrop();
    this.changed(commit, historyLabel(spec, v));
  }

  /** The tone sliders Auto sets, in Lightroom's order. */
  static readonly AUTO_SPECS: ParamSpec[] = [PARAMS.exposure, PARAMS.contrast, PARAMS.highlights, PARAMS.shadows, PARAMS.whites, PARAMS.blacks];

  /**
   * Lightroom's Auto: measures the photo and sets Exposure, Contrast, Highlights, Shadows,
   * Whites and Blacks (one history step). With `only`, sets just that slider (Shift+double-click).
   * `amend` replaces the previous Auto step (used when the Auto settings change).
   */
  autoTone(only?: ParamSpec, amend = false): void {
    if (this.readOnlyGuard() || !this.renderer || this.status !== 'ready') return;
    const recipe = $state.snapshot(this.recipe) as Recipe;
    const auto = autoTone(this.toneSamples(recipe), {
      whitePoint: profileWhitePoint(recipe.profile),
      params: $state.snapshot(this.autoParams) as AutoParams,
    });
    const specs = only ? [only] : Editor.AUTO_SPECS;
    for (const spec of specs) {
      const key = spec.path.split('.')[1] as keyof typeof auto;
      if (key in auto) setPath(this.recipe, spec.path, clampParam(spec, auto[key]));
    }
    const label = only ? `Auto ${historyLabel(only, getPath(this.recipe, only.path) as number)}` : 'Auto Tone';
    const after = $state.snapshot(this.recipe) as Recipe;
    if (amend) {
      this.pendingLabel = label;
      this.history.amend(after, label);
      this.syncHistory();
      this.requestRender();
    } else {
      this.changed(true, label);
    }
    this.autoApplied = only ? null : editableJson(after);
  }

  /** What Auto measures. Cached: only white balance, crop, profile and calibration change it. */
  private toneSamples(recipe: Recipe): Float32Array {
    const key = canonicalJson({ ...editable(recipe), basic: undefined, toneCurve: undefined, detail: undefined });
    if (this.autoSamples?.key !== key) this.autoSamples = { key, samples: this.renderer!.toneSamples(recipe) };
    return this.autoSamples.samples;
  }

  /** Changes one Auto setting; re-applies Auto right away if it was the last thing done. */
  setAutoParam(key: keyof AutoParams, value: number): void {
    const spec = AUTO_PARAM_SPECS.find((s) => s.key === key);
    if (!spec) return;
    this.autoParams[key] = clampParam(spec, value);
    this.autoParamsChanged();
  }

  resetAutoParams(): void {
    Object.assign(this.autoParams, DEFAULT_AUTO_PARAMS);
    this.autoParamsChanged();
  }

  private autoParamsChanged(): void {
    storageSet(AUTO_PARAMS_KEY, $state.snapshot(this.autoParams));
    if (this.autoApplied && this.autoApplied === editableJson($state.snapshot(this.recipe) as Recipe)) this.autoTone(undefined, true);
  }

  /** True while the last step is a full Auto, so changing the Auto settings updates the photo. */
  get autoLive(): boolean {
    return !!this.autoApplied && this.autoApplied === editableJson(this.recipe);
  }

  /** Resets a set of sliders (a panel section) as one history step. */
  resetParams(specs: ParamSpec[], label: string): void {
    if (this.readOnlyGuard()) return;
    for (const s of specs) setPath(this.recipe, s.path, s.default);
    this.changed(true, label);
  }

  /** Color Grading wheel drag: hue and saturation change together. */
  setWheel(wheel: Wheel, hue: number, sat: number, commit = false): void {
    if (this.readOnlyGuard()) return;
    const w = this.recipe.colorGrading[wheel];
    w.hue = Math.round(clampParam(GRADING_PARAMS[wheel].hue, ((hue % 360) + 360) % 360)) % 360;
    w.sat = Math.round(clampParam(GRADING_PARAMS[wheel].sat, sat));
    this.changed(commit, `Color Grading: ${WHEEL_LABELS[wheel]} ${w.hue}° / ${w.sat}`);
  }

  // ---------------------------------------------------------------- targeted adjustment

  setTatTarget(target: TatTarget): void {
    this.tatTarget = target;
  }

  private tatSpecs(): ParamSpec[] {
    const t = this.recipe.profile === 'monochrome' ? 'bw' : this.tatTarget === 'bw' ? 'saturation' : this.tatTarget;
    const table = t === 'bw' ? BW_PARAMS : MIXER_PARAMS[t];
    return BANDS.map((b) => table[b]);
  }

  /**
   * Starts a targeted adjustment at a point of the view (0..1): the colour under the
   * pointer decides which bands move, and by how much (Lightroom's TAT).
   */
  beginTargeted(x: number, y: number): boolean {
    if (this.readOnlyGuard() || !this.renderer) return false;
    const rgb = this.renderer.sampleDisplay(x, y);
    if (!rgb) return false;
    const specs = this.tatSpecs();
    const weights = bandWeights(displayHue(rgb));
    this.tatDrag = { specs, weights, start: specs.map((s) => getPath(this.recipe, s.path) as number) };
    return true;
  }

  /** dy: CSS pixels moved since the start (up is negative = increase). */
  dragTargeted(dy: number): void {
    const d = this.tatDrag;
    if (!d) return;
    const amount = -dy * 0.5;
    const top = Math.max(...d.weights);
    let main = 0;
    d.specs.forEach((s, i) => {
      if (d.weights[i]! < 0.01) return;
      setPath(this.recipe, s.path, Math.round(clampParam(s, d.start[i]! + (amount * d.weights[i]!) / top)));
      if (d.weights[i]! > d.weights[main]!) main = i;
    });
    const s = d.specs[main]!;
    this.changed(false, `${historyLabel(s, getPath(this.recipe, s.path) as number)} (targeted)`);
  }

  endTargeted(): void {
    if (!this.tatDrag) return;
    this.tatDrag = null;
    this.commit();
  }

  /** Names of the bands the colour at (x, y) belongs to, for the tool's hint. */
  bandsAt(x: number, y: number): string | null {
    const rgb = this.renderer?.sampleDisplay(x, y);
    if (!rgb) return null;
    const w = bandWeights(displayHue(rgb));
    return BANDS.filter((_, i) => w[i]! >= 0.2).map((b) => BAND_LABELS[b]).join(' / ');
  }

  resetParam(spec: ParamSpec): void {
    if (spec === PARAMS.temp || spec === PARAMS.tint) return this.setWbMode('asShot');
    this.setParam(spec, spec.default, true);
  }

  setProfile(id: ProfileId): void {
    if (this.readOnlyGuard()) return;
    this.recipe.profile = id;
    this.changed(true, `Profile: ${id[0]!.toUpperCase()}${id.slice(1)}`);
  }

  setWbMode(mode: 'asShot' | 'custom'): void {
    if (this.readOnlyGuard()) return;
    if (mode === 'custom' && this.recipe.wb.mode === 'asShot' && this.camera) {
      this.recipe.wb.temp = this.camera.asShot.temp;
      this.recipe.wb.tint = this.camera.asShot.tint;
    }
    this.recipe.wb.mode = mode;
    this.changed(true, mode === 'asShot' ? 'White Balance: As Shot' : 'White Balance: Custom');
  }

  /** White-balance picker: make the clicked point (0..1 in the view) neutral. */
  pickWhiteBalance(x: number, y: number): void {
    const s = this.renderer?.previewToSource(x, y, $state.snapshot(this.recipe) as Recipe);
    const half = this.session?.half;
    if (!s || !half || !this.camera) return;
    const rgb = sampleSource(half, s, 2);
    if (!rgb) return;
    const tt = tempTintForNeutral(rgb, this.camera);
    this.recipe.wb.mode = 'custom';
    this.recipe.wb.temp = Math.round(clampParam(PARAMS.temp, tt.temp));
    this.recipe.wb.tint = Math.round(clampParam(PARAMS.tint, tt.tint));
    this.tool = 'edit';
    this.changed(true, `White Balance: ${this.recipe.wb.temp} K / ${formatParam(PARAMS.tint, this.recipe.wb.tint)}`);
  }

  setCurvePoints(channel: CurveChannel, points: CurvePoint[], commit = false): void {
    if (this.readOnlyGuard()) return;
    this.recipe.toneCurve.point[channel] = points.map((p) => [Math.round(p[0]), Math.round(p[1])] as CurvePoint);
    this.changed(commit, channel === 'master' ? 'Tone Curve' : `Tone Curve: ${channel[0]!.toUpperCase()}${channel.slice(1)}`);
  }

  resetToneCurve(): void {
    if (this.readOnlyGuard()) return;
    this.recipe.toneCurve = defaultRecipe().toneCurve;
    this.changed(true, 'Reset Tone Curve');
  }

  resetAll(): void {
    if (this.readOnlyGuard()) return;
    const fresh = defaultRecipe();
    Object.assign(this.recipe, editable(fresh));
    this.cropAuto = true;
    this.changed(true, 'Reset');
  }

  /** Applies a preset / pasted settings / Lightroom import as one history step. */
  applyPatch(patch: SettingsPatch, label: string): void {
    if (this.readOnlyGuard()) return;
    this.previewRecipe = null;
    // Patches often come from $state (presets list, sidecar offer): structuredClone can't
    // copy those proxies, so take a plain snapshot. normalizeRecipe clamps imported values.
    const plain = $state.snapshot(patch) as SettingsPatch;
    const next = normalizeRecipe(applyPatch($state.snapshot(this.recipe) as Recipe, plain));
    Object.assign(this.recipe, editable(next));
    this.changed(true, label);
  }

  /** Live preview of a patch (preset hover); null ends the preview. */
  previewPatch(patch: SettingsPatch | null): void {
    this.previewRecipe = patch ? normalizeRecipe(applyPatch($state.snapshot(this.recipe) as Recipe, $state.snapshot(patch) as SettingsPatch)) : null;
    this.requestRender();
  }

  undo(): void {
    this.applyEditable(this.history.undo($state.snapshot(this.recipe) as Recipe, this.pendingLabel));
  }

  redo(): void {
    this.applyEditable(this.history.redo());
  }

  jumpToHistory(index: number): void {
    this.history.commit($state.snapshot(this.recipe) as Recipe, this.pendingLabel);
    this.applyEditable(this.history.jump(index));
  }

  // ---------------------------------------------------------------- copy / paste / snapshots

  copySettings(groups: GroupId[]): void {
    storageSet(CLIPBOARD_KEY, pickGroups($state.snapshot(this.recipe) as Recipe, groups));
    this.hasClipboard = true;
    this.notice = 'Settings copied.';
  }

  pasteSettings(): void {
    const patch = storageGet<SettingsPatch>(CLIPBOARD_KEY);
    if (patch) this.applyPatch(patch, 'Paste Settings');
  }

  /** Lightroom's "Paste from previous": the settings of the last photo saved in this browser. */
  pastePrevious(): void {
    const patch = storageGet<SettingsPatch>(PREVIOUS_KEY);
    if (patch) this.applyPatch(patch, 'Paste from Previous');
  }

  private async loadSnapshots(assetId: string): Promise<Snapshot[]> {
    try {
      const items = await getAssetMetadata({ id: assetId });
      const v = items.find((i) => i.key === HISTORY_KEY)?.value as { snapshots?: Snapshot[] } | undefined;
      return Array.isArray(v?.snapshots) ? v.snapshots.filter((s) => s && typeof s.state === 'string') : [];
    } catch {
      return [];
    }
  }

  private async storeSnapshots(): Promise<void> {
    if (!this.asset || this.readOnly) return;
    try {
      await updateAssetMetadata({
        id: this.asset.id,
        assetMetadataUpsertDto: { items: [{ key: HISTORY_KEY, value: { schema: 1, snapshots: $state.snapshot(this.snapshots) } }] },
      });
    } catch (e) {
      this.notice = `Couldn't store snapshots: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  createSnapshot(name: string): void {
    if (this.readOnlyGuard()) return;
    this.snapshots = [
      { id: crypto.randomUUID(), name: name.trim() || new Date().toLocaleString(), createdAt: new Date().toISOString(), state: editableJson($state.snapshot(this.recipe) as Recipe) },
      ...this.snapshots,
    ];
    this.storeSnapshots();
  }

  applySnapshot(id: string): void {
    const s = this.snapshots.find((x) => x.id === id);
    if (!s || this.readOnlyGuard()) return;
    // Older snapshots lack newer settings; those come back as defaults.
    Object.assign(this.recipe, editable(normalizeRecipe(JSON.parse(s.state))));
    this.changed(true, `Snapshot: ${s.name}`);
  }

  renameSnapshot(id: string, name: string): void {
    this.snapshots = this.snapshots.map((s) => (s.id === id ? { ...s, name } : s));
    this.storeSnapshots();
  }

  deleteSnapshot(id: string): void {
    this.snapshots = this.snapshots.filter((s) => s.id !== id);
    this.storeSnapshots();
  }

  // ---------------------------------------------------------------- lens corrections

  /** Finds the lens profile (DNG opcodes, Lensfun) and measures CA; runs once after opening. */
  private async loadLens(bytes: Uint8Array): Promise<void> {
    const session = this.session;
    const cam = this.camera;
    if (!session || !cam) return;
    const exif = this.asset?.exifInfo;
    const m = session.meta;
    const lensName = (exif?.lensModel || m.lens || '').trim();
    this.lensQuery = {
      cameraMake: m.make || exif?.make || '',
      cameraModel: m.model || exif?.model || '',
      lens: lensName,
      focalLength: m.focalLength || exif?.focalLength || 0,
      aperture: m.aperture || exif?.fNumber || 0,
      width: cam.fullWidth,
      height: cam.fullHeight,
    };
    this.lensInfo = { ...this.lensInfo, searching: true, lensName };
    this.measureCA();
    try {
      if (/\.dng$/i.test(this.asset?.originalFileName ?? '')) {
        const ops = parseDngOpcodes(bytes);
        this.dngLens = ops ? dngCorrection(ops, { width: cam.fullWidth, height: cam.fullHeight }) : null;
      }
      const res = await fetch(`${import.meta.env.BASE_URL}lensfun/lensfun.json`);
      if (res.ok) this.lensDb = loadLensfun((await res.json()) as LensfunJson);
    } catch (e) {
      console.warn('Lens profile lookup failed', e);
    }
    this.lensInfo.searching = false;
    this.syncLens(true);
    this.requestRender();
  }

  /** Looks up the profile again when the chosen lens changed (picked, undone, pasted). */
  private syncLens(force = false): void {
    const r = this.renderer;
    const q = this.lensQuery;
    if (!r || !q || this.lensInfo.searching) return;
    const id = this.recipe.lens.lensId;
    if (!force && id === this.lensFor) return;
    this.lensFor = id;
    const db = this.lensDb;
    const auto = db ? lensfunCorrection(db, q) : null;
    const chosen = db && id ? lensfunCorrection(db, q, { lens: id }) : null;
    const lf = chosen ?? auto;
    let profile: LensCorrection | null = null;
    let label: string | null = null;
    if (this.dngLens && !chosen) {
      // The file's own correction wins; Lensfun only adds vignetting the file doesn't describe.
      const vig = this.dngLens.vignetting ?? lf?.correction.vignetting ?? null;
      profile = { ...this.dngLens, vignetting: vig };
      label = `Built into the DNG${!this.dngLens.vignetting && vig && lf ? ` (vignetting from Lensfun: ${lf.lens})` : ''}`;
    } else if (lf) {
      profile = lf.correction;
      label = `Lensfun: ${lf.lens}${chosen ? '' : ` (for ${lf.camera})`}`;
    }
    let candidates: LensInfo['candidates'] = [];
    if (db) {
      const camera = findCamera(db, q.cameraMake, q.cameraModel)?.camera ?? null;
      const fits = (l: { minFocal: number; maxFocal: number }) => !q.focalLength || !l.minFocal || (q.focalLength >= l.minFocal - 0.5 && q.focalLength <= (l.maxFocal || l.minFocal) + 0.5);
      candidates = searchLenses(db, camera, '', 2000)
        .filter((c) => fits(c.lens))
        .map((c) => ({ id: c.lens.id, name: lensDisplayName(c.lens) + (c.lens.id.includes('@') ? ` (crop ${c.lens.cropFactor})` : '') }))
        .sort((a, b) => a.name.localeCompare(b.name));
      if (id && !candidates.some((c) => c.id === id) && chosen) candidates.unshift({ id, name: chosen.lens });
    }
    this.lensInfo = { ...this.lensInfo, profile: label, autoName: auto?.lens ?? (this.dngLens ? 'built into the DNG' : ''), candidates };
    this.lensData = { ...this.lensData, profile };
    r.setLens(this.lensData);
  }

  /** Remove Chromatic Aberration: measures the fringes on the decoded image (half, then full size). */
  private measureCA(): void {
    const session = this.session;
    const r = this.renderer;
    if (!session || !r || !this.camera || !this.recipe.lens.removeCA) return;
    const from = this.fullImage ? 'full' : 'half';
    if (this.caFrom === 'full' || this.caFrom === from) return;
    try {
      const est = estimateLateralCA(this.fullImage ?? session.half, { fullWidth: this.camera.fullWidth });
      this.caFrom = from;
      this.lensData = { ...this.lensData, ca: est.correction };
      r.setLens(this.lensData);
      const px = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}`;
      this.lensInfo.caText = est.correction
        ? `Measured at the corners: red ${px(est.redShiftPx)} px, blue ${px(est.blueShiftPx)} px.`
        : est.samples < 20
          ? 'Not enough sharp edges to measure color fringes.'
          : 'No noticeable color fringes measured.';
      this.requestRender();
    } catch (e) {
      console.warn('CA measurement failed', e);
      this.lensInfo.caText = 'Could not measure color fringes.';
    }
  }

  setLensFlag(key: 'profile' | 'removeCA', on: boolean): void {
    if (this.readOnlyGuard()) return;
    this.recipe.lens[key] = on;
    if (key === 'removeCA' && on) this.measureCA();
    this.changed(true, `Lens Corrections: ${key === 'profile' ? 'Profile Corrections' : 'Remove Chromatic Aberration'} ${on ? 'On' : 'Off'}`);
  }

  /** Chooses the lens profile by hand ('' = automatic). */
  chooseLens(id: string): void {
    if (this.readOnlyGuard()) return;
    this.recipe.lens.lensId = id;
    this.syncLens();
    const name = this.lensInfo.candidates.find((c) => c.id === id)?.name;
    this.changed(true, `Lens Profile: ${name ?? 'Auto'}`);
  }

  resetLens(): void {
    if (this.readOnlyGuard()) return;
    this.recipe.lens = defaultRecipe().lens;
    this.syncLens();
    this.measureCA();
    this.changed(true, 'Reset Lens Corrections');
  }

  // ---------------------------------------------------------------- masking

  mask(id: string | null): Mask | null {
    return id ? (this.recipe.masks.find((m) => m.id === id) ?? null) : null;
  }

  get selectedMask(): Mask | null {
    return this.mask(this.maskSel.mask);
  }

  get selectedComponent(): MaskComponent | null {
    return this.selectedMask?.components.find((c) => c.id === this.maskSel.comp) ?? null;
  }

  selectMask(maskId: string | null, compId?: string): void {
    const m = this.mask(maskId);
    this.maskSel = { mask: m?.id ?? null, comp: compId ?? m?.components[0]?.id ?? null };
    this.requestRender();
  }

  /** Room for another component (and, for a new mask, another mask)? Tells the user if not. */
  private maskRoom(newMask: boolean): boolean {
    if (newMask && this.recipe.masks.length >= MAX_MASKS) {
      this.notice = `Up to ${MAX_MASKS} masks are supported.`;
      return false;
    }
    if (componentCount(this.recipe.masks) >= MAX_COMPONENTS) {
      this.notice = `Up to ${MAX_COMPONENTS} mask parts are supported in total.`;
      return false;
    }
    return true;
  }

  private nextMaskName(): string {
    const used = new Set(this.recipe.masks.map((m) => m.name));
    let n = this.recipe.masks.length + 1;
    while (used.has(`Mask ${n}`)) n++;
    return `Mask ${n}`;
  }

  /**
   * Arms a gradient to be drawn on the photo (Lightroom's M / Shift+M); luminance ranges
   * are added right away. mode/maskId: add to, subtract from or intersect with an existing mask.
   */
  startMask(kind: ComponentKind, mode: MaskMode = 'add', maskId: string | null = null): void {
    if (this.readOnlyGuard() || !this.maskRoom(!maskId)) return;
    if (this.tool !== 'mask') this.setTool('mask');
    if (kind === 'luminance') {
      this.addComponent(newComponent('luminance', maskId ? mode : 'add'), maskId);
      this.changed(true, `${maskId ? 'Add' : 'New Mask:'} ${COMPONENT_LABELS.luminance}`);
      return;
    }
    if (kind === 'brush' && brushCount(this.recipe.masks) >= MAX_BRUSHES) {
      this.notice = `Up to ${MAX_BRUSHES} brush parts are supported in total.`;
      return;
    }
    this.maskDraft = { kind, mode: maskId ? mode : 'add', maskId };
  }

  cancelMaskDraft(): void {
    this.maskDraft = null;
  }

  private addComponent(c: MaskComponent, maskId: string | null): void {
    const target = this.mask(maskId);
    if (target) {
      target.components.push(c);
      this.maskSel = { mask: target.id, comp: c.id };
    } else {
      const m = newMask(this.nextMaskName(), c);
      this.recipe.masks.push(m);
      this.maskSel = { mask: m.id, comp: c.id };
    }
  }

  /** Starts drawing the armed gradient at mask-frame point p; returns the new component's id. */
  beginMaskDraw(p: [number, number]): string | null {
    const d = this.maskDraft;
    if (!d || this.readOnlyGuard()) return null;
    const c = newComponent(d.kind, d.mode);
    if (c.kind === 'linear') Object.assign(c, { x0: p[0], y0: p[1], x1: p[0], y1: p[1] + 1e-3 });
    else if (c.kind === 'radial') Object.assign(c, { cx: p[0], cy: p[1], rx: 1e-3, ry: 1e-3 });
    else if (c.kind === 'color') c.samples = [{ x: q5(p[0]), y: q5(p[1]), r: 0 }];
    this.addComponent(c, d.maskId);
    this.maskDraft = null;
    this.drawLabel = `${d.maskId ? (d.mode === 'subtract' ? 'Subtract' : d.mode === 'intersect' ? 'Intersect' : 'Add') : 'New Mask:'} ${COMPONENT_LABELS[d.kind]}`;
    this.changed(false, this.drawLabel);
    return c.id;
  }

  /** Changes a component's geometry or settings (live while dragging; commit when done). */
  updateComponent(maskId: string, compId: string, patch: Partial<MaskComponent>, commit = false, label?: string): void {
    if (this.readOnlyGuard()) return;
    const m = this.mask(maskId);
    const c = m?.components.find((x) => x.id === compId);
    if (!m || !c) return;
    Object.assign(c, patch);
    if (c.kind === 'radial') {
      c.rx = Math.min(4, Math.max(1e-3, c.rx));
      c.ry = Math.min(4, Math.max(1e-3, c.ry));
      c.angle = ((c.angle % 360) + 360) % 360;
    } else if (c.kind === 'luminance' && c.lo > c.hi) {
      [c.lo, c.hi] = [c.hi, c.lo];
    }
    this.changed(commit, label ?? `${m.name}: Edit ${COMPONENT_LABELS[c.kind]}`);
  }

  /** Ends a gradient drawn by a click without a drag: gives it a useful default size. */
  finishMaskDraw(maskId: string, compId: string, draggedPx: number): void {
    const c = this.mask(maskId)?.components.find((x) => x.id === compId);
    if (c && draggedPx < 6) {
      if (c.kind === 'radial') Object.assign(c, { rx: 0.15, ry: 0.15 });
      else if (c.kind === 'linear') Object.assign(c, { y1: c.y0 + 0.15, x1: c.x0 });
    }
    this.changed(true, this.drawLabel ?? undefined);
    this.drawLabel = null;
  }

  // ---- brush

  setBrush(patch: Partial<BrushSettings>): void {
    const b = { ...$state.snapshot(this.brush), ...patch };
    this.brush = { ...normalizeBrush(b), erase: !!b.erase };
    storageSet(BRUSH_KEY, { size: this.brush.size, feather: this.brush.feather, flow: this.brush.flow, density: this.brush.density });
  }

  /** Is painting on the photo active (a brush armed, or a brush part selected)? */
  get painting(): boolean {
    return this.tool === 'mask' && !this.readOnly && (this.maskDraft?.kind === 'brush' || (!this.maskDraft && this.selectedComponent?.kind === 'brush'));
  }

  /** Starts a stroke at mask-frame point p: on the selected brush part, or a new brush if armed. */
  beginStroke(p: [number, number], erase: boolean): boolean {
    if (this.readOnlyGuard() || this.stroke) return false;
    let label: string;
    if (this.maskDraft?.kind === 'brush') {
      if (erase) return false; // nothing to erase yet
      if (!this.beginMaskDraw(p)) return false;
      label = this.drawLabel ?? 'Brush';
      this.drawLabel = null;
    } else {
      if (this.selectedComponent?.kind !== 'brush') return false;
      label = `${this.selectedMask!.name}: ${erase ? 'Erase' : 'Brush Stroke'}`;
    }
    const m = this.selectedMask;
    const c = this.selectedComponent;
    if (!m || !c || c.kind !== 'brush') return false;
    const b = this.brush;
    c.strokes.push({ erase, size: q5(brushRadius(b.size)), feather: b.feather, flow: b.flow, density: b.density, points: [q5(p[0]), q5(p[1])] });
    this.stroke = { maskId: m.id, compId: c.id, label };
    this.changed(false, label);
    return true;
  }

  extendStroke(p: [number, number]): void {
    const s = this.stroke;
    const c = s ? this.mask(s.maskId)?.components.find((x) => x.id === s.compId) : null;
    if (!s || !c || c.kind !== 'brush') return;
    const st = c.strokes[c.strokes.length - 1];
    if (!st) return;
    const n = st.points.length;
    // A point every ~fifth of the radius is plenty; dabs are interpolated between them.
    if (Math.hypot(p[0] - st.points[n - 2]!, p[1] - st.points[n - 1]!) < st.size * 0.2) return;
    if (c.strokes.reduce((k, x) => k + x.points.length, 0) >= MAX_BRUSH_POINTS * 2) {
      this.notice = 'This brush mask is full. Start a new brush part to keep painting.';
      return;
    }
    st.points.push(q5(p[0]), q5(p[1]));
    this.changed(false, s.label);
  }

  endStroke(): void {
    const s = this.stroke;
    this.stroke = null;
    if (s) this.changed(true, s.label);
  }

  // ---- colour range

  /** Adds a colour sample at p to the selected colour range (or replaces its samples); returns its index. */
  sampleColor(p: [number, number], add: boolean): number | null {
    const m = this.selectedMask;
    const c = this.selectedComponent;
    if (this.readOnlyGuard() || !m || !c || c.kind !== 'color') return null;
    const sample = { x: q5(p[0]), y: q5(p[1]), r: 0 };
    if (add && c.samples.length >= MAX_COLOR_SAMPLES) {
      this.notice = `Up to ${MAX_COLOR_SAMPLES} colour samples per range.`;
      return null;
    }
    c.samples = add ? [...c.samples, sample] : [sample];
    this.changed(false, `${m.name}: ${add ? 'Add Color Sample' : 'Color Sample'}`);
    return c.samples.length - 1;
  }

  removeColorSample(index: number): void {
    const m = this.selectedMask;
    const c = this.selectedComponent;
    if (this.readOnlyGuard() || !m || !c || c.kind !== 'color') return;
    c.samples = c.samples.filter((_, i) => i !== index);
    this.changed(true, `${m.name}: Remove Color Sample`);
  }

  setMaskParam(spec: ParamSpec, value: number, commit = false): void {
    const m = this.selectedMask;
    if (!m || this.readOnlyGuard()) return;
    const v = clampParam(spec, value);
    setPath(m, spec.path, v);
    this.changed(commit, `${m.name}: ${spec.label} ${formatParam(spec, v)}`);
  }

  maskValue(spec: ParamSpec): number {
    const m = this.selectedMask;
    return m ? (getPath(m, spec.path) as number) : spec.default;
  }

  resetMaskAdjust(): void {
    const m = this.selectedMask;
    if (!m || this.readOnlyGuard()) return;
    for (const k of Object.keys(LOCAL_PARAMS) as LocalKey[]) m.adjust[k] = 0;
    m.amount = 100;
    this.changed(true, `${m.name}: Reset`);
  }

  deleteComponent(maskId: string, compId: string): void {
    const m = this.mask(maskId);
    if (!m || this.readOnlyGuard()) return;
    if (m.components.length <= 1) return this.deleteMask(maskId);
    const c = m.components.find((x) => x.id === compId);
    m.components = m.components.filter((x) => x.id !== compId);
    m.components[0]!.mode = 'add';
    this.maskSel = { mask: m.id, comp: m.components[0]!.id };
    this.changed(true, `${m.name}: Remove ${c ? COMPONENT_LABELS[c.kind] : 'part'}`);
  }

  deleteMask(maskId: string): void {
    const m = this.mask(maskId);
    if (!m || this.readOnlyGuard()) return;
    this.recipe.masks = this.recipe.masks.filter((x) => x.id !== maskId);
    if (this.maskSel.mask === maskId) {
      const last = this.recipe.masks[this.recipe.masks.length - 1];
      this.maskSel = { mask: last?.id ?? null, comp: last?.components[0]?.id ?? null };
    }
    this.changed(true, `Delete ${m.name}`);
  }

  renameMask(maskId: string, name: string): void {
    const m = this.mask(maskId);
    const n = name.trim().slice(0, 60);
    if (!m || !n || n === m.name || this.readOnlyGuard()) return;
    m.name = n;
    this.changed(true, `Rename Mask: ${n}`);
  }

  toggleMaskVisible(maskId: string): void {
    const m = this.mask(maskId);
    if (!m || this.readOnlyGuard()) return;
    m.visible = !m.visible;
    this.changed(true, `${m.name}: ${m.visible ? 'Show' : 'Hide'}`);
  }

  invertComponent(maskId: string, compId: string): void {
    const c = this.mask(maskId)?.components.find((x) => x.id === compId);
    if (c) this.updateComponent(maskId, compId, { invert: !c.invert }, true, `${this.mask(maskId)!.name}: Invert ${COMPONENT_LABELS[c.kind]}`);
  }

  toggleMaskOverlay(): void {
    this.maskOverlay = !this.maskOverlay;
    this.requestRender();
  }

  /** Point of the photo view (0..1) -> mask frame, and back. */
  viewToMask(x: number, y: number): [number, number] | null {
    return this.renderer?.viewToMask(x, y) ?? null;
  }

  maskToView(p: [number, number]): [number, number] | null {
    return this.renderer?.maskToView(p[0], p[1]) ?? null;
  }

  // ---------------------------------------------------------------- view

  setTool(tool: Tool): void {
    if (tool !== 'edit' && this.readOnly) return;
    this.endTargeted();
    if (tool !== 'mask') this.maskDraft = null;
    if (tool === 'mask' && !this.maskSel.mask && this.recipe.masks.length) {
      const last = this.recipe.masks[this.recipe.masks.length - 1]!;
      this.maskSel = { mask: last.id, comp: last.components[0]?.id ?? null };
    }
    this.tool = tool;
    if (tool === 'crop') {
      this.before = false;
      this.setZoom(false);
    }
    this.requestRender();
  }

  toggleBefore(): void {
    this.before = !this.before;
    this.requestRender();
  }

  toggleClipping(): void {
    this.clipping = !this.clipping;
    this.requestRender();
  }

  setMaskView(view: MaskView): void {
    if (this.maskView === view) return;
    this.maskView = view;
    this.requestRender();
  }

  /** Zoom to 1:1 around a point of the current view (0..1), or back to fit. */
  toggleZoom(x = 0.5, y = 0.5): void {
    if (this.zoom.on) return this.setZoom(false);
    const t = this.renderer?.previewToFrame(x, y) ?? [0.5, 0.5];
    this.zoom = { on: true, cx: t[0], cy: t[1], scale: 1 };
    this.clampZoom();
    if (!this.fullImage) this.notice = 'Showing the half-size preview until the full-resolution decode finishes.';
    this.requestRender();
  }

  setZoom(on: boolean): void {
    if (!on && this.zoom.on) {
      this.zoom = { ...this.zoom, on: false };
      this.renderer?.releaseZoom();
      this.requestRender();
    }
  }

  /** Pans the zoomed view by a drag of (dx, dy) CSS pixels. */
  pan(dx: number, dy: number): void {
    if (!this.zoom.on || !this.renderer || !this.camera) return;
    const f = this.renderer.frameFor(this.recipe, 'edit', this.camera.fullWidth, this.camera.fullHeight);
    const dpr = this.viewport.dpr;
    this.zoom = {
      ...this.zoom,
      cx: this.zoom.cx - (dx * dpr) / (f.width * this.zoom.scale),
      cy: this.zoom.cy - (dy * dpr) / (f.height * this.zoom.scale),
    };
    this.clampZoom();
    this.requestRender();
  }

  private clampZoom(): void {
    if (!this.renderer || !this.camera) return;
    const f = this.renderer.frameFor(this.recipe, 'edit', this.camera.fullWidth, this.camera.fullHeight);
    const vw = this.viewport.width * this.viewport.dpr;
    const vh = this.viewport.height * this.viewport.dpr;
    const fw = f.width * this.zoom.scale;
    const fh = f.height * this.zoom.scale;
    const clamp = (c: number, view: number, full: number) => (full <= view ? 0.5 : Math.min(1 - view / 2 / full, Math.max(view / 2 / full, c)));
    this.zoom.cx = clamp(this.zoom.cx, vw, fw);
    this.zoom.cy = clamp(this.zoom.cy, vh, fh);
  }

  setViewport(width: number, height: number, dpr: number): void {
    this.viewport = { width, height, dpr };
    if (this.zoom.on) {
      this.clampZoom();
      this.requestRender();
    }
  }

  private readOnlyGuard(): boolean {
    if (this.readOnly) this.notice = 'This photo belongs to someone else, so it can only be viewed.';
    return this.readOnly;
  }

  // ---------------------------------------------------------------- crop

  /** Upright image size in proxy pixels (only the aspect matters for the crop maths). */
  uprightProxySize(): { w: number; h: number } {
    const r = this.renderer;
    if (!r || !this.camera) return { w: 3, h: 2 };
    return uprightSize(r.proxyWidth, r.proxyHeight, totalTurns(this.camera.flip, this.recipe.crop));
  }

  cropView(): ViewRect {
    const { w, h } = this.uprightProxySize();
    return cropToView(this.recipe.crop, w, h);
  }

  /** Sets the crop box from a rectangle in crop-view coordinates. */
  setCropView(view: ViewRect, opts: { commit?: boolean; manual?: boolean } = {}): void {
    if (this.readOnlyGuard()) return;
    const { w, h } = this.uprightProxySize();
    const fitted = fitViewRect(view, this.recipe.crop.angle, w, h, this.cropLimit());
    Object.assign(this.recipe.crop, viewToCrop(fitted, this.recipe.crop.angle, w, h));
    if (opts.manual) this.cropAuto = false;
    this.changed(opts.commit ?? false, 'Crop');
  }

  cropAspect(): number | null {
    const { w, h } = this.uprightProxySize();
    return aspectRatioFor(this.recipe.crop, w, h);
  }

  setAspect(aspect: AspectId): void {
    if (this.readOnlyGuard()) return;
    const { w, h } = this.uprightProxySize();
    this.recipe.crop.aspect = aspect;
    this.recipe.crop.portrait = h > w;
    const view = this.cropAuto
      ? maxViewRect(aspectRatioFor(this.recipe.crop, w, h), this.recipe.crop.angle, w, h, this.cropLimit())
      : withAspect(this.cropView(), aspectRatioFor(this.recipe.crop, w, h), this.recipe.crop.angle, w, h, this.cropLimit());
    Object.assign(this.recipe.crop, viewToCrop(view, this.recipe.crop.angle, w, h));
    this.changed(true, `Crop Aspect: ${aspect}`);
  }

  togglePortrait(): void {
    if (this.readOnlyGuard() || this.recipe.crop.aspect === 'free') return;
    const { w, h } = this.uprightProxySize();
    this.recipe.crop.portrait = !this.recipe.crop.portrait;
    const view = withAspect(this.cropView(), aspectRatioFor(this.recipe.crop, w, h), this.recipe.crop.angle, w, h, this.cropLimit());
    Object.assign(this.recipe.crop, viewToCrop(view, this.recipe.crop.angle, w, h));
    this.changed(true, 'Crop Orientation');
  }

  rotate90(dir: 1 | -1): void {
    if (this.readOnlyGuard()) return;
    const c = this.recipe.crop;
    c.rotate90 = ((((c.rotate90 + dir) % 4) + 4) % 4) as 0 | 1 | 2 | 3;
    c.angle = 0;
    const { w, h } = this.uprightProxySize();
    c.portrait = h > w;
    Object.assign(c, viewToCrop(maxViewRect(aspectRatioFor(c, w, h), 0, w, h, this.cropLimit()), 0, w, h));
    this.cropAuto = true;
    this.setZoom(false);
    this.changed(true, dir > 0 ? 'Rotate Right' : 'Rotate Left');
  }

  resetCrop(): void {
    if (this.readOnlyGuard()) return;
    this.recipe.crop = defaultRecipe().crop;
    this.cropAuto = true;
    this.changed(true, 'Reset Crop');
  }

  private fitCropAfterRotate(): void {
    const { w, h } = this.uprightProxySize();
    const c = this.recipe.crop;
    const limit = this.cropLimit();
    const view = this.cropAuto ? maxViewRect(aspectRatioFor(c, w, h), c.angle, w, h, limit) : fitViewRect(this.cropView(), c.angle, w, h, limit);
    Object.assign(c, viewToCrop(view, c.angle, w, h));
  }

  // ---------------------------------------------------------------- transform

  /** With Constrain Crop on: the inverse transform the crop must stay inside of. */
  cropLimit(): Affine | undefined {
    const t = this.recipe.transform;
    if (!t.constrain || !isTransformActive(t)) return undefined;
    const { w, h } = this.uprightProxySize();
    return transformInverse(t, w, h);
  }

  /** Keeps the crop inside the transformed image (largest box when the crop wasn't set by hand). */
  private constrainCrop(): void {
    this.fitCropAfterRotate();
  }

  setConstrainCrop(on: boolean): void {
    if (this.readOnlyGuard()) return;
    this.recipe.transform.constrain = on;
    if (on) {
      this.cropAuto = true;
      this.constrainCrop();
    }
    this.changed(true, `Transform: Constrain Crop ${on ? 'On' : 'Off'}`);
  }

  resetTransform(): void {
    if (this.readOnlyGuard()) return;
    this.recipe.transform = defaultRecipe().transform;
    this.changed(true, 'Reset Transform');
  }

  // ---------------------------------------------------------------- saving

  async save(): Promise<boolean> {
    const asset = this.asset;
    const session = this.session;
    const renderer = this.renderer;
    if (!asset || !session || !renderer || this.saving || this.readOnly) return false;
    this.commit();
    this.previewRecipe = null;
    const step = (s: keyof typeof STEP_LABEL, fraction = 0) => (this.saving = { label: STEP_LABEL[s], fraction });
    try {
      step('decode');
      this.startFullDecode();
      const full = await session.full();
      const recipe = cloneRecipe($state.snapshot(this.recipe) as Recipe);
      recipe.app = APP_ID;
      recipe.decoder = { name: session.decoder.name, version: session.decoder.version, demosaic: session.decoder.demosaic };
      step('render');
      const image = await renderer.exportImage(recipe, full, (done, total) => step('render', done / total));
      step('encode');
      const encoded = await encodeJpeg(image, 0.92);
      const jpeg = insertExif(encoded, { ...exifFromImmich(asset.exifInfo), software: APP_ID });
      const saved = await saveRender({
        raw: asset,
        recipe,
        jpeg: new Blob([jpeg as BlobPart], { type: 'image/jpeg' }),
        onProgress: (s, f) => step(s, f),
      });
      if (this.recipe.render?.assetId) this.pastRenders.add(this.recipe.render.assetId);
      this.recipe.render = saved.render;
      this.savedRenderId = saved.render?.assetId ?? null;
      this.syncReturnPath();
      this.recipe.decoder = saved.decoder;
      delete this.recipe.pending;
      this.savedJson = editableJson(saved);
      storageSet(PREVIOUS_KEY, pickGroups(saved, DEFAULT_GROUPS));
      this.hasPrevious = true;
      this.notice = 'Saved to Immich, stacked on top of the RAW.';
      this.asset = await getAssetInfo({ id: asset.id }).catch(() => asset);
      this.requestRender();
      return true;
    } catch (e) {
      console.error(e);
      this.notice = null;
      this.error = `Saving failed: ${e instanceof Error ? e.message : String(e)}`;
      return false;
    } finally {
      this.saving = null;
    }
  }

  // ---------------------------------------------------------------- convert to DNG

  openDngDialog(): void {
    const a = this.asset;
    if (!a || this.status !== 'ready') return;
    let blocked = convertBlocked(a, this.me);
    if (!blocked && this.dirty) blocked = 'Save or undo your changes first: the DNG takes over the saved edit.';
    if (!blocked && this.saving) blocked = 'Wait until saving has finished.';
    this.dngBuilt = null;
    this.dngDialog = {
      phase: 'options',
      mode: 'lossy',
      deleteMode: 'permanent',
      blocked,
      label: '',
      fraction: 0,
      originalSize: a.exifInfo?.fileSizeInByte ?? 0,
      dngSize: 0,
      builtMode: null,
      verification: null,
      error: null,
    };
  }

  closeDngDialog(): void {
    const d = this.dngDialog;
    if (!d || d.phase === 'building' || d.phase === 'replacing') return;
    this.dngDialog = null;
    this.dngBuilt = null;
  }

  setDngOptions(patch: Partial<Pick<DngDialog, 'mode' | 'deleteMode'>>): void {
    const d = this.dngDialog;
    if (!d || d.phase === 'building' || d.phase === 'replacing') return;
    Object.assign(d, patch);
    // A DNG built with the other compression no longer matches the choice.
    if (d.builtMode && d.builtMode !== d.mode) {
      this.dngBuilt = null;
      d.builtMode = null;
      d.verification = null;
      d.dngSize = 0;
      d.phase = 'options';
    }
  }

  private dngProgress(label: string, fraction: number): void {
    if (!this.dngDialog) return;
    this.dngDialog.label = label;
    this.dngDialog.fraction = fraction;
  }

  /** Builds and checks the DNG (nothing is uploaded or deleted yet). */
  async createDng(): Promise<void> {
    const d = this.dngDialog;
    const a = this.asset;
    const s = this.session;
    if (!d || !a || !s || !this.renderer || !this.camera || d.blocked || d.phase === 'building' || d.phase === 'replacing') return;
    d.phase = 'building';
    d.error = null;
    d.verification = null;
    this.dngBuilt = null;
    try {
      // Two big decodes at once can run LibRaw out of memory: let the editor's own finish first.
      if (this.fullStatus === 'decoding') {
        this.dngProgress('Waiting for the full-resolution decode', 0);
        await s.full().catch(() => {});
      }
      const bytes = await downloadOriginal({ id: a.id, checksum: a.checksum }, (f) => this.dngProgress('Reading the original', f));
      d.originalSize = bytes.length;
      const built = await buildDng({
        bytes,
        fileName: a.originalFileName,
        mode: d.mode,
        exif: a.exifInfo,
        software: APP_ID,
        preview: () => this.renderDngPreview(),
        reference: { image: s.half, meta: s.meta },
        full: () => s.full(),
        onProgress: (label, f) => this.dngProgress(label, f),
      });
      if (this.dngDialog !== d) return;
      this.dngBuilt = built;
      d.dngSize = built.bytes.length;
      d.builtMode = d.mode;
      d.verification = built.verification;
      d.phase = 'ready';
    } catch (e) {
      console.error(e);
      d.phase = 'error';
      d.error = `The DNG could not be made: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  /** The default look in sensor orientation (DNG previews are stored like the raw data). */
  private renderDngPreview(): Promise<ImageData> {
    const recipe = defaultRecipe();
    recipe.crop.rotate90 = ((4 - quarterTurnsFromFlip(this.camera!.flip)) % 4) as Recipe['crop']['rotate90'];
    return this.renderer!.exportImage(recipe, this.session!.half);
  }

  /** Uploads the checked DNG, moves everything over to it and deletes the original. */
  async replaceWithDng(): Promise<void> {
    const d = this.dngDialog;
    const built = this.dngBuilt;
    const a = this.asset;
    if (!d || !built || !a || d.phase !== 'ready' || !d.verification?.ok || this.dirty) return;
    d.phase = 'replacing';
    try {
      const id = await replaceWithDng({
        raw: a,
        dng: { bytes: built.bytes, fileName: built.fileName },
        deleteMode: d.deleteMode,
        conversion: {
          app: APP_ID,
          mode: d.mode,
          ...(d.mode === 'lossy' ? { quality: LOSSY_QUALITY } : {}),
          originalSize: d.originalSize,
          dngSize: built.bytes.length,
          deleted: d.deleteMode,
        },
        onProgress: (step, f) => this.dngProgress(REPLACE_LABEL[step], f),
      });
      this.dngProgress('Opening the DNG', 1);
      await cacheDng(id, built.bytes);
      location.replace(this.urlFor(id));
    } catch (e) {
      console.error(e);
      d.phase = 'error';
      d.error = e instanceof Error ? e.message : String(e);
    }
  }

  /** Where "back" goes: the page the user came from, pointing at the new render if saved. */
  backUrl(): string {
    const renderId = this.recipe.render?.assetId;
    const rawId = this.asset?.id;
    let path = this.returnPath ?? (rawId ? `/photos/${rawId}` : '/photos');
    // The editor may have been opened from the RAW or from an earlier render (the top of
    // the stack); either way, come back to the current render.
    if (renderId) {
      for (const id of [rawId, ...this.pastRenders]) {
        if (id && id !== renderId && path.includes(id)) path = path.replaceAll(id, renderId);
      }
    }
    return path;
  }

  /** Keeps the editor's own address in step after a save: its way back names the new render. */
  private syncReturnPath(): void {
    const back = this.backUrl();
    if (!isSafeReturnPath(back)) return;
    this.returnPath = back;
    const q = new URLSearchParams(location.search);
    q.set('return', back);
    history.replaceState(history.state, '', `${location.pathname}?${q}`);
  }

  /**
   * After a save in this session, waits (up to 20 s) until Immich has made the new render's
   * preview, so the photo shows up right away when going back instead of an old or empty one.
   */
  async waitForRender(): Promise<void> {
    const id = this.savedRenderId;
    if (!id || id !== this.recipe.render?.assetId) return;
    this.saving = { label: 'Waiting for Immich to prepare the photo', fraction: 1 };
    try {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        try {
          const res = await fetch(apiUrl(`/assets/${id}/thumbnail?size=preview`), { headers: authHeaders(), credentials: 'same-origin', cache: 'no-store' });
          if (res.ok) return;
        } catch {
          // keep trying until the deadline
        }
        await new Promise((r) => setTimeout(r, 700));
      }
    } finally {
      this.saving = null;
    }
  }

  /** Editor URL for another asset with the same context and return path (filmstrip). */
  urlFor(assetId: string): string {
    const q = new URLSearchParams({ asset: assetId });
    if (this.ctx) q.set('ctx', this.ctx);
    if (this.returnPath) q.set('return', this.returnPath.replace(this.asset?.id ?? '\u0000', assetId));
    return `${import.meta.env.BASE_URL}?${q}`;
  }
}

export const editor = new Editor();

// `?debug` exposes the editor for inspection from the console and tests.
if (new URLSearchParams(location.search).has('debug')) (globalThis as { __editor?: Editor }).__editor = editor;
