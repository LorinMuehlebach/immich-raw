// Editor state and actions. Components read the $state fields and call the methods;
// every change to the recipe goes through here so history and re-rendering stay in sync.
import {
  AssetFileType,
  deleteAssetMetadata,
  deleteAssets,
  downloadAssetFile,
  getAlbumInfo,
  getAssetInfo,
  getAssetMetadata,
  searchAssetFiles,
  updateAssetMetadata,
  updateStack,
  type AssetResponseDto,
  type UserAdminResponseDto,
} from '@immich/sdk';
import { RawSession, prewarmDecoder, readFujiFilmSim, setLibRawUrl, startMeasure, type FujiFilmSim, type LinearImage } from '@immich-raw/decoder';
import { isRawFilename } from '@immich-raw/inject/raw';
import { estimateLateralCA, findCamera, lensDisplayName, searchLenses, type LensCorrection, type LensQuery, type LensfunDb } from '@immich-raw/lens';
import { dngLensFor, lensQueryFor, loadLensDb, pickLensProfile } from '../lens-profile.ts';
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
  fitViewRect,
  isTransformActive,
  maxViewRect,
  quarterTurnsFromFlip,
  SCOPE_KINDS,
  SCOPE_SAMPLE_WIDTH,
  sampleSource,
  scopeOf,
  simplifyPolygon,
  tempTintForNeutral,
  totalTurns,
  transformInverse,
  uprightMatrix,
  uprightSize,
  viewToCrop,
  withAspect,
  asImageData,
  SRGB8,
  type Affine,
  type AutoParams,
  type CameraInfo,
  type Histogram,
  type LensData,
  type MaskView,
  type OutputColor,
  type Pixels,
  type ProfileLooks,
  type ScopeData,
  type ScopeKind,
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
  MAX_AI,
  MAX_BRUSHES,
  MAX_BRUSH_POINTS,
  MAX_OBJECT_POINTS,
  MAX_POLYGON_POINTS,
  MAX_UPRIGHT_GUIDES,
  aiCount,
  aiLabel,
  newAiComponent,
  MAX_COLOR_SAMPLES,
  MAX_COMPONENTS,
  MAX_MASKS,
  brushCount,
  componentCount,
  componentLabel,
  newComponent,
  newMask,
  defaultEdge,
  isEdgeSet,
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
  recipeHash,
  setPath,
  type AiComponent,
  type AiTarget,
  type AspectId,
  type CurveChannel,
  type LandscapeClass,
  type PersonPart,
  type CurvePoint,
  type ComponentKind,
  type GroupId,
  type LocalKey,
  type Mask,
  type MaskComponent,
  type MaskMode,
  type PolygonComponent,
  type MaskEdge,
  type MixerChannel,
  type ParamSpec,
  type ProfileId,
  profileInfo,
  type Recipe,
  type SettingsPatch,
  type Wheel,
} from '@immich-raw/recipe';
import { apiUrl, authHeaders, getServerVersionInfo, getSession, initApi, serverVersionWarning, setApiKey } from '../immich/api.ts';
import { buildDng, LOSSY_QUALITY, type BuiltDng, type DngMode, type Verification } from '../dng/convert.ts';
import { hasDecoded, readDecoded, writeDecoded } from '../immich/decoded-cache.ts';
import { keepView, readView, type KeptView } from '../immich/view-cache.ts';
import { editStates } from '../immich/edit-state.ts';
import { DraftKeeper, canvasJpeg, thumbnailJpeg } from '../drafts/draft-keeper.ts';
import { draftKey, savedShows, withDraft, type Draft } from '../drafts/draft-store.ts';
import { drafts } from '../drafts/drafts.svelte.ts';
import { describeDraftsSaved, saveDraftPhoto, saveEach } from '../drafts/save-drafts.ts';
import { syncInto } from '../drafts/sync.ts';
import { RawRenderer } from '../export/raw-render.ts';
import { draftSource, looks, previewSource, viewShows, viewSource, type LookHint } from '../immich/looks.ts';
import { downloadOriginal, hasOriginal, type DownloadProgress } from '../immich/download.ts';
import { pinPhoto, unpinPhotos } from '../immich/photo-cache.ts';
import { canPrefetch, decodeNeighbour, fetchNeighbour, resetPrefetch } from '../immich/prefetch.ts';
import { cacheDng, convertBlocked, replaceWithDng, type DeleteMode, type ReplaceStep } from '../immich/replace.ts';
import { canEdit, errorMessage, readMetadata, saveRender, writeMetadata, type SaveStep } from '../immich/save.ts';
import { copiesIn, copyInfo, copyKey, copyValue, historyKeyFor, newCopy, parseCopy, storedEdit, type CopyInfo, type CopyMeta } from '../immich/copies.ts';
import { History, editable, editableJson, type HistoryStep } from './history.ts';
import {
  DEFAULT_EXPORT_SETTINGS,
  PRESET_LABELS,
  exportFilename,
  normalizeExportSettings,
  type ExportPreset,
  type ExportPresetId,
  type ExportSettings,
  type SaveSettings,
} from './export-settings.ts';
import { downloadBlob } from '../download.ts';
import { loadLogoBitmap } from './logos.ts';
import { captureDate } from '../export/metadata.ts';
import { finishExport, outputColor, type ExportFile } from '../export/output.ts';
import { parseContext } from '../immich/context.ts';
import { newId } from '../id.ts';
import { anchoredCentre, fitScale, nextScale } from './zoom.ts';
import { AiMasks } from './ai-masks.svelte.ts';
import { aiClient, aiConsent, imageToMask } from '../ai.svelte.ts';
import { CANCELLED, tileSide, upscaler, type Progress, type UpscaleScale, type UpscaleStyle, type UpscaleTask } from '@immich-raw/ai';
import { saveUpscaled, type UpscaleSaveStep } from '../immich/save-upscaled.ts';
import { PATCH, UpscaleState } from './upscale.svelte.ts';
import { UPSCALE_QUALITY, checkUpscale, formatDuration, upscaledDownloadName, type UpscaleCheck } from './upscale.ts';
import { FUJI_DECLINED, fujiLooks } from '../fuji-looks.svelte.ts';
import { photoDefaults, type PhotoDefaults } from '../photo-defaults.ts';
import { OPEN_LABELS, beginStep, endStep, newOpenSteps, type OpenStep, type OpenStepId } from './open-progress.ts';
import {
  cameraKey,
  estimateDecodeMs,
  estimateCachedMs,
  estimateDownloadMs,
  estimateFullMs,
  estimateInfoMs,
  estimateReadMs,
  estimateShowMs,
  loadOpenTimes,
  recordFull,
  recordOpen,
  saveOpenTimes,
  type OpenSample,
  type OpenTimes,
} from './open-times.ts';

export type Status = 'loading' | 'auth' | 'error' | 'ready';
/**
 * 'tat': Lightroom's targeted adjustment tool (drag on the photo to change the Color Mixer).
 * 'mask': the Masking panel with its on-image handles.
 * 'upright': Guided Upright, guides drawn on the whole (uncropped) photo.
 */
export type Tool = 'edit' | 'crop' | 'wb' | 'tat' | 'mask' | 'upscale' | 'upright';

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
  /** Index into ai.people of the person picked; -1 = everyone. */
  who: number;
}

const MODE_VERB: Record<MaskMode, string> = { add: 'Add', subtract: 'Subtract', intersect: 'Intersect' };

/** History name of a mask part. */
const partLabel = componentLabel;

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

/** Shown while a zoomed view waits for the full-resolution decode; cleared when it is there. */
const HALF_SIZE_NOTICE = 'Showing the half-size preview until the full-resolution decode finishes.';
const FULL_FAILED_NOTICE = 'The full-resolution decode failed, so zooming in shows the half-size preview.';
/** For estimates before Immich has said how big the RAW is. */
const TYPICAL_RAW_BYTES = 50e6;
/** Thrown inside an open when another photo was opened meanwhile; not an error. */
const SUPERSEDED = Symbol('superseded');

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

/** Steps of rendering the edit to a JPEG, for saving and exporting. */
type RenderStep = 'decode' | 'render' | 'resize' | 'sharpen' | 'encode';

const STEP_LABEL: Record<SaveStep | RenderStep, string> = {
  decode: 'Decoding full resolution',
  render: 'Rendering',
  resize: 'Resizing',
  sharpen: 'Sharpening',
  encode: 'Encoding',
  prepare: 'Preparing',
  upload: 'Uploading',
  metadata: 'Copying date, location, albums and tags',
  stack: 'Stacking with the RAW',
  recipe: 'Saving edit settings',
  cleanup: 'Moving the previous version to trash',
};

/** What Save did with the stack, from the RAW's stack front after saving. */
function savedNotice(front: string | undefined, rawId: string, renderId: string | null, saved = 'Saved'): string {
  if (front && front === renderId) return `${saved} to Immich, stacked on top of the RAW.`;
  if (front === rawId) return `${saved} to Immich, in the RAW's stack behind the RAW.`;
  return `${saved} to Immich, in the RAW's stack.`;
}

const UPSCALE_SAVE_LABEL: Record<UpscaleSaveStep, string> = {
  upload: 'Uploading',
  metadata: 'Copying date, location, albums and tags',
  stack: 'Stacking with the RAW',
};

const CHANNEL_LABEL: Record<MixerChannel, string> = { hue: 'Hue', saturation: 'Saturation', luminance: 'Luminance' };

