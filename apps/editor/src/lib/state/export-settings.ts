// Export presets: Low (web), Medium (screen) and High (print), each with Lightroom's export
// options (file type, size, quality, output sharpening, watermark, metadata, file name), and
// which of them Save uses for the copy in Immich. Kept in this browser.
import { clampParam, type ParamSpec } from '@immich-raw/recipe';

export type ExportPresetId = 'low' | 'medium' | 'high';
export type ExportFormat = 'jpeg' | 'png' | 'tiff';
/** Full size, or which side (or the pixel count) the value sets. */
export type SizeMode = 'full' | 'longEdge' | 'shortEdge' | 'width' | 'height' | 'megapixels';
export type SizeUnit = 'px' | 'in' | 'cm';
export type SharpenFor = 'none' | 'screen' | 'matte' | 'glossy';
export type SharpenAmount = 'low' | 'standard' | 'high';
/** all: everything we know; noLocation: all but GPS and place names; copyright: only copyright and artist. */
export type MetadataMode = 'all' | 'noLocation' | 'copyright';
export type WatermarkPosition = 'top-left' | 'top' | 'top-right' | 'left' | 'center' | 'right' | 'bottom-left' | 'bottom' | 'bottom-right';

export interface ExportSize {
  mode: SizeMode;
  /** In `unit` (megapixels for 'megapixels'). Ignored for 'full'. */
  value: number;
  unit: SizeUnit;
}

export interface ExportWatermark {
  enabled: boolean;
  /** Text with {year} and {owner}, like the copyright. */
  text: string;
  position: WatermarkPosition;
  /** Text height in % of the short edge. */
  size: number;
  /** 0-100. */
  opacity: number;
  color: 'white' | 'black';
}

export interface ExportPreset {
  format: ExportFormat;
  size: ExportSize;
  /** Print resolution: converts in/cm to pixels and is written into the file. */
  ppi: number;
  /** JPEG quality, 50-100. */
  quality: number;
  sharpen: { for: SharpenFor; amount: SharpenAmount };
  watermark: ExportWatermark;
  metadata: MetadataMode;
  /** File name template; see TEMPLATE_TOKENS. */
  naming: string;
}

export interface ExportSettings {
  presets: Record<ExportPresetId, ExportPreset>;
  /** The preset Save renders the Immich copy with (size, quality, sharpening; always JPEG). */
  immichPreset: ExportPresetId;
  /** Copyright line written into exports (and the watermark's default text), with {year} and {owner}. */
  copyright: string;
}

export const EXPORT_PRESET_IDS: readonly ExportPresetId[] = ['low', 'medium', 'high'];

export const PRESET_LABELS: Record<ExportPresetId, { name: string; purpose: string }> = {
  low: { name: 'Low', purpose: 'for the web' },
  medium: { name: 'Medium', purpose: 'for viewing on screens' },
  high: { name: 'High', purpose: 'for printing' },
};

export const FORMAT_LABELS: Record<ExportFormat, string> = { jpeg: 'JPEG', png: 'PNG', tiff: 'TIFF' };
export const FORMAT_EXTENSION: Record<ExportFormat, string> = { jpeg: 'jpg', png: 'png', tiff: 'tif' };
export const SIZE_MODE_LABELS: Record<SizeMode, string> = {
  full: 'Full size',
  longEdge: 'Long edge',
  shortEdge: 'Short edge',
  width: 'Width',
  height: 'Height',
  megapixels: 'Megapixels',
};
export const UNIT_LABELS: Record<SizeUnit, string> = { px: 'pixels', in: 'in', cm: 'cm' };
export const SHARPEN_LABELS: Record<SharpenFor, string> = { none: 'None', screen: 'Screen', matte: 'Matte paper', glossy: 'Glossy paper' };
export const AMOUNT_LABELS: Record<SharpenAmount, string> = { low: 'Low', standard: 'Standard', high: 'High' };
export const METADATA_LABELS: Record<MetadataMode, string> = {
  all: 'All metadata',
  noLocation: 'All except location',
  copyright: 'Copyright only',
};
export const POSITION_LABELS: Record<WatermarkPosition, string> = {
  'top-left': 'Top left',
  top: 'Top',
  'top-right': 'Top right',
  left: 'Left',
  center: 'Centre',
  right: 'Right',
  'bottom-left': 'Bottom left',
  bottom: 'Bottom',
  'bottom-right': 'Bottom right',
};

/** Ready-made file names; anything else is a custom template. */
export const NAMING_CHOICES: readonly { template: string; label: string }[] = [
  { template: '{name}', label: 'Original name' },
  { template: '{name}-{preset}', label: 'Original name - preset' },
  { template: '{date}_{name}', label: 'Date_original name' },
  { template: '{album}-{seq}', label: 'Album - number' },
];
export const TEMPLATE_TOKENS = ['{name}', '{preset}', '{date}', '{seq}', '{album}', '{year}', '{owner}'] as const;

