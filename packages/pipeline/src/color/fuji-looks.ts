// The Fujifilm film looks: community look tables and tone curves by abpy
// (github.com/abpy/FujifilmCameraProfiles, CC BY-NC-SA 4.0), modelled on the camera-matching
// profiles for Fujifilm X cameras. They are not part of immich-raw: the editor downloads them
// from the pinned commit at run time, after asking, and keeps them in the browser.
//
// Eight looks come as a DCP look table plus tone curve. Classic Neg., Nostalgic Neg. and
// Eterna Bleach Bypass exist only as LUTs that turn a Provia rendering into them, so they are
// Provia plus that display-space LUT.
import type { FujiProfileId } from '@immich-raw/recipe';
import { buildToneLut, parseCubeLut, parseDcpLookTableXml, parseDcpToneCurveXml, type CubeLut, type HueSatTable, type ToneLutOptions } from './dcp.ts';
import type { ProfileLooks } from './profiles.ts';

export const FUJI_LOOKS_SOURCE = {
  repo: 'https://github.com/abpy/FujifilmCameraProfiles',
  commit: 'b5a1f16abfb2759b337c83d69d9dc49470e7e518',
  author: 'abpy',
  licence: 'CC BY-NC-SA 4.0',
  licenceUrl: 'https://creativecommons.org/licenses/by-nc-sa/4.0/',
  /** Download size of all files, roughly. */
  approxBytes: 15_000_000,
} as const;

export type FujiTableLook = 'provia' | 'velvia' | 'astia' | 'classic-chrome' | 'pro-neg-std' | 'pro-neg-hi' | 'eterna' | 'reala-ace';
export type FujiConversionLook = 'classic-neg' | 'nostalgic-neg' | 'bleach-bypass';

/** Look table + tone curve (dcpTool XML fragments), by look. */
export const FUJI_TABLE_FILES: Record<FujiTableLook, string> = {
  provia: 'xml tables/provia.txt',
  velvia: 'xml tables/velvia.txt',
  astia: 'xml tables/astia.txt',
  'classic-chrome': 'xml tables/classic chrome.txt',
  'pro-neg-std': 'xml tables/pro neg std.txt',
  'pro-neg-hi': 'xml tables/pro neg hi.txt',
  eterna: 'xml tables/eterna.txt',
  'reala-ace': 'xml tables/reala ace.txt',
};

/** sRGB LUTs that turn a Provia rendering into these looks. */
export const FUJI_CONVERSION_FILES: Record<FujiConversionLook, string> = {
  'classic-neg': 'provia conversion luts/Provia to Classic Neg sRGB.cube',
  'nostalgic-neg': 'provia conversion luts/Provia to Nostalgic Neg sRGB.cube',
  'bleach-bypass': 'provia conversion luts/Provia to Bleach Bypass sRGB.cube',
};

export const FUJI_FILES: string[] = [...Object.values(FUJI_TABLE_FILES), ...Object.values(FUJI_CONVERSION_FILES)];

/** Download URL of a file at the pinned commit. */
export function fujiLooksUrl(path: string): string {
  const repo = FUJI_LOOKS_SOURCE.repo.replace('https://github.com/', '');
  return `https://raw.githubusercontent.com/${repo}/${FUJI_LOOKS_SOURCE.commit}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

/** The parsed files: what the browser keeps. */
export interface FujiLooksData {
  version: 1;
  commit: string;
  tables: Record<FujiTableLook, { look: HueSatTable; curve: Float32Array }>;
  cubes: Record<FujiConversionLook, CubeLut>;
}

/** Parses the downloaded files (path -> text). Throws when one is missing or malformed. */
export function parseFujiLooks(files: Record<string, string>): FujiLooksData {
  const text = (path: string) => {
    const t = files[path];
    if (typeof t !== 'string') throw new Error(`Missing ${path}`);
    return t;
  };
  const tables = {} as FujiLooksData['tables'];
  for (const [look, path] of Object.entries(FUJI_TABLE_FILES) as [FujiTableLook, string][]) {
    try {
      tables[look] = { look: parseDcpLookTableXml(text(path)), curve: parseDcpToneCurveXml(text(path)) };
    } catch (e) {
      throw new Error(`${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const cubes = {} as FujiLooksData['cubes'];
  for (const [look, path] of Object.entries(FUJI_CONVERSION_FILES) as [FujiConversionLook, string][]) {
    try {
      cubes[look] = parseCubeLut(text(path));
    } catch (e) {
      throw new Error(`${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { version: 1, commit: FUJI_LOOKS_SOURCE.commit, tables, cubes };
}

/** Checks data read back from the browser's cache; null when it isn't usable. */
export function validFujiLooksData(d: unknown): FujiLooksData | null {
  if (!d || typeof d !== 'object') return null;
  const x = d as Partial<FujiLooksData>;
  if (x.version !== 1 || x.commit !== FUJI_LOOKS_SOURCE.commit || !x.tables || !x.cubes) return null;
  const okTable = (t: { look?: HueSatTable; curve?: Float32Array } | undefined) =>
    !!t?.look &&
    t.look.data instanceof Float32Array &&
    t.look.data.length === t.look.hueDivisions * t.look.satDivisions * t.look.valDivisions * 3 &&
    t.curve instanceof Float32Array &&
    t.curve.length >= 4;
  const okCube = (c: CubeLut | undefined) => !!c && c.data instanceof Float32Array && c.data.length === c.size ** 3 * 3;
  if (!(Object.keys(FUJI_TABLE_FILES) as FujiTableLook[]).every((k) => okTable(x.tables![k]))) return null;
  if (!(Object.keys(FUJI_CONVERSION_FILES) as FujiConversionLook[]).every((k) => okCube(x.cubes![k]))) return null;
  return x as FujiLooksData;
}

const TABLE_PROFILES: Record<FujiTableLook, FujiProfileId> = {
  provia: 'fuji-provia',
  velvia: 'fuji-velvia',
  astia: 'fuji-astia',
  'classic-chrome': 'fuji-classic-chrome',
  'pro-neg-std': 'fuji-pro-neg-std',
  'pro-neg-hi': 'fuji-pro-neg-hi',
  eterna: 'fuji-eterna',
  'reala-ace': 'fuji-reala-ace',
};

const CONVERSION_PROFILES: Record<FujiConversionLook, FujiProfileId> = {
  'classic-neg': 'fuji-classic-neg',
  'nostalgic-neg': 'fuji-nostalgic-neg',
  'bleach-bypass': 'fuji-bleach-bypass',
};

/** Render data for every Fujifilm profile. */
export function fujiProfileLooks(d: FujiLooksData, tone: ToneLutOptions = {}): ProfileLooks {
  const looks: ProfileLooks = {};
  for (const [look, id] of Object.entries(TABLE_PROFILES) as [FujiTableLook, FujiProfileId][]) {
    looks[id] = { lookTable: d.tables[look].look, toneLut: buildToneLut(d.tables[look].curve, tone) };
  }
  const provia = looks['fuji-provia']!;
  for (const [look, id] of Object.entries(CONVERSION_PROFILES) as [FujiConversionLook, FujiProfileId][]) {
    looks[id] = { ...provia, filmLut: d.cubes[look] };
  }
  return looks;
}