/** History label for a slider change, e.g. "Exposure +0.50", "Saturation: Blue -30". */
function historyLabel(spec: ParamSpec, value: number): string {
  const v = formatParam(spec, value);
  const parts = spec.path.split('.');
  if (parts[0] === 'profileAmount') return `Profile Amount ${v}`;
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
const COLOR_FALLBACK = "The Fujifilm film look isn't downloaded in this browser, so it was rendered with Color.";
const PREVIOUS_KEY = 'raw-editor.previous';
const AUTO_PARAMS_KEY = 'raw-editor.autoParams';
const EXPORT_KEY = 'raw-editor.export';
const SCOPE_KEY = 'raw-editor.scope';

/** Snapshots stored under `key` in a metadata listing. */
function snapshotsIn(items: readonly { key: string; value: unknown }[], key: string): Snapshot[] {
  const v = items.find((i) => i.key === key)?.value as { snapshots?: Snapshot[] } | undefined;
  return Array.isArray(v?.snapshots) ? v.snapshots.filter((s) => s && typeof s.state === 'string') : [];
}

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
  /** The steps of opening the photo, for the loading screen (empty until the session is checked). */
  openSteps = $state<OpenStep[]>([]);
  /** The running full-resolution decode: when it started and how long it should take. */
  fullEta = $state<{ startedAt: number; estimateMs: number } | null>(null);
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
  /** Which scope shows above the panels (kept in this browser), and its data when it isn't the histogram. */
  scope = $state<ScopeKind>(SCOPE_KINDS.find((k) => k === storageGet<string>(SCOPE_KEY)) ?? 'histogram');
  scopeData = $state<ScopeData | null>(null);
  fullStatus = $state<'idle' | 'decoding' | 'ready' | 'error'>('idle');
  /** A save, export or upscale in progress; `cancel` when it can be stopped. */
  saving = $state<{ label: string; fraction: number; cancel?: () => void } | null>(null);
  canUndo = $state(false);
  canRedo = $state(false);
  historySteps = $state<HistoryStep[]>([]);
  historyIndex = $state(0);
  snapshots = $state<Snapshot[]>([]);
  /** The virtual copy being edited; null = the original edit. */
  copyId = $state<string | null>(null);
  /** The RAW's virtual copies (Lightroom's), in the order they were made. */
  copies = $state<CopyInfo[]>([]);
  hasClipboard = $state(false);
  hasPrevious = $state(false);
  sidecarOffer = $state<SidecarOffer | null>(null);
  /**
   * Offer to download the Fujifilm film looks: 'camera' to start from the film simulation set
   * in the camera, 'edit' because the saved edit uses one. label: the look's name.
   */
  fujiOffer = $state<{ reason: 'camera' | 'edit'; label: string } | null>(null);
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
  /** Export presets and the one Save uses for the Immich copy (kept in this browser). */
  exportSettings = $state<ExportSettings>(normalizeExportSettings(storageGet(EXPORT_KEY)));
  /** Masking: the selected mask and component, the gradient about to be drawn, the red overlay. */
  maskSel = $state<{ mask: string | null; comp: string | null }>({ mask: null, comp: null });
  maskDraft = $state<MaskDraft | null>(null);
  aiPicker = $state<AiPicker | null>(null);
  /** The red overlay is wanted (checkbox, O). It shows only while the mask's shape is edited. */
  maskOverlay = $state(true);
  /**
   * What is being edited on the selected mask: its shape (parts, refinement: the overlay shows)
   * or its adjustments (Amount, Exposure…: the overlay hides, so the result can be judged).
   */
  maskEditing = $state<'shape' | 'adjust'>('shape');
  brush = $state<BrushSettings>(normalizeBrush(storageGet(BRUSH_KEY)));
  /** Bumped after every render, so on-image handles follow zoom, pan and crop. */
  viewVersion = $state(0);
  lensInfo = $state<LensInfo>({ searching: false, profile: null, lensName: '', autoName: '', candidates: [], caText: '' });
  dngDialog = $state<DngDialog | null>(null);

  camera: CameraInfo | null = null;
  session: RawSession | null = null;
  fullImage: LinearImage | null = null;
  renderer: Renderer | null = null;
  /** AI masks of the open photo (computed in a worker). */
  ai = new AiMasks({
    renderer: () => this.renderer,
    photoKey: () => (this.asset ? `${this.asset.id}:${this.asset.checksum}` : null),
    requestRender: () => this.requestRender(),
  });
  /** AI Upscale: settings, where it runs, the preview patch. */
  upscale = new UpscaleState();
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
  /** The photo's starting settings (its in-camera film look for a Fujifilm RAW). */
  private defaults: PhotoDefaults = { recipe: defaultRecipe(), wanted: null, simLabel: null };
  private fujiSim: FujiFilmSim | null = null;
  /** The RAW had a saved edit when it was opened. */
  private storedEdit = false;
  /** Renders this RAW had before (the page Immich returns to may show one of them). */
  private pastRenders = new Set<string>();
  /** The render made by a save in this session (Immich may still be making its preview). */
  private savedRenderId: string | null = null;
  /** How long opens took in this browser (for the loading screen's estimates). */
  private openTimes: OpenTimes = { cameras: {} };
  /** The open photo's camera (open-times.ts) and the size of its RAW file. */
  private cameraKey = '';
  private fileBytes = 0;
  /** Photos next to this one to get ready in the background, and those already done. */
  private prefetchWanted: string[] = [];
  /** Photos whose download was tried, and the checksums of those fetched (to decode next). */
  private prefetchTried = new Set<string>();
  private prefetchFetched = new Map<string, string>();
  private prefetchDecodeTried = new Set<string>();
  private prefetchMayDecode = false;
  private fetching = false;
  private decoding = false;
  /** The open photo's half-size image is in the cache (or won't be): neighbours come after it. */
  private decodedKept: Promise<void> = Promise.resolve();
  /** When the download's progress was last shown. */
  private lastBytesShown = 0;
  /** The canvas the renderer draws on; the renderer is made once and kept for every photo. */
  private canvas: HTMLCanvasElement | null = null;
  /** Counts the photos opened in this page: an open that isn't the latest stops (SUPERSEDED). */
  private photoGen = 0;
  /** Stops the running open's download and half-size decode when another photo is opened. */
  private openStop = new AbortController();
  /** The photo and saved state whose look was last kept for the loading screen (keepViewIfPlain). */
  private viewKept = '';
  /** Which picture `previewUrl` shows (looks.ts), so the same one isn't fetched and swapped in again. */
  private previewSource: string | null = null;
  /** The open photo's draft, kept in this browser while it has unsaved changes (drafts/). */
  private draftKeeper = new DraftKeeper(
    {
      current: () => (this.status === 'ready' && this.asset ? { assetId: this.asset.id, checksum: this.asset.checksum, copyId: this.copyId } : null),
      dirty: () => this.dirty,
      blocked: () => this.readOnly || !!this.saving,
      recipe: () => $state.snapshot(this.recipe) as Recipe,
      savedBase: () => (this.storedEdit || this.savedRenderId ? this.savedJson : 'unedited'),
      plainCanvas: () => {
        if (!this.canvas || !this.plainView()) return null;
        this.renderNow();
        return this.canvas;
      },
    },
    { store: drafts, snapshot: canvasJpeg, thumbnail: thumbnailJpeg },
  );
  /** The photo opened with a draft made before its saved edit changed (saved in another tab or browser). */
  draftConflict = $state<{ at: number } | null>(null);
  /** Undo histories of the edits opened in this page, by draftKey(), with the state each ends on. */
  private histories = new Map<string, { history: History; json: string }>();
  /** The same for the background work on the photos around it. */
  private prefetchStop = new AbortController();

  dirty = $derived(editableJson(this.recipe) !== this.savedJson);

  // ---------------------------------------------------------------- loading

  async load(canvas: HTMLCanvasElement): Promise<void> {
    this.canvas = canvas;
    const assetId = this.readUrl();
    this.hasClipboard = !!storageGet(CLIPBOARD_KEY);
    this.hasPrevious = !!storageGet(PREVIOUS_KEY);
    setLibRawUrl(`${import.meta.env.BASE_URL}libraw/index.js`);
    initApi();

    try {
      // From navigating here until the app runs (loading the page and its scripts).
      try {
        performance.measure('immich-raw:page start', { start: 0, end: performance.now() });
      } catch {
        // no User Timing: nothing to show in DevTools
      }
      const doneSession = startMeasure('session');
      this.me = await getSession();
      doneSession();
      if (!this.me) {
        this.status = 'auth';
        return;
      }
      if (!assetId) throw new Error('No photo selected. Open a RAW in Immich and click "Edit RAW".');
      getServerVersionInfo()
        .then((v) => (this.warning = serverVersionWarning(v)))
        .catch(() => {});
      await this.openPhoto(assetId, this.photoGen);
    } catch (e) {
      if (e !== SUPERSEDED) this.fail(e);
    }
  }

  /** The photo, context and return path in the address bar; the photo's id. */
  private readUrl(): string | null {
    const params = new URLSearchParams(location.search);
    const ret = params.get('return');
    this.returnPath = ret && isSafeReturnPath(ret) ? ret : null;
    this.ctx = params.get('ctx');
    return params.get('asset');
  }

  /**
   * Opens another photo in this page: the filmstrip, the arrow keys, and the browser's Back and
   * Forward. The page, the renderer with its compiled shaders, the filmstrip and the decoder stay.
   * `url`: 'push' adds the photo to the browser's history; 'none' when the address already
   * changed (Back and Forward). `hint`: what the filmstrip has of the photo (looks.ts), shown
   * before anything is asked of Immich.
   */
  async switchPhoto(id: string, url: 'push' | 'none' = 'push', hint: LookHint = {}): Promise<void> {
    if (this.saving) return;
    if (url === 'push') history.pushState(null, '', this.urlFor(id));
    this.readUrl();
    const kept = this.draftKeeper.keep();
    this.forgetChangedLook(kept);
    this.keepHistory();
    this.closePhoto();
    // The filmstrip moves on at once (and ← → count from this photo), its look shows.
    if (hint.asset?.id === id) this.asset = hint.asset;
    if (hint.look) {
      this.previewUrl = URL.createObjectURL(hint.look.image);
      this.previewSource = hint.look.source;
    }
    const gen = ++this.photoGen;
    // This photo's step timings only (DevTools, the probes).
    performance.clearMeasures?.();
    try {
      await this.openPhoto(id, gen);
    } catch (e) {
      if (e !== SUPERSEDED && gen === this.photoGen) this.fail(e);
    }
  }

  /**
   * The photo being left looks different from what the filmstrip got ready for it, if it was
   * saved here (its stored edit changed) or the editor kept a new look of it (view-cache.ts).
   */
  private forgetChangedLook(draftKept: Promise<void>): void {
    const id = this.asset?.id;
    if (!id) return;
    if (this.savedRenderId) editStates.forget(id);
    if (this.savedRenderId || this.viewKept) looks.forget(id);
    // Its draft (and the picture of it) is being written: forget the look once it is.
    if (this.dirty) void draftKept.finally(() => looks.forget(id));
  }

  /** Keeps the undo history of the edit being left, for when it is opened again in this page. */
  private keepHistory(): void {
    if (this.status !== 'ready' || !this.asset) return;
    const key = draftKey(this.asset.id, this.copyId);
    this.histories.delete(key);
    this.histories.set(key, { history: this.history, json: editableJson(this.recipe) });
    // The oldest go: up to 200 steps of a few kB each per edit.
    if (this.histories.size > 40) this.histories.delete(this.histories.keys().next().value!);
    this.history = new History();
  }

  /**
   * Starts the undo history of the edit just opened: the one it had earlier in this page if that
   * ends where the edit is now, else the saved state (`saved`) with the draft as one step on top.
   */
  private startHistory(saved: Recipe, label: string, draft: Draft | null): void {
    const key = this.asset ? draftKey(this.asset.id, this.copyId) : '';
    const kept = this.histories.get(key);
    const now = $state.snapshot(this.recipe) as Recipe;
    if (kept && kept.json === editableJson(now)) {
      this.history = kept.history;
    } else {
      this.history.reset(saved, label);
      if (draft) this.history.commit(now, 'Draft');
    }
    this.draftKeeper.opened(draft ? now : null);
  }

  /**
   * Puts away the open photo before the next one opens: stops its background work (the
   * full-resolution decode is cancelled; what else finishes later finds it gone) and resets
   * everything that belongs to it.
   */
  private closePhoto(): void {
    this.openStop.abort();
    this.session?.close();
    this.session = null;
    this.fullImage = null;
    this.camera = null;
    this.status = 'loading';
    this.error = null;
    this.notice = null;
    this.fullStatus = 'idle';
    this.fullEta = null;
    if (this.previewUrl) URL.revokeObjectURL(this.previewUrl);
    this.previewUrl = null;
    this.previewSource = null;
    this.draftConflict = null;
    this.draftKeeper.opened(null);
    this.recipe = defaultRecipe();
    this.savedJson = editableJson(this.recipe);
    this.history.reset($state.snapshot(this.recipe) as Recipe, 'Open');
    this.syncHistory();
    this.snapshots = [];
    this.copies = [];
    this.copyId = null;
    this.sidecarOffer = null;
    this.fujiOffer = null;
    this.dngDialog = null;
    this.dngBuilt = null;
    this.exportDialog = null;
    this.tool = 'edit';
    this.before = false;
    this.maskView = 'none';
    this.histogram = null;
    this.scopeData = null;
    this.uprightSel = null;
    if (this.histogramTimer) clearTimeout(this.histogramTimer);
    this.histogramTimer = null;
    this.zoom = { on: false, cx: 0.5, cy: 0.5, scale: 1 };
    this.cropAuto = true;
    this.maskSel = { mask: null, comp: null };
    this.maskDraft = null;
    this.aiPicker = null;
    this.maskEditing = 'shape';
    this.lensInfo = { searching: false, profile: null, lensName: '', autoName: '', candidates: [], caText: '' };
    this.lensQuery = null;
    this.dngLens = null;
    this.lensData = NO_LENS;
    this.lensFor = null;
    this.caFrom = null;
    this.pendingLabel = 'Edit';
    this.previewRecipe = null;
    this.tatDrag = null;
    this.autoApplied = null;
    this.autoSamples = null;
    this.drawLabel = null;
    this.stroke = null;
    this.defaults = { recipe: defaultRecipe(), wanted: null, simLabel: null };
    this.fujiSim = null;
    this.storedEdit = false;
    this.pastRenders = new Set();
    this.savedRenderId = null;
    this.decodedKept = Promise.resolve();
    this.viewKept = '';
    this.previewRun++;
    this.upscale.preview = null;
    this.upscale.previewStatus = null;
    this.upscale.previewError = null;
    this.ai.reset();
    this.renderer?.releaseZoom();
    this.renderer?.setLens(NO_LENS);
    // The photos around the new one get pinned and fetched afresh. A download or decode still
    // running stops: the new photo may need the network and the processor (it may even be that photo).
    this.prefetchStop.abort();
    this.prefetchStop = new AbortController();
    this.prefetchWanted = [];
    this.prefetchTried.clear();
    this.prefetchFetched.clear();
    this.prefetchDecodeTried.clear();
    this.prefetchMayDecode = false;
    resetPrefetch();
  }

  /** The steps of opening one photo, up to its first render; background work starts at the end. */
  private async openPhoto(assetId: string, gen: number): Promise<void> {
    const live = () => {
      if (gen !== this.photoGen) throw SUPERSEDED;
    };
    const canvas = this.canvas!;
    const stop = (this.openStop = new AbortController());
    {
      // The decoder's worker loads its WebAssembly while the photo info and the original arrive.
      prewarmDecoder();
      const now = () => performance.now();
      const times = (this.openTimes = loadOpenTimes());
      this.openSteps = newOpenSteps({
        info: estimateInfoMs(times),
        original: estimateDownloadMs(times, TYPICAL_RAW_BYTES),
        decode: estimateDecodeMs(times, '', TYPICAL_RAW_BYTES),
        show: estimateShowMs(times, ''),
      });

      beginStep(this.openSteps, 'info', now());
      let done = startMeasure('asset info');
      const asset = await getAssetInfo({ id: assetId });
      done();
      live();
      endStep(this.openSteps, 'info', now());
      if (!isRawFilename(asset.originalFileName)) throw new Error(`${asset.originalFileName} is not a RAW file.`);
      this.asset = asset;
      this.readOnly = !canEdit(asset, this.me!);
      document.title = `${asset.originalFileName} · immich-raw`;
      // What the photo looked like here last time; whether it still applies depends on the saved edit.
      const viewP = readView(asset.checksum);
      // Unsaved changes kept in this browser (drafts/), for the edit in the address bar.
      const urlCopy = new URLSearchParams(location.search).get('copy');
      const draftP = this.readOnly ? Promise.resolve(null) : drafts.get(asset.id, urlCopy);
      // The cache never pushes out the photo being edited while it is open.
      unpinPhotos();
      pinPhoto(asset.checksum);
      const camera = (this.cameraKey = cameraKey(asset.exifInfo?.make, asset.exifInfo?.model, asset.originalFileName));
      this.fileBytes = asset.exifInfo?.fileSizeInByte ?? 0;
      const sizeGuess = this.fileBytes || TYPICAL_RAW_BYTES;
      this.estimateStep('original', estimateDownloadMs(times, sizeGuess));
      this.estimateStep('decode', estimateDecodeMs(times, camera, sizeGuess));
      this.estimateStep('show', estimateShowMs(times, camera));

      // The original downloads (or comes from this browser's cache) while the saved edit, the
      // snapshots and a decoded copy of the photo kept from an earlier open load.
      beginStep(this.openSteps, 'original', now());
      const doneDownload = startMeasure('download');
      const original = { from: null as DownloadProgress['from'] | null, endedAt: 0 };
      const bytesP = downloadOriginal({ id: asset.id, checksum: asset.checksum }, (_f, p) => {
        if (gen !== this.photoGen) return;
        original.from = p.from;
        if (p.received >= p.total && p.total > 0) original.endedAt = now();
        this.originalProgress(p);
      }, stop.signal);
      bytesP.then(doneDownload, () => {});
      const doneCacheRead = startMeasure('decoded cache read');
      const cacheReadStarted = now();
      let cachedMs: number | undefined;
      const decodedP = readDecoded(asset.checksum).then((photo) => {
        if (photo) {
          doneCacheRead();
          cachedMs = now() - cacheReadStarted;
        }
        return photo;
      });
      const decodedKept = hasDecoded(asset.checksum);
      decodedKept.then((kept) => {
        if (gen !== this.photoGen) return;
        // Say so before the step starts: it takes a fraction of a decode.
        const s = this.openSteps.find((x) => x.id === 'decode');
        if (kept && s && s.startedAt === null) Object.assign(s, { label: OPEN_LABELS.decodeCached, estimateMs: estimateCachedMs(times, camera, sizeGuess) });
      });
      const bothKept = Promise.all([decodedKept, hasOriginal(asset.checksum)]).then(([d, o]) => d && o);
      done = startMeasure('recipe and snapshots');
      // One listing holds the edit, its snapshots and the virtual copies.
      const listed = await getAssetMetadata({ id: asset.id }).catch(() => null);
      done();
      live();
      // The filmstrip's looks and badges go by the same listing.
      if (listed) editStates.remember(asset.id, listed);
      const items = listed ?? [];
      this.copies = copiesIn(items).map(copyInfo);
      let copyId = new URLSearchParams(location.search).get('copy');
      if (copyId && !this.copies.some((c) => c.id === copyId)) {
        this.notice = 'That virtual copy no longer exists; the original edit is open.';
        copyId = null;
        this.setUrlCopy(null);
      }
      this.copyId = copyId;
      const stored = storedEdit(items, copyId);
      const draft = this.readOnly ? null : copyId === urlCopy ? await draftP : await drafts.get(asset.id, copyId);
      live();
      void this.showPreview(asset, stored, viewP, gen, draft);
      this.snapshots = snapshotsIn(items, historyKeyFor(copyId));
      this.storedEdit = !!stored;
      // Synced settings (draft.patch) go on whatever is saved; a draft from the editor may be older than the save.
      if (draft && !draft.patch && draft.base !== savedShows(stored)) this.draftConflict = { at: draft.updatedAt };
      // Film looks kept in this browser (never downloads here).
      const looksP = fujiLooks.load();
      if (stored) {
        this.recipe = draft ? withDraft(stored, draft) : stored;
        this.savedJson = editableJson(stored);
        if (stored.render?.assetId) this.pastRenders.add(stored.render.assetId);
      }

      // The shaders compile while this thread would otherwise wait: during the decode (in its
      // worker), or, when both are cached, while the original and the kept decode are read. Not
      // during a download: its chunks are read on this thread, and compiling blocks it.
      // Made once, for the first photo of the page; later photos reuse it.
      let renderer: Renderer | null = this.renderer;
      let compiledAt = 0;
      const makeRenderer = async (): Promise<Renderer> => {
        // The pause lets the promise chains started just before go on first.
        await new Promise((resolve) => setTimeout(resolve, 0));
        done = startMeasure('renderer');
        const r = new Renderer(canvas);
        r.onContextLost = () => (this.error = 'The graphics context was lost. Reload the page to continue.');
        done();
        compiledAt = now();
        return r;
      };
      try {
        if (!renderer && (await bothKept)) renderer = await makeRenderer();
        const bytes = await bytesP;
        live();
        endStep(this.openSteps, 'original', now());
        this.fileBytes = bytes.length;
        // The film simulation set in the camera (Fujifilm maker note); null for other files.
        this.fujiSim = readFujiFilmSim(bytes);
        const cached = await decodedP;
        live();
        let session: RawSession;
        let decodeMs: number | undefined;
        if (cached) {
          beginStep(this.openSteps, 'decode', now(), { label: OPEN_LABELS.decodeCached, estimateMs: estimateCachedMs(times, camera, bytes.length) });
          session = RawSession.restore(bytes, cached.meta, cached.half);
        } else {
          const started = now();
          beginStep(this.openSteps, 'decode', started, { estimateMs: estimateDecodeMs(times, camera, bytes.length) });
          const doneDecode = startMeasure('half decode');
          // The decode takes several round trips to its worker. Compile once the worker has the
          // long one (unpacking), or a round trip waits for the compile.
          let working!: () => void;
          const workerBusy = new Promise<void>((resolve) => (working = resolve));
          const sessionP = RawSession.open(bytes, () => working(), stop.signal).then((opened) => {
            doneDecode();
            // Right after a long compile (a new browser profile: seconds), the result waited for
            // this thread, so the time says more about the compile than the decode.
            if (now() - compiledAt > 30) decodeMs = now() - started;
            return opened;
          });
          const settled = sessionP.then(
            () => {},
            () => {},
          ); // the decode's error is thrown below, after the shaders
          await Promise.race([workerBusy, settled]);
          renderer ??= await makeRenderer();
          session = await sessionP;
          live();
        }
        renderer ??= await makeRenderer();
        live();
        endStep(this.openSteps, 'decode', now());
        const showStarted = now();
        beginStep(this.openSteps, 'show', showStarted);
        this.session = session;
        this.camera = cameraInfo(session.meta);
        const looks = await looksP;
        live();
        this.defaults = photoDefaults({ make: session.meta.make, sim: this.fujiSim, looksReady: !!looks });
        const saved = stored ?? cloneRecipe(this.defaults.recipe);
        if (!stored) {
          this.recipe = draft ? withDraft(saved, draft) : cloneRecipe(saved);
          this.savedJson = editableJson(saved);
        }

        this.renderer = renderer;
        this.renderer.setSource(session.half, this.camera);
        this.renderer.setProfileLooks(looks ?? {});
        this.renderer.setPhotoDefaults(this.defaults.recipe);
        this.ai.reset();
        this.startHistory(saved, stored ? 'Open (saved edit)' : 'Open', draft);
        this.loadLens(bytes);
        this.syncHistory();
        this.status = 'ready';
        done = startMeasure('first render');
        this.renderNow();
        done();
        endStep(this.openSteps, 'show', now());
        this.learnOpen(original, { camera, bytes: bytes.length, decodeMs, cachedMs, showMs: now() - showStarted });
        if (!cached) this.keepDecoded(asset.checksum, session);
      } catch (e) {
        if (renderer && this.renderer !== renderer) renderer.dispose();
        throw e;
      }
      // Full resolution is needed for saving and 1:1 zoom; start it in the background.
      this.startFullDecode();
      if (!stored && !draft) this.checkSidecar(asset.id);
      this.offerFujiLooks();
    }
  }

  private estimateStep(id: OpenStepId, ms: number): void {
    const s = this.openSteps.find((x) => x.id === id);
    if (s && s.startedAt === null) s.estimateMs = ms;
  }

  /** Shows where the original comes from and how much of it has arrived (at most every 50 ms). */
  private originalProgress(p: DownloadProgress): void {
    const s = this.openSteps.find((x) => x.id === 'original');
    if (!s || s.endedAt !== null) return;
    if (p.from === 'cache') {
      s.label = OPEN_LABELS.originalCached;
      s.estimateMs = estimateReadMs(this.openTimes, p.total);
      return;
    }
    const t = performance.now();
    const last = p.total > 0 && p.received >= p.total;
    if (!last && t - this.lastBytesShown < 50) return;
    this.lastBytesShown = t;
    const total = p.total || this.fileBytes;
    s.label = OPEN_LABELS.download;
    s.bytes = { received: p.received, total };
    if (total) s.estimateMs = estimateDownloadMs(this.openTimes, total);
  }

  /** Adds this open's step times to the averages the next open's estimates come from. */
  private learnOpen(original: { from: DownloadProgress['from'] | null; endedAt: number }, sample: Omit<OpenSample, 'infoMs' | 'download' | 'read'>): void {
    const info = this.openSteps.find((x) => x.id === 'info');
    const orig = this.openSteps.find((x) => x.id === 'original');
    const s: OpenSample = { ...sample };
    if (info?.startedAt != null && info.endedAt != null) s.infoMs = info.endedAt - info.startedAt;
    if (orig?.startedAt != null && original.endedAt > orig.startedAt) {
      const part = { bytes: sample.bytes, ms: original.endedAt - orig.startedAt };
      if (original.from === 'network') s.download = part;
      else if (original.from === 'cache') s.read = part;
    }
    // Read again: another tab may have added an open since this one started.
    this.openTimes = recordOpen(loadOpenTimes(), s);
    saveOpenTimes(this.openTimes);
  }

  /** Keeps the half-size image for the next open of this photo, once the browser has a moment. */
  private keepDecoded(checksum: string, session: RawSession): void {
    this.decodedKept = new Promise<void>((resolve) => {
      const write = () => {
        const done = startMeasure('decoded cache write');
        void writeDecoded(checksum, session.meta, session.half).then(done).finally(resolve);
      };
      if (typeof requestIdleCallback === 'function') requestIdleCallback(write, { timeout: 2000 });
      else setTimeout(write, 500);
    });
  }

  /**
   * Gets the photos around this one ready to open, nearest first (`ids`: the filmstrip's next and
   * previous, then two either way; no further). Their originals download now, one at a time; they
   * are decoded at half size once `decode` is true (the open photo's full-resolution decode is
   * done: two decodes at once would slow it down and need more memory).
   */
  prefetch(ids: string[], decode: boolean): void {
    this.prefetchWanted = ids.filter((id) => id !== this.asset?.id).slice(0, 4);
    if (decode) this.prefetchMayDecode = true;
    if (!canPrefetch()) return;
    this.fetchMore();
    this.decodeNeighbours();
  }

  private fetchMore(): void {
    if (this.fetching) return;
    this.fetching = true;
    void this.fetchNeighbours().finally(() => {
      this.fetching = false;
      // Photos asked for while the last one was finishing.
      if (this.prefetchWanted.some((x) => !this.prefetchTried.has(x))) this.fetchMore();
    });
  }

  /** Waits while a save runs: it renders at full size and needs the memory and the processor. */
  private async notWhileSaving(): Promise<void> {
    while (this.saving) await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  private async fetchNeighbours(): Promise<void> {
    await this.decodedKept;
    for (;;) {
      const id = this.prefetchWanted.find((x) => !this.prefetchTried.has(x));
      if (!id) return;
      this.prefetchTried.add(id);
      await this.notWhileSaving();
      const done = startMeasure('prefetch download');
      const signal = this.prefetchStop.signal;
      try {
        const checksum = await fetchNeighbour(id, signal);
        if (checksum) {
          done();
          this.prefetchFetched.set(id, checksum);
          this.decodeNeighbours();
        }
      } catch (e) {
        if (!signal.aborted) console.warn('Could not download a photo nearby ahead of time', e);
      }
    }
  }

  /** Decodes the fetched photos, nearest first, one at a time (once that is allowed). */
  private decodeNeighbours(): void {
    if (this.decoding || !this.prefetchMayDecode) return;
    this.decoding = true;
    void (async () => {
      for (;;) {
        const id = this.prefetchWanted.find((x) => this.prefetchFetched.has(x) && !this.prefetchDecodeTried.has(x));
        if (!id) return;
        this.prefetchDecodeTried.add(id);
        await this.notWhileSaving();
        const done = startMeasure('prefetch');
        const signal = this.prefetchStop.signal;
        try {
          if (await decodeNeighbour(this.prefetchFetched.get(id)!, signal)) done();
        } catch (e) {
          if (!signal.aborted) console.warn('Could not decode a photo nearby ahead of time', e);
        }
      }
    })().finally(() => {
      this.decoding = false;
      if (this.prefetchWanted.some((x) => this.prefetchFetched.has(x) && !this.prefetchDecodeTried.has(x))) this.decodeNeighbours();
    });
  }

  /** Offers the Fujifilm film looks when the photo or its saved edit would use them. */
  private offerFujiLooks(): void {
    const recipe = $state.snapshot(this.recipe) as Recipe;
    if (this.renderer?.profileMissing(recipe)) {
      this.fujiOffer = { reason: 'edit', label: profileInfo(recipe.profile).label };
      return;
    }
    const wanted = this.defaults.wanted;
    if (!wanted || this.storedEdit || this.readOnly) return;
    // Agreed to before (the browser dropped them since): fetch them again without asking.
    if (fujiLooks.consent === 'yes') void this.acceptFujiOffer();
    else if (fujiLooks.consent === 'ask') this.fujiOffer = { reason: 'camera', label: this.defaults.simLabel ?? profileInfo(wanted).label };
  }

  /** Downloads the Fujifilm film looks (the user agreed) and starts from the in-camera one. */
  async acceptFujiOffer(): Promise<void> {
    this.fujiOffer = null;
    const busy = 'Downloading the Fujifilm film looks…';
    this.notice = busy;
    try {
      this.looksArrived(await fujiLooks.download());
      if (this.notice === busy) this.notice = null;
    } catch {
      this.notice = fujiLooks.error;
    }
  }

  /** The Download button next to a film look that isn't here (asks first, like picking one). */
  async downloadFujiLooks(): Promise<void> {
    const looks = await fujiLooks.request();
    if (looks) this.looksArrived(looks);
    else this.notice = fujiLooks.error ?? FUJI_DECLINED;
  }

  dismissFujiOffer(never = false): void {
    this.fujiOffer = null;
    if (never) fujiLooks.never();
  }

  /** The film looks are here: render with them, and start an untouched photo from its in-camera look. */
  private looksArrived(looks: ProfileLooks): void {
    if (!this.renderer || !this.session) return;
    this.renderer.setProfileLooks(looks);
    this.fujiOffer = null;
    const wanted = this.defaults.wanted;
    this.defaults = photoDefaults({ make: this.session.meta.make, sim: this.fujiSim, looksReady: true });
    this.renderer.setPhotoDefaults(this.defaults.recipe);
    const untouched = !this.storedEdit && !this.dirty && this.historySteps.length <= 1;
    if (wanted && untouched && !this.readOnly) {
      this.recipe = cloneRecipe(this.defaults.recipe);
      this.savedJson = editableJson(this.recipe);
      this.history.reset($state.snapshot(this.recipe) as Recipe, 'Open');
      this.syncHistory();
    }
    this.autoSamples = null;
    this.requestRender();
  }

  /**
   * The picture that stands in for the photo while it loads, the first of:
   * - the picture of its draft (drafts/), when it has one;
   * - what the editor showed last time, if the saved edit is still the same (keepViewIfPlain);
   * - the saved JPEG's preview in Immich, for a photo with a saved edit;
   * - Immich's preview of the RAW (its own conversion: brighter, more saturated, without the edit).
   * The filmstrip's look of it (switchPhoto) may show already: the same picture isn't fetched again.
   */
  private async showPreview(asset: AssetResponseDto, stored: Recipe | null, viewP: Promise<KeptView | null>, gen: number, draft: Draft | null): Promise<void> {
    const show = (b: Blob, source: string) => {
      if (gen !== this.photoGen || this.status === 'ready' || source === this.previewSource) return;
      if (this.previewUrl) URL.revokeObjectURL(this.previewUrl);
      this.previewUrl = URL.createObjectURL(b);
      this.previewSource = source;
    };
    if (draft?.look) return show(draft.look, draftSource(draft.recipe));
    const view = await viewP;
    const shows = viewShows(stored);
    if (view && view.shows === shows) return show(view.image, viewSource(shows));
    for (const id of [stored?.render?.assetId, asset.id]) {
      if (!id || gen !== this.photoGen) continue;
      if (this.previewSource === previewSource(id)) return;
      const b = await fetch(apiUrl(`/assets/${id}/thumbnail?size=preview`), { headers: authHeaders(), credentials: 'same-origin' })
        .then((r) => (r.ok ? r.blob() : null))
        .catch(() => null);
      // The saved JPEG may be gone (deleted in Immich): then the RAW's preview.
      if (b) return show(b, previewSource(id));
    }
  }

  /**
   * Keeps what the photo looks like for the loading screen of its next open. Called right after
   * a render, while the canvas still holds it (it is cleared once shown). Only a plain view of the
   * saved edit counts, with the lens profile and any AI masks in place, and only once per state.
   */
  private keepViewIfPlain(): void {
    const a = this.asset;
    const canvas = this.canvas;
    if (!a || !canvas || this.dirty || !this.plainView()) return;
    const key = `${a.checksum}|${this.savedJson}`;
    if (key === this.viewKept) return;
    this.viewKept = key;
    const shows = this.storedEdit || this.savedRenderId ? this.savedJson : 'unedited';
    const checksum = a.checksum;
    canvas.toBlob((b) => b && void keepView(checksum, shows, b), 'image/jpeg', 0.85);
  }

  /** The canvas shows the whole photo as edited: no before view, overlay, zoom, or work still to come in. */
  private plainView(): boolean {
    if (this.previewRecipe || this.before || this.clipping || this.maskView !== 'none') return false;
    if (this.overlayMask || this.wholeView || this.zoom.on) return false;
    return !this.lensInfo.searching && !Object.values(this.ai.status).some((s) => s.state === 'working');
  }

  // ---------------------------------------------------------------- drafts

  /** Writes the open edit's draft now (leaving it, or the page); resolves once it is stored. */
  keepDraft(): Promise<void> {
    return this.draftKeeper.keep();
  }

  /** Back to the saved edit (or the photo's defaults): the draft goes. */
  discardDraft(): void {
    this.draftConflict = null;
    if (this.dirty) {
      this.applyEditable(JSON.parse(this.savedJson) as ReturnType<typeof editable>);
      this.pendingLabel = 'Discard draft';
      this.commit();
    }
    void this.draftKeeper.drop();
  }

  /** The draft stays, though the saved edit changed since it was made (draftConflict). */
  keepOlderDraft(): void {
    this.draftConflict = null;
    void this.draftKeeper.rewrite();
  }

  /**
   * Sync Settings: the chosen groups of the open edit's settings go onto these other photos as
   * drafts (drafts/sync.ts); Save drafts puts them in Immich.
   */
  async syncSettings(assetIds: readonly string[], groups: GroupId[]): Promise<void> {
    const open = this.asset?.id;
    const targets = assetIds.filter((id) => id !== open);
    if (!targets.length || !groups.length || this.readOnly) return;
    this.commit();
    const patch = pickGroups($state.snapshot(this.recipe) as Recipe, groups);
    const deps = { draft: (id: string) => drafts.get(id, null), put: (d: Omit<Draft, 'key'>) => drafts.put(d) };
    let synced = 0;
    const failed: string[] = [];
    for (const id of targets) {
      try {
        await syncInto(id, patch, deps);
        looks.forget(id);
        synced++;
      } catch (e) {
        failed.push(errorMessage(e));
      }
    }
    const photos = (n: number) => `${n} ${n === 1 ? 'photo' : 'photos'}`;
    this.notice = `Settings synced to ${photos(synced)} as drafts; Save drafts in the filmstrip puts them in Immich.${failed.length ? ` ${photos(failed.length)} failed: ${failed[0]}` : ''}`;
  }

  /**
   * Saves the drafts of these photos to Immich: the open photo's with save(), the others one at a
   * time like an album export, while the editor waits (each needs a full-resolution decode).
   * True when every one of them was saved.
   */
  async saveDrafts(assetIds: ReadonlySet<string>): Promise<boolean> {
    if (this.saving) return false;
    // A photo still opening: once it is open (or failed), so its decode and the saves don't overlap.
    while (this.status === 'loading') await new Promise((resolve) => setTimeout(resolve, 250));
    await this.keepDraft();
    const open = this.status === 'ready' ? this.asset?.id : undefined;
    if (open && assetIds.has(open) && this.dirty && !this.readOnly && !(await this.save())) return false;
    const others = (await drafts.list()).filter((d) => assetIds.has(d.assetId) && !(d.assetId === open && d.copyId === this.copyId));
    if (!others.length) return true;
    const stop = new AbortController();
    const cancel = () => stop.abort();
    const total = others.length;
    let at = 0;
    let name = '';
    const show = (label: string, fraction: number) => (this.saving = { label: `Saving drafts, ${at + 1} of ${total}: ${name}${label ? ` (${label})` : ''}`, fraction: (at + fraction) / total, cancel });
    show('', 0);
    const raws = new RawRenderer();
    try {
      // Never two big decodes at once: the open photo's full resolution and the neighbours' first.
      while (this.fullStatus === 'decoding' || this.decoding) await new Promise((resolve) => setTimeout(resolve, 500));
      const preset = structuredClone($state.snapshot(this.exportSettings.presets[this.exportSettings.immichPreset]) as ExportPreset);
      const settings = $state.snapshot(this.exportSettings.save) as SaveSettings;
      const result = await saveEach(
        others,
        async (draft, i) => {
          at = i;
          name = '';
          const warnings = await saveDraftPhoto(draft, {
            raws,
            preset,
            settings,
            copyright: this.exportSettings.copyright,
            fallbackOwner: this.ownerName(),
            onStep: (s, f, n) => {
              name = n;
              show(STEP_LABEL[s as keyof typeof STEP_LABEL] ?? '', s === 'download' || s === 'queued' ? 0 : f);
            },
          });
          await drafts.remove(draft.assetId, draft.copyId);
          editStates.forget(draft.assetId);
          looks.forget(draft.assetId);
          return warnings;
        },
        stop.signal,
      );
      this.notice = describeDraftsSaved(result);
      return !result.cancelled && !result.failed.length;
    } finally {
      raws.dispose();
      this.saving = null;
    }
  }

  private startFullDecode(): void {
    if (!this.session || this.fullStatus === 'decoding' || this.fullStatus === 'ready') return;
    this.fullStatus = 'decoding';
    const session = this.session;
    const started = performance.now();
    // A linear DNG's full image comes with the half-size decode: nothing to time.
    const timed = !this.session.fullStarted;
    this.fullEta = { startedAt: started, estimateMs: estimateFullMs(this.openTimes, this.cameraKey, this.fileBytes) };
    session
      .full()
      .then((img) => {
        // Another photo is open now (this decode was stopped, or finished just before).
        if (this.session !== session) return;
        this.fullImage = img;
        this.fullStatus = 'ready';
        this.fullEta = null;
        if (timed) {
          this.openTimes = recordFull(loadOpenTimes(), this.cameraKey, this.fileBytes, performance.now() - started);
          saveOpenTimes(this.openTimes);
        }
        if (this.notice === HALF_SIZE_NOTICE) this.notice = null;
        // Fringes are a pixel or two wide: measure them again at full resolution.
        this.measureCA();
        if (this.zoom.on) this.requestRender();
      })
      .catch((e) => {
        if (this.session !== session) return;
        console.error('Full-resolution decode failed', e);
        this.fullStatus = 'error';
        this.fullEta = null;
        if (this.notice === HALF_SIZE_NOTICE) this.notice = FULL_FAILED_NOTICE;
      });
  }

  /** Offers the RAW's Lightroom settings (XMP sidecar), if Immich has one with crs: data. */
  private async checkSidecar(assetId: string): Promise<void> {
    try {
      const files = await searchAssetFiles({ assetId, $type: AssetFileType.Sidecar });
      const file = files[0];
      if (!file) return;
      const text = await (await downloadAssetFile({ id: file.id })).text();
      // Another photo was opened meanwhile.
      if (this.asset?.id !== assetId) return;
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
    this.draftKeeper.changed();
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
      this.ai.sync(recipe);
      const opts = { before: this.before, clipping: this.clipping, maskView: this.maskView, maskOverlay: this.overlayMask };
      if (this.zoom.on && !this.wholeView && this.session) {
        const vp = this.viewport;
        // Up to 50 % the half-size decode has a pixel for every screen pixel, and it is a
        // quarter of the full image to upload. (Further out the renderer uses its preview.)
        const source = this.zoom.scale <= 0.5 || !this.fullImage ? this.session.half : this.fullImage;
        renderer.renderZoom(recipe, source, {
          cx: this.zoom.cx,
          cy: this.zoom.cy,
          scale: this.zoom.scale,
          width: Math.max(1, Math.round(vp.width * vp.dpr)),
          height: Math.max(1, Math.round(vp.height * vp.dpr)),
        }, opts);
      } else {
        const f = renderer.render(recipe, { mode: this.wholeView ? 'crop' : 'edit', ...opts });
        if (f.width !== this.frame.width || f.height !== this.frame.height) this.frame = { width: f.width, height: f.height };
        this.keepViewIfPlain();
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
      if (this.zoom.on && !this.wholeView) r.render(this.currentRecipe(), { mode: 'edit', before: this.before, present: false });
      else if (this.overlayMask) r.render(this.currentRecipe(), { mode: 'edit', before: this.before, present: false });
      if (this.scope === 'histogram') {
        this.histogram = r.histogram();
      } else {
        const img = r.scopeImage(SCOPE_SAMPLE_WIDTH[this.scope]);
        this.scopeData = img && scopeOf(this.scope, img);
      }
    }, wait);
  }

  setScope(kind: ScopeKind): void {
    if (this.scope === kind) return;
    this.scope = kind;
    this.scopeData = null;
    storageSet(SCOPE_KEY, kind);
    this.scheduleHistogram();
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
      whitePoint: this.renderer.profileWhitePoint(recipe),
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
    const key = canonicalJson({ ...editable(recipe), basic: undefined, toneCurve: undefined, detail: undefined, looks: fujiLooks.version });
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

  async setProfile(id: ProfileId): Promise<void> {
    if (this.readOnlyGuard()) return;
    if (profileInfo(id).download && !fujiLooks.looks) {
      const looks = await fujiLooks.request();
      if (!looks) {
        this.notice = fujiLooks.error ?? FUJI_DECLINED;
        return;
      }
      this.looksArrived(looks);
    }
    this.recipe.profile = id;
    // The offer was about the edit's film look, which is gone now.
    if (this.fujiOffer?.reason === 'edit' && !profileInfo(id).download) this.fujiOffer = null;
    this.changed(true, `Profile: ${profileInfo(id).label}`);
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
    const fresh = cloneRecipe(this.defaults.recipe);
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

  private async storeSnapshots(): Promise<void> {
    if (!this.asset || this.readOnly) return;
    try {
      await updateAssetMetadata({
        id: this.asset.id,
        assetMetadataUpsertDto: { items: [{ key: historyKeyFor(this.copyId), value: { schema: 1, snapshots: $state.snapshot(this.snapshots) } }] },
      });
    } catch (e) {
      this.notice = `Couldn't store snapshots: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  createSnapshot(name: string): void {
    if (this.readOnlyGuard()) return;
    this.snapshots = [
      { id: newId(), name: name.trim() || new Date().toLocaleString(), createdAt: new Date().toISOString(), state: editableJson($state.snapshot(this.recipe) as Recipe) },
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
    this.lensQuery = lensQueryFor(session.meta, this.asset?.exifInfo, cam);
    this.lensInfo = { ...this.lensInfo, searching: true, lensName: this.lensQuery.lens };
    this.measureCA();
    try {
      this.dngLens = dngLensFor(this.asset?.originalFileName, bytes, cam);
    } catch (e) {
      console.warn('Lens profile lookup failed', e);
    }
    this.lensDb = await loadLensDb();
    if (this.session !== session) return;
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
    const { profile, label, auto, chosen } = pickLensProfile(db, q, this.dngLens, id);
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

  /** Mask shown in red: the selected one while its shape is edited (and the overlay is on). */
  get overlayMask(): string | null {
    return this.tool === 'mask' && this.maskOverlay && this.maskEditing === 'shape' ? this.maskSel.mask : null;
  }

  /** The mask's shape is being edited: show the overlay (if wanted). */
  private editShape(): void {
    if (this.maskEditing === 'shape') return;
    this.maskEditing = 'shape';
    this.requestRender();
  }

  /** The mask's adjustments are being edited: hide the overlay to show the result. */
  private editAdjust(): void {
    if (this.maskEditing === 'adjust') return;
    this.maskEditing = 'adjust';
    this.requestRender();
  }

  /** A click in the panel's mask settings ('shape') or adjustments ('adjust') area. */
  setMaskEditing(mode: 'shape' | 'adjust'): void {
    if (mode === 'shape') this.editShape();
    else this.editAdjust();
  }

  selectMask(maskId: string | null, compId?: string): void {
    const m = this.mask(maskId);
    this.maskSel = { mask: m?.id ?? null, comp: compId ?? m?.components[0]?.id ?? null };
    this.maskEditing = 'shape';
    this.requestRender();
  }

  /** Room for another component (and, for a new mask, another mask)? Tells the user if not. */
  private maskRoom(newMask: boolean, ai = false): boolean {
    if (newMask && this.recipe.masks.length >= MAX_MASKS) {
      this.notice = `Up to ${MAX_MASKS} masks are supported.`;
      return false;
    }
    if (componentCount(this.recipe.masks) >= MAX_COMPONENTS) {
      this.notice = `Up to ${MAX_COMPONENTS} mask parts are supported in total.`;
      return false;
    }
    if (ai && aiCount(this.recipe.masks) >= MAX_AI) {
      this.notice = `Up to ${MAX_AI} AI mask parts are supported in total.`;
      return false;
    }
    return true;
  }

  private uniqueMaskName(base: string): string {
    const used = new Set(this.recipe.masks.map((m) => m.name));
    if (!used.has(base)) return base;
    let n = 2;
    while (used.has(`${base} ${n}`)) n++;
    return `${base} ${n}`;
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
  startMask(kind: ComponentKind | 'lasso', mode: MaskMode = 'add', maskId: string | null = null): void {
    if (kind === 'ai') return this.startAiMask('subject', mode, maskId);
    if (this.readOnlyGuard() || !this.maskRoom(!maskId)) return;
    if (this.tool !== 'mask') this.setTool('mask');
    this.aiPicker = null;
    this.editShape();
    if (kind === 'luminance') {
      this.addComponent(newComponent('luminance', maskId ? mode : 'add'), maskId);
      this.changed(true, `${maskId ? 'Add' : 'New Mask:'} ${COMPONENT_LABELS.luminance}`);
      return;
    }
    if ((kind === 'brush' || kind === 'polygon' || kind === 'lasso') && brushCount(this.recipe.masks) >= MAX_BRUSHES) {
      this.notice = `Up to ${MAX_BRUSHES} brush, polygon and lasso parts are supported in total.`;
      return;
    }
    this.maskDraft = { kind, mode: maskId ? mode : 'add', maskId, ...(kind === 'polygon' ? { points: [] } : {}) };
  }

  cancelMaskDraft(): void {
    this.maskDraft = null;
    this.aiPicker = null;
  }

  // ---- polygon and lasso

  /** Polygon being drawn: a corner at mask-frame point p. */
  addPolygonPoint(p: [number, number]): void {
    const d = this.maskDraft;
    if (d?.kind !== 'polygon' || this.readOnlyGuard()) return;
    const points = d.points ?? [];
    if (points.length >= MAX_POLYGON_POINTS * 2) {
      this.notice = `Up to ${MAX_POLYGON_POINTS} corners per polygon.`;
      return;
    }
    this.maskDraft = { ...d, points: [...points, q5(p[0]), q5(p[1])] };
  }

  /** Polygon being drawn: takes back the last corner (Backspace). */
  removePolygonPoint(): void {
    const d = this.maskDraft;
    if (d?.kind !== 'polygon' || !d.points?.length) return;
    this.maskDraft = { ...d, points: d.points.slice(0, -2) };
  }

  /** Polygon being drawn: closes it and adds it (needs three corners). */
  closePolygon(): boolean {
    const d = this.maskDraft;
    if (d?.kind !== 'polygon' || (d.points?.length ?? 0) < 6) return false;
    return this.addPolygon(d.points!, false);
  }

  /** Lasso: the outline dragged on the photo (mask frame), closed and simplified. */
  drawLasso(points: number[]): boolean {
    if (this.maskDraft?.kind !== 'lasso') return false;
    // Corners closer than half a brush-map texel to the outline add nothing.
    return this.addPolygon(simplifyPolygon(points, 0.5 / 2048, MAX_POLYGON_POINTS), true);
  }

  private addPolygon(points: number[], freehand: boolean): boolean {
    const d = this.maskDraft;
    if (!d || this.readOnlyGuard() || points.length < 6 || !this.maskRoom(!d.maskId)) return false;
    this.maskDraft = null;
    const c = newComponent('polygon', d.mode) as PolygonComponent;
    c.points = points.map(q5);
    if (freehand) c.freehand = true;
    this.addComponent(c, d.maskId);
    this.changed(true, `${d.maskId ? MODE_VERB[d.mode] : 'New Mask:'} ${partLabel(c)}`);
    return true;
  }

  // ---- AI masks

  /**
   * Lightroom's AI masks. Subject, Sky and Background are added right away; People and
   * Landscape first show their choices; an object is pointed out on the photo.
   */
  startAiMask(target: AiTarget, mode: MaskMode = 'add', maskId: string | null = null): void {
    if (this.readOnlyGuard() || !this.maskRoom(!maskId, true)) return;
    if (this.tool !== 'mask') this.setTool('mask');
    const m = maskId ? mode : 'add';
    this.maskDraft = null;
    this.aiPicker = null;
    this.editShape();
    if (target === 'people' || target === 'landscape') {
      this.aiPicker = { target, mode: m, maskId, parts: ['person'], classes: ['sky'], who: -1 };
      if (target === 'people') void this.ai.findPeople();
      return;
    }
    if (target === 'object') {
      this.maskDraft = { kind: 'object', mode: m, maskId };
      return;
    }
    this.addAiComponent(newAiComponent(target, m), maskId);
  }

  setAiPicker(patch: Partial<Pick<AiPicker, 'parts' | 'classes' | 'who'>>): void {
    if (this.aiPicker) this.aiPicker = { ...this.aiPicker, ...patch };
  }

  /** Makes the People or Landscape mask chosen in the picker. */
  confirmAiPicker(): void {
    const p = this.aiPicker;
    if (!p || this.readOnlyGuard()) return;
    if (p.target === 'landscape' && !p.classes.length) return;
    if (p.target === 'people' && !p.parts.length) return;
    this.aiPicker = null;
    const person = this.personPoint(p.who);
    this.addAiComponent(newAiComponent(p.target, p.mode, p.target === 'people' ? { parts: p.parts, person } : { classes: p.classes }), p.maskId);
  }

  /** Mask-frame point of person `index` of ai.people; null = everyone. */
  private personPoint(index: number): { x: number; y: number } | null {
    const who = index >= 0 ? this.ai.people?.[index] : null;
    const photo = who ? this.ai.current() : null;
    return who && photo ? imageToMask(photo, who.at) : null;
  }

  private addAiComponent(c: AiComponent, maskId: string | null): void {
    if (!this.maskRoom(!maskId, true)) return;
    this.addComponent(c, maskId, this.uniqueMaskName(aiLabel(c)));
    this.changed(true, `${maskId ? MODE_VERB[c.mode] : 'New Mask:'} ${aiLabel(c)}`);
  }

  /** Changes what an AI part selects (People parts and who, Landscape categories). */
  setAiComponent(maskId: string, compId: string, patch: { parts?: PersonPart[]; classes?: LandscapeClass[]; who?: number }): void {
    const m = this.mask(maskId);
    const c = m?.components.find((x) => x.id === compId);
    if (!m || !c || c.kind !== 'ai' || this.readOnlyGuard()) return;
    const next: Partial<AiComponent> = {};
    if (patch.parts) {
      if (!patch.parts.length) return;
      next.parts = patch.parts;
    }
    if (patch.classes) {
      if (!patch.classes.length) return;
      next.classes = patch.classes;
    }
    if (patch.who !== undefined) next.person = this.personPoint(patch.who);
    this.updateComponent(maskId, compId, next, true, `${m.name}: ${aiLabel({ ...c, ...next })}`);
  }

  /** Objects: the box dragged around it, or the point clicked (mask frame). */
  drawObject(box: [number, number, number, number] | null, point: [number, number] | null): void {
    const d = this.maskDraft;
    if (!d || d.kind !== 'object' || this.readOnlyGuard()) return;
    this.maskDraft = null;
    const c = box
      ? newAiComponent('object', d.mode, { box: [q5(Math.min(box[0], box[2])), q5(Math.min(box[1], box[3])), q5(Math.max(box[0], box[2])), q5(Math.max(box[1], box[3]))] })
      : point
        ? newAiComponent('object', d.mode, { points: [q5(point[0]), q5(point[1])] })
        : null;
    if (c) this.addAiComponent(c, d.maskId);
  }

  /** Shift+click with a clicked object selected: one more point on the object. */
  addObjectPoint(p: [number, number]): boolean {
    const m = this.selectedMask;
    const c = this.selectedComponent;
    if (!m || !c || c.kind !== 'ai' || c.target !== 'object' || c.box || this.readOnlyGuard()) return false;
    const points = c.points ?? [];
    if (points.length >= MAX_OBJECT_POINTS * 2) {
      this.notice = `Up to ${MAX_OBJECT_POINTS} points per object.`;
      return true;
    }
    this.updateComponent(m.id, c.id, { points: [...points, q5(p[0]), q5(p[1])] }, true, `${m.name}: Add Object Point`);
    return true;
  }

  private addComponent(c: MaskComponent, maskId: string | null, name?: string): void {
    this.editShape();
    const target = this.mask(maskId);
    if (target) {
      target.components.push(c);
      this.maskSel = { mask: target.id, comp: c.id };
    } else {
      const m = newMask(name ?? this.nextMaskName(), c);
      this.recipe.masks.push(m);
      this.maskSel = { mask: m.id, comp: c.id };
    }
  }

  /** Starts drawing the armed gradient at mask-frame point p; returns the new component's id. */
  beginMaskDraw(p: [number, number]): string | null {
    const d = this.maskDraft;
    // Objects are pointed out with drawObject; polygons and lassos are drawn with their own calls.
    if (!d || d.kind === 'object' || d.kind === 'polygon' || d.kind === 'lasso' || this.readOnlyGuard()) return null;
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
    this.editShape();
    Object.assign(c, patch);
    if (c.kind === 'radial') {
      c.rx = Math.min(4, Math.max(1e-3, c.rx));
      c.ry = Math.min(4, Math.max(1e-3, c.ry));
      c.angle = ((c.angle % 360) + 360) % 360;
    } else if (c.kind === 'luminance' && c.lo > c.hi) {
      [c.lo, c.hi] = [c.hi, c.lo];
    }
    this.changed(commit, label ?? `${m.name}: Edit ${partLabel(c)}`);
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
    this.editShape();
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
    this.editShape();
    c.samples = add ? [...c.samples, sample] : [sample];
    this.changed(false, `${m.name}: ${add ? 'Add Color Sample' : 'Color Sample'}`);
    return c.samples.length - 1;
  }

  removeColorSample(index: number): void {
    const m = this.selectedMask;
    const c = this.selectedComponent;
    if (this.readOnlyGuard() || !m || !c || c.kind !== 'color') return;
    this.editShape();
    c.samples = c.samples.filter((_, i) => i !== index);
    this.changed(true, `${m.name}: Remove Color Sample`);
  }

  /** Sets one of the selected mask's adjustment sliders (or Amount). */
  setMaskParam(spec: ParamSpec, value: number, commit = false): void {
    const m = this.selectedMask;
    if (!m || this.readOnlyGuard()) return;
    this.editAdjust();
    const v = clampParam(spec, value);
    setPath(m, spec.path, v);
    this.changed(commit, `${m.name}: ${spec.label} ${formatParam(spec, v)}`);
  }

  /**
   * Edge refinement (Offset, Feather, Smooth; spec paths "edge.*") of part `compId` of a
   * mask, or of the whole mask when compId is null. A part keeps a refinement only while it
   * does something.
   */
  setEdge(maskId: string, compId: string | null, spec: ParamSpec, value: number, commit = false): void {
    const m = this.mask(maskId);
    const c = compId ? m?.components.find((x) => x.id === compId) : null;
    if (!m || (compId && !c) || this.readOnlyGuard()) return;
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
    this.changed(commit, `${m.name}: ${c ? `${partLabel(c)} ` : ''}${spec.label} ${formatParam(spec, v)}`);
  }

  maskValue(spec: ParamSpec): number {
    const m = this.selectedMask;
    return m ? (getPath(m, spec.path) as number) : spec.default;
  }

  resetMaskAdjust(): void {
    const m = this.selectedMask;
    if (!m || this.readOnlyGuard()) return;
    this.editAdjust();
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
    this.editShape();
    this.changed(true, `${m.name}: Remove ${c ? partLabel(c) : 'part'}`);
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
    if (c) this.updateComponent(maskId, compId, { invert: !c.invert }, true, `${this.mask(maskId)!.name}: Invert ${partLabel(c)}`);
  }

  /** The Overlay checkbox: wanted or not (switched on, it shows right away). */
  setMaskOverlay(on: boolean): void {
    this.maskOverlay = on;
    if (on) this.maskEditing = 'shape';
    this.requestRender();
  }

  /** O: an overlay that is wanted but hidden while adjusting comes back; otherwise on/off. */
  toggleMaskOverlay(): void {
    if (this.maskOverlay && this.maskEditing === 'adjust') {
      this.maskEditing = 'shape';
      this.requestRender();
    } else this.setMaskOverlay(!this.maskOverlay);
  }

  /** Point of the photo view (0..1) -> mask frame, and back. */
  viewToMask(x: number, y: number): [number, number] | null {
    return this.renderer?.viewToMask(x, y) ?? null;
  }

  /** Point of the view (0..1) -> frame coordinates (0..1) of the cropped photo. */
  viewToFrame(x: number, y: number): [number, number] | null {
    return this.renderer?.previewToFrame(x, y) ?? null;
  }

  /** Frame coordinates (0..1) -> point of the view (0..1, may lie outside). */
  frameToView(x: number, y: number): [number, number] | null {
    return this.renderer?.frameToPreview(x, y) ?? null;
  }

  maskToView(p: [number, number]): [number, number] | null {
    return this.renderer?.maskToView(p[0], p[1]) ?? null;
  }

  // ---------------------------------------------------------------- view

  setTool(tool: Tool): void {
    // The upscale preview changes nothing, so it works on photos that are only shared with you.
    if (tool !== 'edit' && tool !== 'upscale' && this.readOnly) return;
    this.endTargeted();
    if (tool !== 'mask') {
      this.maskDraft = null;
      this.aiPicker = null;
    }
    if (tool === 'mask' && !this.maskSel.mask && this.recipe.masks.length) {
      const last = this.recipe.masks[this.recipe.masks.length - 1]!;
      this.maskSel = { mask: last.id, comp: last.components[0]?.id ?? null };
    }
    this.tool = tool;
    if (tool !== 'upright') this.uprightSel = null;
    if (this.wholeView) {
      this.before = false;
      this.setZoom(false);
    }
    this.requestRender();
  }

  /** The view shows the whole transformed photo, not the crop (Crop, Guided Upright); no zoom there. */
  get wholeView(): boolean {
    return this.tool === 'crop' || this.tool === 'upright';
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
    this.noteHalfSize();
    this.requestRender();
  }

  /**
   * Zooms by `factor` (Ctrl + mouse wheel, trackpad pinch), keeping the photo point under the
   * cursor in place: (x, y) is the cursor in the current view (0..1), `at` the same point in CSS
   * pixels from the stage's top left. Zooming out past the fitted size returns to fit.
   */
  zoomBy(factor: number, x: number, y: number, at: [number, number]): void {
    const anchor = this.zoomAnchor(x, y);
    if (anchor) this.zoomFrom(anchor, factor, at);
  }

  /**
   * The zoom scale now (the fitted one when not zoomed) and the photo point (frame coordinates
   * 0..1) at view point (x, y) (0..1). A touch pinch keeps this from its start, because during the
   * gesture the last render lags behind the fingers.
   */
  zoomAnchor(x: number, y: number): { scale: number; p: [number, number] } | null {
    const r = this.renderer;
    if (!r || !this.camera || this.wholeView || this.status !== 'ready') return null;
    const frame = r.frameFor(this.recipe, 'edit', this.camera.fullWidth, this.camera.fullHeight);
    return { scale: this.zoom.on ? this.zoom.scale : fitScale(frame, this.viewport), p: r.previewToFrame(x, y) ?? [0.5, 0.5] };
  }

  /**
   * Zooms to `anchor.scale * factor` with the anchor's photo point under the stage point `at`
   * (CSS pixels from the stage's top left). At or below the fitted size it returns to fit.
   */
  zoomFrom(anchor: { scale: number; p: [number, number] }, factor: number, at: [number, number]): void {
    const r = this.renderer;
    if (!r || !this.camera || this.wholeView || this.status !== 'ready') return;
    const frame = r.frameFor(this.recipe, 'edit', this.camera.fullWidth, this.camera.fullHeight);
    const fit = fitScale(frame, this.viewport);
    const current = this.zoom.on ? this.zoom.scale : fit;
    const scale = nextScale(anchor.scale, factor, fit);
    if (scale === null) return this.setZoom(false);
    const [cx, cy] = anchoredCentre(anchor.p, at, scale, frame, this.viewport);
    this.zoom = { on: true, cx, cy, scale };
    this.clampZoom();
    if (scale > 0.5 && current <= 0.5) this.noteHalfSize();
    this.requestRender();
  }

  /** Says so when a zoomed view has to make do with the half-size decode. */
  private noteHalfSize(): void {
    if (this.fullImage) return;
    if (this.fullStatus === 'decoding') this.notice = HALF_SIZE_NOTICE;
    else if (this.fullStatus === 'error') this.notice = FULL_FAILED_NOTICE;
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
    return transformInverse(t, w, h, this.uprightNow());
  }

  /** Guided Upright's correction for the current guides (null: none, or guides that ask too much). */
  private uprightNow(): Affine | null {
    const r = this.renderer;
    if (!r || !this.camera) return null;
    return uprightMatrix(this.recipe.transform, totalTurns(this.camera.flip, this.recipe.crop), r.proxyWidth, r.proxyHeight);
  }

  // ---- Guided Upright

  /** The selected guide (Delete removes it). */
  uprightSel = $state<number | null>(null);

  /** Guided Upright's guides, [x0, y0, x1, y1] in the mask frame. */
  get uprightGuides(): [number, number, number, number][] {
    return this.recipe.transform.upright?.guides ?? [];
  }

  /** There are guides, but they would turn the photo too far, so they do nothing. */
  get uprightFailed(): boolean {
    void this.viewVersion;
    return this.uprightGuides.length > 0 && !this.uprightNow();
  }

  addUprightGuide(g: [number, number, number, number]): void {
    const guides = this.uprightGuides;
    if (guides.length >= MAX_UPRIGHT_GUIDES) {
      this.notice = `Up to ${MAX_UPRIGHT_GUIDES} guides.`;
      return;
    }
    if (this.setUprightGuides([...guides, g], 'Guided Upright: Add Guide')) this.uprightSel = guides.length;
  }

  moveUprightGuide(index: number, g: [number, number, number, number]): void {
    this.setUprightGuides(this.uprightGuides.map((x, i) => (i === index ? g : x)), 'Guided Upright: Move Guide');
  }

  removeUprightGuide(index: number): void {
    if (index < 0 || index >= this.uprightGuides.length) return;
    if (this.setUprightGuides(this.uprightGuides.filter((_, i) => i !== index), 'Guided Upright: Remove Guide')) this.uprightSel = null;
  }

  clearUprightGuides(): void {
    if (this.uprightGuides.length && this.setUprightGuides([], 'Guided Upright: Clear Guides')) this.uprightSel = null;
  }

  /** Sets the guides; none = Guided Upright off. With Constrain Crop the crop follows. */
  private setUprightGuides(guides: [number, number, number, number][], label: string): boolean {
    if (this.readOnlyGuard()) return false;
    const t = this.recipe.transform;
    if (!guides.length) delete t.upright;
    else t.upright = { guides: guides.map((g) => g.map(q5) as [number, number, number, number]), focal35: t.upright?.focal35 ?? this.focal35() };
    if (t.constrain) this.constrainCrop();
    this.changed(true, label);
    return true;
  }

  /** 35 mm-equivalent focal length: EXIF focal length times the camera's crop factor (Lensfun); 35 when unknown. */
  private focal35(): number {
    const q = this.lensQuery;
    const crop = this.lensDb && q ? findCamera(this.lensDb, q.cameraMake, q.cameraModel)?.camera.cropFactor : undefined;
    return q?.focalLength && crop ? Math.round(q.focalLength * crop * 10) / 10 : 35;
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

  // ---------------------------------------------------------------- virtual copies

  /** The edit's name: "Original", or the copy's. */
  get editName(): string {
    return this.copyId ? (this.copies.find((c) => c.id === this.copyId)?.name ?? 'Copy') : 'Original';
  }

  private currentCopy(): CopyMeta | null {
    const c = this.copyId ? this.copies.find((x) => x.id === this.copyId) : null;
    return c ? { id: c.id, name: c.name, index: c.index, createdAt: c.createdAt } : null;
  }

  /** Keeps `copy` in the editor's address, so a reload opens the same edit. */
  private setUrlCopy(copyId: string | null): void {
    const q = new URLSearchParams(location.search);
    if (copyId) q.set('copy', copyId);
    else q.delete('copy');
    history.replaceState(history.state, '', `${location.pathname}?${q}`);
  }

  /**
   * Puts the original edit or a virtual copy in the editor, with its draft if it has one; the photo
   * stays decoded.
   */
  private enterEdit(copyId: string | null, stored: Recipe | null, snapshots: Snapshot[], draft: Draft | null = null): void {
    this.keepHistory();
    this.endTargeted();
    this.maskDraft = null;
    this.aiPicker = null;
    this.maskSel = { mask: null, comp: null };
    this.previewRecipe = null;
    this.autoApplied = null;
    this.copyId = copyId;
    this.setUrlCopy(copyId);
    const saved = stored ?? cloneRecipe(this.defaults!.recipe);
    this.recipe = draft ? withDraft(saved, draft) : saved;
    this.savedJson = editableJson(saved);
    this.storedEdit = !!stored;
    this.snapshots = snapshots;
    this.draftConflict = draft && !draft.patch && draft.base !== savedShows(stored) ? { at: draft.updatedAt } : null;
    // "Back" may lead to any of this RAW's JPEGs; it goes to the one of the edit open last.
    if (stored?.render?.assetId) this.pastRenders.add(stored.render.assetId);
    this.startHistory(saved, stored ? 'Open (saved edit)' : 'Open', draft);
    this.syncHistory();
    this.syncLens();
    this.requestRender();
  }

  /**
   * Opens the original edit (null) or a virtual copy, with its draft if it has one. The edit being
   * left keeps its unsaved changes as a draft.
   */
  async openEdit(copyId: string | null): Promise<void> {
    const asset = this.asset;
    if (!asset || this.status !== 'ready' || copyId === this.copyId) return;
    void this.draftKeeper.keep();
    let items: { key: string; value: unknown }[];
    try {
      items = await getAssetMetadata({ id: asset.id });
    } catch (e) {
      this.error = `Couldn't open the edit: ${errorMessage(e)}`;
      return;
    }
    this.copies = copiesIn(items).map(copyInfo);
    if (copyId && !this.copies.some((c) => c.id === copyId)) {
      this.notice = 'That virtual copy no longer exists.';
      return;
    }
    const draft = this.readOnly ? null : await drafts.get(asset.id, copyId);
    this.enterEdit(copyId, storedEdit(items, copyId), snapshotsIn(items, historyKeyFor(copyId)), draft);
  }

  /**
   * Lightroom's Create Virtual Copy (Ctrl+'): a new copy holding the current settings, opened
   * right away. Unsaved changes go with it; the edit it was made from keeps its saved state.
   */
  async newVirtualCopy(): Promise<void> {
    const asset = this.asset;
    if (!asset || this.readOnlyGuard() || this.status !== 'ready' || this.saving) return;
    this.commit();
    const from = this.editName;
    const changed = this.dirty;
    const c = newCopy(this.copies, $state.snapshot(this.recipe) as Recipe);
    try {
      await writeMetadata(asset.id, copyKey(c.id), copyValue(c));
    } catch (e) {
      this.error = `Couldn't make the virtual copy: ${errorMessage(e)}`;
      return;
    }
    this.copies = [...this.copies, copyInfo(c)];
    // The unsaved changes went into the copy: the edit it was made from has no draft any more.
    void this.draftKeeper.drop();
    this.enterEdit(c.id, c.recipe, []);
    this.notice = `${c.name} made from ${changed ? `the current settings; ${from} keeps its last saved state` : from}. Save it to put its own JPEG in the stack.`;
  }

  async renameCopy(id: string, name: string): Promise<void> {
    const asset = this.asset;
    const n = name.trim().slice(0, 60);
    if (!asset || !n || this.readOnlyGuard()) return;
    try {
      const c = parseCopy(copyKey(id), await readMetadata(asset.id, copyKey(id)));
      if (!c) throw new Error('it no longer exists');
      await writeMetadata(asset.id, copyKey(id), copyValue({ ...c, name: n }));
      this.copies = this.copies.map((x) => (x.id === id ? { ...x, name: n } : x));
    } catch (e) {
      this.error = `Couldn't rename the copy: ${errorMessage(e)}`;
    }
  }

  /**
   * Deletes a virtual copy: its settings and snapshots, and its JPEG (to Immich's trash). The
   * original opens if the copy was open; unsaved changes of the copy are dropped.
   */
  async deleteCopy(id: string): Promise<void> {
    const asset = this.asset;
    const copy = this.copies.find((c) => c.id === id);
    if (!asset || !copy || this.readOnlyGuard()) return;
    try {
      const items = await getAssetMetadata({ id: asset.id });
      const renderId = storedEdit(items, id)?.render?.assetId ?? null;
      if (renderId) await this.leaveFront(asset.id, renderId, storedEdit(items, null)?.render?.assetId ?? null);
      await deleteAssetMetadata({ id: asset.id, key: copyKey(id) });
      await deleteAssetMetadata({ id: asset.id, key: historyKeyFor(id) }).catch(() => {});
      if (renderId) await deleteAssets({ assetBulkDeleteDto: { ids: [renderId] } }).catch((e) => console.warn('Could not move the copy to trash', e));
      this.copies = this.copies.filter((c) => c.id !== id);
      if (this.copyId === id) await this.openEdit(null);
      void drafts.remove(asset.id, id);
      this.notice = `${copy.name} deleted${renderId ? "; its JPEG is in Immich's trash" : ''}.`;
    } catch (e) {
      this.error = `Couldn't delete the copy: ${errorMessage(e)}`;
    }
  }

  /** Before a JPEG leaves the stack: if it is in front, the original's JPEG (else the RAW) takes over. */
  private async leaveFront(rawId: string, renderId: string, originalRenderId: string | null): Promise<void> {
    const raw = await getAssetInfo({ id: rawId });
    if (!raw.stack || raw.stack.primaryAssetId !== renderId) return;
    const next = originalRenderId && originalRenderId !== renderId ? originalRenderId : rawId;
    await updateStack({ id: raw.stack.id, stackUpdateDto: { primaryAssetId: next } }).catch((e) => console.warn('Could not change the front of the stack', e));
  }

  /** Puts this edit's JPEG in front of the RAW's stack in Immich. */
  async showInFront(): Promise<void> {
    const asset = this.asset;
    const renderId = this.recipe.render?.assetId;
    if (!asset || !renderId || this.readOnlyGuard()) return;
    try {
      const raw = await getAssetInfo({ id: asset.id });
      if (!raw.stack) throw new Error('the RAW is not in a stack');
      if (raw.stack.primaryAssetId !== renderId) await updateStack({ id: raw.stack.id, stackUpdateDto: { primaryAssetId: renderId } });
      this.notice = `${this.editName} is now in front of the stack in Immich.`;
    } catch (e) {
      this.error = `Couldn't change the front of the stack: ${errorMessage(e)}`;
    }
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
      // The Immich copy uses the preset chosen in Export; changing it only takes effect here.
      const preset = structuredClone($state.snapshot(this.exportSettings.presets[this.exportSettings.immichPreset]) as ExportPreset);
      const settings = $state.snapshot(this.exportSettings.save) as SaveSettings;
      // Tags, rating or favourite may have changed in Immich since the editor opened.
      const raw = await getAssetInfo({ id: asset.id }).catch(() => asset);
      const { recipe, file, fallback } = await this.renderExport(raw, session, renderer, preset, step, true);
      const copy = this.currentCopy();
      const warnings: string[] = [];
      const saved = await saveRender({
        raw,
        recipe,
        jpeg: new Blob([file.bytes as BlobPart], { type: 'image/jpeg' }),
        copy,
        settings,
        onProgress: (s, f) => step(s, f),
        onWarning: (w) => warnings.push(w),
      });
      if (copy) this.copies = this.copies.map((c) => (c.id === copy.id ? { ...c, renderId: saved.render?.assetId ?? null } : c));
      if (this.recipe.render?.assetId) this.pastRenders.add(this.recipe.render.assetId);
      this.recipe.render = saved.render;
      this.savedRenderId = saved.render?.assetId ?? null;
      // Read the RAW again before the way back is updated: it follows the stack's new front.
      this.asset = await getAssetInfo({ id: asset.id }).catch(() => raw);
      this.syncReturnPath();
      this.recipe.decoder = saved.decoder;
      delete this.recipe.pending;
      this.savedJson = editableJson(saved);
      this.draftConflict = null;
      void this.draftKeeper.drop();
      // A render now keeps the saved look for the next open's loading screen.
      this.requestRender();
      storageSet(PREVIOUS_KEY, pickGroups(saved, DEFAULT_GROUPS));
      this.hasPrevious = true;
      this.notice = [savedNotice(this.asset.stack?.primaryAssetId, asset.id, this.savedRenderId, copy ? `Saved ${copy.name}` : 'Saved'), ...warnings, fallback ? COLOR_FALLBACK : '']
        .filter(Boolean)
        .join(' ');
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

  /** Renders the current edit at full resolution and makes the file the preset describes. */
  private async renderExport(
    asset: AssetResponseDto,
    session: RawSession,
    renderer: Renderer,
    preset: ExportPreset,
    step: (s: RenderStep, fraction?: number) => void,
    forImmich = false,
  ): Promise<{ recipe: Recipe; file: ExportFile; fallback: boolean }> {
    const { recipe, image, fallback } = await this.renderFull(session, renderer, step, outputColor(preset, forImmich));
    const file = await this.finish(image, asset, preset, step, forImmich);
    return { recipe, file, fallback };
  }

  /**
   * The current edit rendered at full resolution (in the colour space and bit depth `out`), and
   * the recipe it was rendered from.
   * fallback: the recipe's film look isn't in this browser, so it rendered with Color.
   */
  private async renderFull(
    session: RawSession,
    renderer: Renderer,
    step: (s: RenderStep, fraction?: number) => void,
    out: OutputColor = SRGB8,
  ): Promise<{ recipe: Recipe; image: Pixels; fallback: boolean }> {
    step('decode');
    this.startFullDecode();
    const full = await session.full();
    const recipe = cloneRecipe($state.snapshot(this.recipe) as Recipe);
    if (renderer.profileMissing(recipe)) {
      // A Fujifilm film look that isn't in this browser: ask, else it renders as Color.
      const looks = await fujiLooks.request();
      if (looks) this.looksArrived(looks);
    }
    const fallback = renderer.profileMissing(recipe);
    // AI masks are computed in the background: the export needs every one of them.
    await this.ai.ready(recipe);
    recipe.app = APP_ID;
    recipe.decoder = { name: session.decoder.name, version: session.decoder.version, demosaic: session.decoder.demosaic };
    step('render');
    const image = await renderer.exportPixels(recipe, full, out, (done, total) => step('render', done / total));
    return { recipe, image, fallback };
  }

  /** A rendered image made into the file `preset` describes. */
  private async finish(image: Pixels | ImageData, asset: AssetResponseDto, preset: ExportPreset, step: (s: RenderStep) => void, forImmich = false): Promise<ExportFile> {
    const wm = preset.watermark;
    const logo = !forImmich && wm.enabled && wm.kind === 'image' ? await loadLogoBitmap(wm.imageId) : null;
    try {
      return await finishExport(image, asset, preset, {
        copyright: this.exportSettings.copyright,
        owner: this.ownerName(asset),
        forImmich,
        logo,
        onStep: (s) => step(s),
      });
    } finally {
      logo?.close();
    }
  }

  /** The photographer, for the copyright line: the asset owner's Immich name. */
  ownerName(asset: AssetResponseDto | null = this.asset): string {
    if (!asset) return '';
    if (asset.owner?.name) return asset.owner.name;
    return this.me && asset.ownerId === this.me.id ? this.me.name : '';
  }

  // ---------------------------------------------------------------- export

  /** Settings dialog or album export, open over the editor (keys go to the dialog). */
  exportDialog = $state<'settings' | 'album' | null>(null);
  private albumName: Promise<string> | null = null;

  /** Name of the album the editor was opened from ('' for a day or a person), for {album}. */
  contextAlbumName(): Promise<string> {
    const ctx = parseContext(this.ctx);
    if (ctx.kind !== 'album') return Promise.resolve('');
    this.albumName ??= getAlbumInfo({ id: ctx.id })
      .then((a) => a.albumName)
      .catch(() => '');
    return this.albumName;
  }

  /** Downloads the current edit (saved or not) with one of the export presets. */
  async exportPhoto(id: ExportPresetId): Promise<boolean> {
    const asset = this.asset;
    const session = this.session;
    const renderer = this.renderer;
    if (!asset || !session || !renderer || this.saving || this.status !== 'ready') return false;
    const what = `Exporting ${PRESET_LABELS[id].name}`;
    const step = (s: RenderStep, fraction = 0) => (this.saving = { label: `${what}: ${STEP_LABEL[s]}`, fraction });
    try {
      const preset = structuredClone($state.snapshot(this.exportSettings.presets[id]) as ExportPreset);
      const { file, fallback } = await this.renderExport(asset, session, renderer, preset, step);
      const name = exportFilename(preset, {
        originalFileName: asset.originalFileName,
        preset: id,
        date: captureDate(asset),
        album: await this.contextAlbumName(),
        owner: this.ownerName(asset),
      });
      downloadBlob(new Blob([file.bytes as BlobPart], { type: file.mime }), name);
      this.error = null;
      this.notice = [`Exported ${name} (${file.width} × ${file.height}).`, ...file.notes, fallback ? COLOR_FALLBACK : ''].filter(Boolean).join(' ');
      return true;
    } catch (e) {
      console.error(e);
      this.notice = null;
      this.error = `Export failed: ${e instanceof Error ? e.message : String(e)}`;
      return false;
    } finally {
      this.saving = null;
    }
  }

  // ---------------------------------------------------------------- AI Upscale

  /** Size of the full-resolution image an export renders (the cropped photo). */
  exportSize(): { width: number; height: number } | null {
    const r = this.renderer;
    if (!r || !this.camera || this.status !== 'ready') return null;
    return r.exportSize(this.recipe);
  }

  /** Result size, time and whether the current setting can run on the whole photo here. */
  upscaleCheck(): UpscaleCheck | null {
    const r = this.renderer;
    if (!r || !this.camera || this.status !== 'ready') return null;
    const { width, height } = r.exportSize(this.recipe);
    const s = this.upscale.settings;
    return checkUpscale({
      width,
      height,
      style: s.style,
      scale: s.scale,
      backend: this.upscale.backend,
      rate: this.upscale.rate(),
      maxPixels: this.upscale.maxPixels(),
    });
  }

  /** AI Upscale of the current edit (saved or not): downloads it, or saves a copy to Immich in the RAW's stack. */
  async upscalePhoto(target: 'download' | 'immich'): Promise<boolean> {
    const asset = this.asset;
    const session = this.session;
    const renderer = this.renderer;
    if (!asset || !session || !renderer || this.saving || this.status !== 'ready') return false;
    if (target === 'immich' && this.readOnly) return false;
    const s = { ...this.upscale.settings };
    let task: UpscaleTask | null = null;
    let cancelled = false;
    // Until the model is done: encoding and uploading are not stopped halfway.
    let cancellable = true;
    const cancel = () => {
      cancelled = true;
      task?.cancel();
    };
    const show = (label: string, fraction = 0) =>
      (this.saving = { label: `AI Upscale ${s.scale}×: ${label}`, fraction, cancel: cancellable ? cancel : undefined });
    try {
      show('Preparing');
      const backend = await this.upscale.loadBackend();
      const check = this.upscaleCheck();
      if (check?.blocked) throw new Error(check.blocked);
      aiConsent.again();
      await aiConsent.permitModels([upscaler(s.style, s.scale).model]);
      const { recipe, image } = await this.renderFull(session, renderer, (st, f) => show(STEP_LABEL[st], f));
      if (cancelled) throw new Error(CANCELLED);
      const big = await this.runUpscale(asImageData(image), s.style, s.scale, backend.gpu, (t) => (task = t), show);
      cancellable = false;
      const high = $state.snapshot(this.exportSettings.presets.high) as ExportPreset;
      const preset: ExportPreset = {
        ...structuredClone(high),
        format: s.format,
        // The upscaler works on 8-bit sRGB.
        color: SRGB8,
        quality: { ...high.quality, jpeg: UPSCALE_QUALITY },
        size: { mode: 'full', value: 0, unit: 'px' },
        // The model sharpens already.
        sharpen: { for: 'none', amount: high.sharpen.amount },
      };
      const file = await this.finish(big, asset, preset, (st) => show(STEP_LABEL[st]), target === 'immich');
      if (target === 'download') {
        const name = upscaledDownloadName(asset.originalFileName, s.scale, s.format);
        downloadBlob(new Blob([file.bytes as BlobPart], { type: file.mime }), name);
        this.notice = [`Exported ${name} (${file.width} × ${file.height}).`, ...file.notes].join(' ');
      } else {
        await saveUpscaled({
          raw: asset,
          jpeg: new Blob([file.bytes as BlobPart], { type: 'image/jpeg' }),
          info: { scale: s.scale, style: s.style, recipeHash: await recipeHash(recipe), copyId: this.copyId },
          onProgress: (st, f) => show(UPSCALE_SAVE_LABEL[st], f),
        });
        this.notice = `Saved the ${s.scale}× copy to Immich (${file.width} × ${file.height}), stacked with the RAW.`;
      }
      this.error = null;
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (cancelled || msg === CANCELLED) {
        this.notice = 'AI Upscale cancelled.';
        return false;
      }
      console.error(e);
      this.notice = null;
      this.error = `AI Upscale failed: ${msg}`;
      return false;
    } finally {
      this.saving = null;
    }
  }

  /** Runs the model over `image` with progress in the saving overlay, and times it for the estimates. */
  private async runUpscale(
    image: ImageData,
    style: UpscaleStyle,
    scale: UpscaleScale,
    gpu: boolean,
    started: (t: UpscaleTask) => void,
    show: (label: string, fraction?: number) => void,
  ): Promise<ImageData> {
    const side = tileSide(upscaler(style, scale), gpu);
    let first = 0;
    let tiles = 0;
    // The rendered image isn't needed afterwards: hand it over instead of copying ~4 bytes a pixel.
    const task = aiClient.upscale({ style, scale, side, image, transfer: true }, (p: Progress) => {
      if (p.kind === 'download') show(`Downloading the ${p.label}`, p.total ? p.loaded / p.total : 0);
      else if (p.kind === 'work') {
        const now = performance.now();
        if (p.done === 1) first = now;
        tiles = p.done;
        const left = p.done > 1 ? (((now - first) / (p.done - 1)) * (p.total - p.done)) / 1000 : null;
        show(left === null ? 'Upscaling' : `Upscaling, ${formatDuration(left)} left`, p.done / p.total);
      } else show(p.label);
    });
    started(task);
    const r = await task.promise;
    // The first tile includes loading the model, so timing starts after it.
    if (tiles > 1) this.upscale.record(style, (performance.now() - first) / 1000, tiles - 1, side);
    return new ImageData(r.data as Uint8ClampedArray<ArrayBuffer>, r.width, r.height);
  }

  private previewRun = 0;
  private previewsRunning = 0;

  /** Upscales the preview patch of the AI Upscale tool (before and after). The latest call wins. */
  async upscalePreview(): Promise<void> {
    const session = this.session;
    const renderer = this.renderer;
    if (!session || !renderer || this.status !== 'ready' || this.tool !== 'upscale') return;
    const run = ++this.previewRun;
    const up = this.upscale;
    const stale = () => run !== this.previewRun || this.tool !== 'upscale';
    const s = { ...up.settings };
    up.previewError = null;
    this.previewsRunning++;
    const alone = this.previewsRunning === 1;
    try {
      const backend = await up.loadBackend();
      const u = upscaler(s.style, s.scale);
      const side = u.fixedSide ?? PATCH + 2 * u.pad;
      const seconds = (side * side * up.rate(s.style)) / 1e6;
      if (!backend.gpu && seconds > 60) throw new Error(`Without a GPU the ${s.style} preview would take ${formatDuration(seconds)}. Try Sharp, or open the editor over HTTPS or on localhost.`);
      up.previewStatus = this.fullImage ? 'Rendering…' : 'Loading full resolution…';
      this.startFullDecode();
      const full = await session.full();
      if (stale()) return;
      const recipe = cloneRecipe($state.snapshot(this.recipe) as Recipe);
      await this.ai.ready(recipe);
      if (stale()) return;
      const { width: W, height: H } = renderer.exportSize(recipe);
      const p = Math.min(PATCH, W, H);
      const x = Math.round(Math.max(0, Math.min(W - p, up.patch[0] * W - p / 2)));
      const y = Math.round(Math.max(0, Math.min(H - p, up.patch[1] * H - p / 2)));
      up.previewStatus = 'Rendering…';
      const before = await renderer.exportRegion(recipe, full, { x, y, w: p, h: p });
      if (stale()) return;
      await aiConsent.permitModels([u.model]);
      up.previewStatus = 'Upscaling…';
      const t0 = performance.now();
      const task = aiClient.upscale({ style: s.style, scale: s.scale, side, image: before }, (pr) => {
        if (pr.kind === 'download') up.previewStatus = `Downloading the ${pr.label}: ${Math.round(pr.loaded / 1e6)} of ${Math.round(pr.total / 1e6)} MB`;
      });
      const r = await task.promise;
      // Timed only when nothing else ran meanwhile, and not the first run (it loads the model).
      if (alone && this.previewsRunning === 1 && up.warm.has(s.style)) up.record(s.style, (performance.now() - t0) / 1000, 1, side);
      up.warm.add(s.style);
      if (stale()) return;
      up.preview = { before, after: new ImageData(r.data as Uint8ClampedArray<ArrayBuffer>, r.width, r.height), scale: s.scale };
      up.previewStatus = null;
    } catch (e) {
      if (stale()) return;
      up.previewStatus = null;
      up.previewError = e instanceof Error ? e.message : String(e);
    } finally {
      this.previewsRunning--;
    }
  }

  /** Replaces one preset's options (nested groups are replaced whole). */
  setExportPreset(id: ExportPresetId, patch: Partial<ExportPreset>): void {
    const current = $state.snapshot(this.exportSettings) as ExportSettings;
    this.storeExportSettings({ ...current, presets: { ...current.presets, [id]: { ...current.presets[id], ...patch } } });
  }

  /** Which preset Save uses for the Immich copy. Takes effect on the next save. */
  setImmichPreset(id: ExportPresetId): void {
    this.storeExportSettings({ ...($state.snapshot(this.exportSettings) as ExportSettings), immichPreset: id });
  }

  setExportCopyright(text: string): void {
    this.storeExportSettings({ ...($state.snapshot(this.exportSettings) as ExportSettings), copyright: text });
  }

  /** How Save puts the edit into Immich (stack front, favourite). Takes effect on the next save. */
  setSaveSettings(patch: Partial<SaveSettings>): void {
    const current = $state.snapshot(this.exportSettings) as ExportSettings;
    this.storeExportSettings({ ...current, save: { ...current.save, ...patch } });
  }

  /** Puts one preset back to its defaults. */
  resetExportPreset(id: ExportPresetId): void {
    const current = $state.snapshot(this.exportSettings) as ExportSettings;
    this.storeExportSettings({ ...current, presets: { ...current.presets, [id]: structuredClone(DEFAULT_EXPORT_SETTINGS.presets[id]) } });
  }

  resetExportSettings(): void {
    this.storeExportSettings(structuredClone(DEFAULT_EXPORT_SETTINGS));
  }

  private storeExportSettings(next: ExportSettings): void {
    const value = normalizeExportSettings(next);
    this.exportSettings = value;
    storageSet(EXPORT_KEY, value);
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
    const recipe = cloneRecipe(this.defaults.recipe);
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

  /** Where "back" goes: the page the user came from, pointing at the stack's front photo if saved. */
  backUrl(): string {
    const renderId = this.recipe.render?.assetId;
    const rawId = this.asset?.id;
    let path = this.returnPath ?? (rawId ? `/photos/${rawId}` : '/photos');
    // The editor may have been opened from the RAW or from an earlier render (the top of
    // the stack); either way, come back to the current render, or to the RAW when Save
    // keeps the RAW in front.
    const target = rawId && renderId && this.asset?.stack?.primaryAssetId === rawId ? rawId : renderId;
    if (target) {
      for (const id of [rawId, renderId, ...this.pastRenders]) {
        if (id && id !== target && path.includes(id)) path = path.replaceAll(id, target);
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