export const DEFAULT_COPYRIGHT = '© {year} {owner}';

const watermarkDefaults = (): ExportWatermark => ({ enabled: false, text: DEFAULT_COPYRIGHT, position: 'bottom-right', size: 3, opacity: 70, color: 'white' });

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  presets: {
    low: {
      format: 'jpeg',
      size: { mode: 'longEdge', value: 2048, unit: 'px' },
      ppi: 72,
      quality: 80,
      sharpen: { for: 'screen', amount: 'standard' },
      watermark: watermarkDefaults(),
      metadata: 'noLocation',
      naming: '{name}',
    },
    medium: {
      format: 'jpeg',
      size: { mode: 'longEdge', value: 3840, unit: 'px' },
      ppi: 72,
      quality: 90,
      sharpen: { for: 'none', amount: 'standard' },
      watermark: watermarkDefaults(),
      metadata: 'all',
      naming: '{name}',
    },
    high: {
      format: 'jpeg',
      size: { mode: 'full', value: 30, unit: 'cm' },
      ppi: 300,
      quality: 95,
      sharpen: { for: 'none', amount: 'standard' },
      watermark: watermarkDefaults(),
      metadata: 'all',
      naming: '{name}',
    },
  },
  immichPreset: 'medium',
  copyright: DEFAULT_COPYRIGHT,
};

const qualitySpec = (id: ExportPresetId): ParamSpec => ({
  path: `export.${id}.quality`,
  label: 'Quality',
  min: 50,
  max: 100,
  default: DEFAULT_EXPORT_SETTINGS.presets[id].quality,
  step: 1,
  decimals: 0,
  signed: false,
});

export const QUALITY_SPECS: Record<ExportPresetId, ParamSpec> = {
  low: qualitySpec('low'),
  medium: qualitySpec('medium'),
  high: qualitySpec('high'),
};

export const WATERMARK_SIZE: ParamSpec = { path: 'watermark.size', label: 'Size', min: 1, max: 20, default: 3, step: 0.5, decimals: 1, signed: false };
export const WATERMARK_OPACITY: ParamSpec = { path: 'watermark.opacity', label: 'Opacity', min: 5, max: 100, default: 70, step: 1, decimals: 0, signed: false };
export const PPI_RANGE = { min: 50, max: 1200 } as const;

/** Allowed size values per unit (megapixels for 'megapixels'). */
const VALUE_RANGE: Record<SizeUnit | 'mp', { min: number; max: number; decimals: number }> = {
  px: { min: 64, max: 20000, decimals: 0 },
  in: { min: 0.5, max: 200, decimals: 2 },
  cm: { min: 1, max: 500, decimals: 1 },
  mp: { min: 0.1, max: 400, decimals: 1 },
};

const MAX_TEMPLATE = 120;
const MAX_TEXT = 200;

const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const round = (v: number, decimals: number) => Math.round(v * 10 ** decimals) / 10 ** decimals;

function num(v: unknown, min: number, max: number, fallback: number, decimals = 0): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return round(Math.min(max, Math.max(min, v)), decimals);
}

function text(v: unknown, fallback: string, max = MAX_TEXT): string {
  return typeof v === 'string' ? v.slice(0, max) : fallback;
}

export function isExportPresetId(v: unknown): v is ExportPresetId {
  return typeof v === 'string' && (EXPORT_PRESET_IDS as readonly string[]).includes(v);
}

function normalizeSize(v: unknown, legacyLongEdge: unknown, def: ExportSize): ExportSize {
  // Before these options a preset only had longEdge (null = full size).
  if (v === undefined && legacyLongEdge !== undefined) {
    if (legacyLongEdge === null) return { ...def, mode: 'full' };
    if (typeof legacyLongEdge === 'number' && Number.isFinite(legacyLongEdge)) {
      const px = Math.round(legacyLongEdge);
      if (px >= VALUE_RANGE.px.min && px <= VALUE_RANGE.px.max) return { mode: 'longEdge', value: px, unit: 'px' };
    }
    return { ...def };
  }
  const o = obj(v);
  const mode = pick(o.mode, ['full', 'longEdge', 'shortEdge', 'width', 'height', 'megapixels'] as const, def.mode);
  const unit = pick(o.unit, ['px', 'in', 'cm'] as const, def.unit);
  const range = VALUE_RANGE[mode === 'megapixels' ? 'mp' : unit];
  const fallback = mode === def.mode && unit === def.unit ? def.value : mode === 'megapixels' ? 12 : unit === 'px' ? 2048 : unit === 'in' ? 10 : 25;
  const value = typeof o.value === 'number' && Number.isFinite(o.value) && o.value >= range.min && o.value <= range.max ? round(o.value, range.decimals) : fallback;
  return { mode, value, unit };
}

