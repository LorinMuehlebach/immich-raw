// Recipe / settings patch -> crs: XMP (Lightroom sidecar or .xmp preset).
import {
  CURVE_CHANNELS,
  GROUPS,
  getPath,
  isLinearCurve,
  normalizeCurve,
  pickGroups,
  type CropParams,
  type CurvePoint,
  type Recipe,
  type SettingsPatch,
} from '@immich-raw/recipe';
import { cropToLrCrop, type CropContext } from './crop.ts';
import { BOOL_ROWS, CURVE_KEYS, ENUM_ROWS, NUMBER_ROWS } from './map.ts';
import { CRS_NS, IRE_NS, TIFF_NS } from './parse.ts';

export const CRS_VERSION = '16.0';
export const PROCESS_VERSION = '15.4';

export interface ExportOptions {
  /** Preset name (written as crs:Name). */
  name?: string;
  /** Write a Lightroom .xmp preset rather than a sidecar. */
  asPreset?: boolean;
  /** Needed to write the crop; without it the crop is left out. */
  crop?: CropContext;
  /** Preset group shown in Lightroom (presets only). */
  group?: string;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Lightroom style: "+0.50", "-20", "0" (never "-0"). */
export function formatNumber(n: number, decimals: number, signed: boolean): string {
  const r = Number(n.toFixed(decimals));
  const text = (r === 0 ? 0 : r).toFixed(decimals);
  return signed && r > 0 ? `+${text}` : text;
}

const fmtCrop = (n: number) => String(Number(n.toFixed(6)));

/** Random 32-hex-digit id in Lightroom's preset UUID format. */
function presetUuid(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

/** Writes the settings present in `patch` (see packages/recipe groups). */
export function patchToXmp(patch: SettingsPatch, opts: ExportOptions = {}): string {
  const attrs: [string, string][] = [];
  const blocks: string[] = [];
  const add = (key: string, value: string) => attrs.push([`crs:${key}`, value]);

  if (opts.asPreset) {
    add('PresetType', 'Normal');
    add('Cluster', '');
    add('UUID', presetUuid());
    add('SupportsAmount', 'False');
    add('SupportsColor', 'True');
    add('SupportsMonochrome', 'True');
    add('SupportsHighDynamicRange', 'True');
    add('SupportsNormalDynamicRange', 'True');
    add('SupportsSceneReferred', 'True');
    add('SupportsOutputReferred', 'True');
    add('CameraModelRestriction', '');
    add('Copyright', '');
    add('ContactInfo', '');
  }
  add('Version', CRS_VERSION);
  add('ProcessVersion', PROCESS_VERSION);

  const profile = getPath(patch, 'profile');
  if (typeof profile === 'string') {
    add('Treatment', profile === 'monochrome' ? 'Black & White' : 'Color');
    attrs.push(['ire:Profile', profile]);
  }
  const profileAmount = getPath(patch, 'profileAmount');
  if (typeof profileAmount === 'number') attrs.push(['ire:ProfileAmount', String(Math.round(profileAmount))]);

  const wb = getPath(patch, 'wb') as Recipe['wb'] | undefined;
  if (wb) {
    if (wb.mode === 'asShot') add('WhiteBalance', 'As Shot');
    else {
      add('WhiteBalance', 'Custom');
      add('Temperature', formatNumber(Math.round(wb.temp), 0, false));
      add('Tint', formatNumber(Math.round(wb.tint), 0, true));
    }
  }

  for (const r of NUMBER_ROWS) {
    const v = getPath(patch, r.spec.path);
    if (typeof v === 'number') add(r.key, formatNumber(v, r.decimals, r.signed));
  }
  for (const b of BOOL_ROWS) {
    const v = getPath(patch, b.path);
    if (typeof v === 'boolean') add(b.key, v ? '1' : '0');
  }
  for (const e of ENUM_ROWS) {
    const v = getPath(patch, e.path);
    const n = Object.keys(e.values).find((k) => e.values[k] === v);
    if (n) add(e.key, n);
  }

  const curves = getPath(patch, 'toneCurve.point') as Record<string, CurvePoint[]> | undefined;
  if (curves) {
    const master = normalizeCurve(curves.master);
    add('ToneCurveName2012', isLinearCurve(master) ? 'Linear' : 'Custom');
    for (const ch of CURVE_CHANNELS) {
      if (!curves[ch]) continue;
      const items = normalizeCurve(curves[ch])
        .map(([x, y]) => `     <rdf:li>${Math.round(x)}, ${Math.round(y)}</rdf:li>`)
        .join('\n');
      blocks.push(`   <crs:${CURVE_KEYS[ch]}>\n    <rdf:Seq>\n${items}\n    </rdf:Seq>\n   </crs:${CURVE_KEYS[ch]}>`);
    }
  }

  const crop = getPath(patch, 'crop') as CropParams | undefined;
  if (crop && opts.crop) {
    const full = crop.w >= 0.9999 && crop.h >= 0.9999 && Math.abs(crop.angle) < 1e-6;
    const lr = cropToLrCrop(crop, opts.crop);
    if (full) add('HasCrop', 'False');
    else {
      add('CropTop', fmtCrop(lr.top));
      add('CropLeft', fmtCrop(lr.left));
      add('CropBottom', fmtCrop(lr.bottom));
      add('CropRight', fmtCrop(lr.right));
      add('CropAngle', fmtCrop(lr.angle));
      add('CropConstrainToWarp', '0');
      add('HasCrop', 'True');
    }
    if (!opts.asPreset && crop.rotate90) attrs.push(['tiff:Orientation', String(lr.orientation)]);
  }

  add('HasSettings', 'True');

  if (opts.asPreset || opts.name) {
    const alt = (key: string, text: string) =>
      `   <crs:${key}>\n    <rdf:Alt>\n     <rdf:li xml:lang="x-default">${esc(text)}</rdf:li>\n    </rdf:Alt>\n   </crs:${key}>`;
    blocks.unshift(alt('Name', opts.name ?? 'Untitled'));
    if (opts.asPreset) {
      blocks.splice(1, 0, alt('ShortName', ''), alt('SortName', ''), alt('Group', opts.group ?? 'immich-raw'), alt('Description', ''));
    }
  }

  const attrText = attrs.map(([k, v]) => `\n    ${k}="${esc(v)}"`).join('');
  const usesTiff = attrs.some(([k]) => k.startsWith('tiff:'));
  return [
    '<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="immich-raw">',
    ' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    `  <rdf:Description rdf:about=""\n    xmlns:crs="${CRS_NS}"\n    xmlns:ire="${IRE_NS}"${usesTiff ? `\n    xmlns:tiff="${TIFF_NS}"` : ''}${attrText}>`,
    ...blocks,
    '  </rdf:Description>',
    ' </rdf:RDF>',
    '</x:xmpmeta>',
    '',
  ].join('\n');
}

/** Writes every mapped setting of the recipe (crop only when `opts.crop` is given). */
export function recipeToXmp(recipe: Recipe, opts: ExportOptions = {}): string {
  return patchToXmp(
    pickGroups(
      recipe,
      GROUPS.map((g) => g.id),
    ),
    opts,
  );
}