function normalizePreset(id: ExportPresetId, v: unknown): ExportPreset {
  const def = DEFAULT_EXPORT_SETTINGS.presets[id];
  const o = obj(v);
  const sh = obj(o.sharpen);
  const wm = obj(o.watermark);
  return {
    format: pick(o.format, ['jpeg', 'png', 'tiff'] as const, def.format),
    size: normalizeSize(o.size, o.longEdge, def.size),
    ppi: num(o.ppi, PPI_RANGE.min, PPI_RANGE.max, def.ppi),
    quality: typeof o.quality === 'number' ? Math.round(clampParam(QUALITY_SPECS[id], o.quality)) : def.quality,
    sharpen: {
      for: pick(sh.for, ['none', 'screen', 'matte', 'glossy'] as const, def.sharpen.for),
      amount: pick(sh.amount, ['low', 'standard', 'high'] as const, def.sharpen.amount),
    },
    watermark: {
      enabled: typeof wm.enabled === 'boolean' ? wm.enabled : def.watermark.enabled,
      text: text(wm.text, def.watermark.text),
      position: pick(wm.position, Object.keys(POSITION_LABELS) as WatermarkPosition[], def.watermark.position),
      size: num(wm.size, WATERMARK_SIZE.min, WATERMARK_SIZE.max, def.watermark.size, 1),
      opacity: num(wm.opacity, WATERMARK_OPACITY.min, WATERMARK_OPACITY.max, def.watermark.opacity),
      color: pick(wm.color, ['white', 'black'] as const, def.watermark.color),
    },
    metadata: pick(o.metadata, ['all', 'noLocation', 'copyright'] as const, def.metadata),
    naming: typeof o.naming === 'string' && o.naming.trim() ? o.naming.slice(0, MAX_TEMPLATE) : def.naming,
  };
}

/** Stored settings -> valid settings; anything missing or out of range falls back to the default. */
export function normalizeExportSettings(input: unknown): ExportSettings {
  const o = obj(input);
  const presets = obj(o.presets);
  return {
    presets: {
      low: normalizePreset('low', presets.low),
      medium: normalizePreset('medium', presets.medium),
      high: normalizePreset('high', presets.high),
    },
    immichPreset: isExportPresetId(o.immichPreset) ? o.immichPreset : DEFAULT_EXPORT_SETTINGS.immichPreset,
    copyright: text(o.copyright, DEFAULT_COPYRIGHT),
  };
}

/** Range and step of the size value for a mode and unit (for the input field). */
export function sizeValueRange(size: Pick<ExportSize, 'mode' | 'unit'>): { min: number; max: number; step: number } {
  const r = VALUE_RANGE[size.mode === 'megapixels' ? 'mp' : size.unit];
  return { min: r.min, max: r.max, step: 1 / 10 ** r.decimals };
}

function clampValue(value: number, size: Pick<ExportSize, 'mode' | 'unit'>): number {
  const r = VALUE_RANGE[size.mode === 'megapixels' ? 'mp' : size.unit];
  return round(Math.min(r.max, Math.max(r.min, value)), r.decimals);
}

/** The size with a new value, clamped to what the mode and unit allow. */
export function withSizeValue(size: ExportSize, value: number): ExportSize {
  return Number.isFinite(value) ? { ...size, value: clampValue(value, size) } : size;
}

/** The size in another unit, describing the same pixel count at `ppi`. */
export function withSizeUnit(size: ExportSize, unit: SizeUnit, ppi: number): ExportSize {
  if (unit === size.unit || size.mode === 'megapixels') return { ...size, unit };
  const px = size.unit === 'px' ? size.value : size.unit === 'in' ? size.value * ppi : (size.value / 2.54) * ppi;
  const value = unit === 'px' ? px : unit === 'in' ? px / ppi : (px / ppi) * 2.54;
  return { ...size, unit, value: clampValue(value, { mode: size.mode, unit }) };
}

/** The size with another mode; switching to or from megapixels picks a typical value. */
export function withSizeMode(size: ExportSize, mode: SizeMode): ExportSize {
  if (mode === size.mode) return size;
  if (mode === 'megapixels') return { mode, value: 12, unit: size.unit };
  if (size.mode === 'megapixels' || size.mode === 'full') {
    const value = size.unit === 'px' ? 2048 : size.unit === 'in' ? 10 : 25;
    return { mode, value: size.mode === 'full' && size.value >= VALUE_RANGE[size.unit].min ? clampValue(size.value, { mode, unit: size.unit }) : value, unit: size.unit };
  }
  return { ...size, mode };
}

/** Pixel size of the export for a photo of width x height. Never larger than the photo. */
export function outputSize(width: number, height: number, size: ExportSize, ppi: number): { width: number; height: number } {
  if (size.mode === 'full' || width <= 0 || height <= 0) return { width, height };
  const px = size.unit === 'in' ? size.value * ppi : size.unit === 'cm' ? (size.value / 2.54) * ppi : size.value;
  let s: number;
  switch (size.mode) {
    case 'longEdge':
      s = px / Math.max(width, height);
      break;
    case 'shortEdge':
      s = px / Math.min(width, height);
      break;
    case 'width':
      s = px / width;
      break;
    case 'height':
      s = px / height;
      break;
    case 'megapixels':
      s = Math.sqrt((size.value * 1e6) / (width * height));
      break;
  }
  s = Math.min(1, s);
  return { width: Math.max(1, Math.round(width * s)), height: Math.max(1, Math.round(height * s)) };
}

/** "Long edge 2048 px", "30 cm × 300 ppi", "Full size". */
export function sizeSummary(p: Pick<ExportPreset, 'size' | 'ppi'>): string {
  const s = p.size;
  if (s.mode === 'full') return 'Full size';
  if (s.mode === 'megapixels') return `${s.value} MP`;
  const v = s.unit === 'px' ? `${s.value} px` : `${s.value} ${s.unit} at ${p.ppi} ppi`;
  return `${SIZE_MODE_LABELS[s.mode]} ${v}`;
}

/** Short text for a preset button: "2048 px", "Full size", "12 MP". */
export function sizeShort(p: Pick<ExportPreset, 'size' | 'ppi'>): string {
  const s = p.size;
  if (s.mode === 'full') return 'Full size';
  if (s.mode === 'megapixels') return `${s.value} MP`;
  return s.unit === 'px' ? `${s.value} px` : `${s.value} ${s.unit}`;
}

/** "JPEG · 2048 px · quality 80" */
export function presetSummary(p: ExportPreset): string {
  const parts = [FORMAT_LABELS[p.format], sizeSummary(p)];
  if (p.format === 'jpeg') parts.push(`quality ${p.quality}`);
  if (p.sharpen.for !== 'none') parts.push(`sharpened for ${SHARPEN_LABELS[p.sharpen.for].toLowerCase()}`);
  if (p.watermark.enabled) parts.push('watermark');
  return parts.join(' · ');
}

export interface TemplateValues {
  /** Original file name, with or without extension. */
  originalFileName?: string | null;
  preset?: ExportPresetId;
  /** Capture date; 'YYYY-MM-DD' is used. */
  date?: Date | null;
  /** 1-based number within an export. */
  seq?: number;
  /** Digits of {seq}; at least 3. */
  seqDigits?: number;
  album?: string | null;
  owner?: string | null;
  year?: number;
}

const pad = (n: number, d: number) => String(n).padStart(d, '0');
const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)}`;

/** Fills {name} {preset} {date} {seq} {album} {year} {owner}; unknown tokens stay as they are. */
export function fillTemplate(template: string, v: TemplateValues): string {
  const base = (v.originalFileName ?? '').replace(/\.[^./\\]*$/, '');
  const values: Record<string, string> = {
    name: base,
    preset: v.preset ?? '',
    date: v.date && !Number.isNaN(v.date.getTime()) ? isoDay(v.date) : '',
    seq: pad(v.seq ?? 1, Math.max(3, v.seqDigits ?? 3)),
    album: v.album ?? '',
    year: String(v.year ?? new Date().getFullYear()),
    owner: v.owner ?? '',
  };
  return template.replace(/\{(\w+)\}/g, (m, key: string) => (key in values ? values[key]! : m));
}

/** A safe file name: no path separators or characters Windows forbids, not empty. */
export function safeFileName(name: string): string {
  const cleaned = name
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 180);
  return cleaned || 'photo';
}

/** "DSC_0001.NEF" + preset -> "DSC_0001.jpg" (or as the naming template says). */
export function exportFilename(preset: Pick<ExportPreset, 'naming' | 'format'>, v: TemplateValues): string {
  return `${safeFileName(fillTemplate(preset.naming, v))}.${FORMAT_EXTENSION[preset.format]}`;
}

/** Copyright or watermark text with {year} and {owner} filled in, trimmed. */
export function fillText(template: string, v: Pick<TemplateValues, 'owner' | 'year' | 'date'>): string {
  return fillTemplate(template, { ...v, year: v.year ?? v.date?.getFullYear() })
    .replace(/\s+/g, ' ')
    .trim();
}
