// Lensfun lens profiles: the compact database built by scripts/build-lensfun.mjs, camera
// and lens matching, coefficient interpolation and conversion into a LensCorrection.
//
// Ported from Lensfun at commit 52cf1a7b0e82e07e0ecaa3391ee5106a6dd1ee54 (2026-11-04,
// libs/lensfun/*.cpp); each function names the C++ it follows. Lensfun works in float, this
// code in double, so results agree to float precision.
//
// Lensfun: Copyright (C) 2007 Andrew Zabolotny and the Lensfun contributors, LGPL-3.0.
// This port is conveyed under the GPL-3.0 (LGPL-3.0 §2b) as part of this AGPL-3.0 work;
// see THIRD-PARTY-NOTICES.md.
import { fitRadialPoly } from './fit.ts';
import { IDENTITY_POLY, type LensCorrection, type LensQuery, type RadialPoly } from './types.ts';

// ---------------------------------------------------------------------------------------
// Database

/** Multi-language string: the default first, then the translations. */
type MlStr = string | string[];

/** JSON written by scripts/build-lensfun.mjs (apps/editor/public/lensfun/lensfun.json). */
export interface LensfunJson {
  format: 1;
  source: { repo: string; commit: string; date: string; license: string };
  /** Mount names; cameras and lenses refer to them by index. */
  mounts: string[];
  /** Mount index -> indices of the mounts its cameras can take via adapters (<compat>). */
  compat: Record<string, number[]>;
  /** [maker, model, mount, crop factor, variant?] */
  cameras: [MlStr, MlStr, number, number, MlStr?][];
  lenses: LensfunJsonLens[];
}

export interface LensfunJsonLens {
  /** maker */
  m?: MlStr;
  /** model */
  n: MlStr;
  /** mounts */
  mt: number[];
  /** crop factor of the calibration */
  c: number;
  /** aspect ratio of the calibration, 1.5 when missing */
  ar?: number;
  /** lens type, 'rectilinear' when missing */
  t?: string;
  /** declared focal range [min, max] (0 = not declared) */
  f?: [number, number];
  /** declared aperture range [min, max] */
  a?: [number, number];
  /** legacy optical centre offset (<center x y>) */
  ctr?: [number, number];
  /** distortion model and rows [focal, ...terms, realFocal?]: poly3 k1 / poly5 k1 k2 / ptlens a b c */
  dm?: DistortionModel;
  d?: number[][];
  /** TCA model and rows: linear [focal, kr, kb] / poly3 [focal, vr, vb, cr, cb, br, bb] (trailing zeros dropped) */
  tm?: TcaModel;
  tc?: number[][];
  /** pa vignetting rows [focal, aperture, distance | distance[], k1, k2, k3] */
  v?: (number | number[])[][];
}

export type DistortionModel = 'poly3' | 'poly5' | 'ptlens';
export type TcaModel = 'linear' | 'poly3';

export interface LfCamera {
  /** Default name first, then translations. */
  maker: string[];
  model: string[];
  variant: string[];
  mount: string;
  cropFactor: number;
  /** Lensfun marks fixed-lens cameras by a mount name starting in lower case. */
  fixedLens: boolean;
}

export interface LfDistortion {
  focal: number;
  model: DistortionModel;
  /** poly3: [k1], poly5: [k1, k2], ptlens: [a, b, c] */
  terms: number[];
  realFocal: number;
}

export interface LfTca {
  focal: number;
  model: TcaModel;
  /** linear: [kr, kb, 0, 0, 0, 0]; poly3: [vr, vb, cr, cb, br, bb] */
  terms: [number, number, number, number, number, number];
}

export interface LfVignetting {
  focal: number;
  aperture: number;
  distance: number;
  /** pa model: k1, k2, k3 */
  k: [number, number, number];
}

export interface LfLens {
  /** Stable identifier for the UI ("maker/model", plus "@crop" where Lensfun has several calibrations). */
  id: string;
  maker: string[];
  model: string[];
  mounts: string[];
  cropFactor: number;
  aspectRatio: number;
  type: string;
  center: [number, number];
  /** After lfLens::GuessParameters (0 = unknown). */
  minFocal: number;
  maxFocal: number;
  minAperture: number;
  maxAperture: number;
  distortion: LfDistortion[];
  tca: LfTca[];
  vignetting: LfVignetting[];
}

export interface LensfunDb {
  source: LensfunJson['source'];
  cameras: LfCamera[];
  lenses: LfLens[];
  /** Mount name -> compatible mount names. */
  compat: Map<string, string[]>;
  lensById: Map<string, LfLens>;
}

const ml = (s: MlStr | undefined): string[] => (s === undefined ? [] : Array.isArray(s) ? s : [s]);

const DIST_TERMS: Record<DistortionModel, number> = { poly3: 1, poly5: 2, ptlens: 3 };

/** Resolves mount indices, expands rows and runs Lensfun's parameter guessing once. */
export function loadLensfun(json: LensfunJson): LensfunDb {
  if (json.format !== 1) throw new Error(`Unsupported Lensfun database format ${String(json.format)}`);
  const mount = (i: number) => json.mounts[i] ?? '';
  const compat = new Map<string, string[]>();
  for (const [k, list] of Object.entries(json.compat)) compat.set(mount(Number(k)), list.map(mount));

  const cameras: LfCamera[] = json.cameras.map(([maker, model, m, crop, variant]) => {
    const name = mount(m);
    return { maker: ml(maker), model: ml(model), variant: ml(variant), mount: name, cropFactor: crop, fixedLens: /^\p{Ll}/u.test(name) };
  });

  const lenses: LfLens[] = json.lenses.map((l) => {
    const dm = l.dm ?? 'ptlens';
    const distortion = (l.d ?? []).map((row): LfDistortion => {
      const n = DIST_TERMS[dm];
      const terms = row.slice(1, 1 + n);
      const focal = row[0] ?? 0;
      // database.cpp: an undeclared real focal length follows from the model's d term.
      const realFocal =
        row[1 + n] ?? (dm === 'ptlens' ? focal * (1 - terms[0]! - terms[1]! - terms[2]!) : dm === 'poly3' ? focal * (1 - terms[0]!) : focal);
      return { focal, model: dm, terms, realFocal };
    });
    const tm = l.tm ?? 'poly3';
    const tca = (l.tc ?? []).map((row): LfTca => {
      const t = [1, 1, 0, 0, 0, 0].map((d, i) => row[i + 1] ?? d) as LfTca['terms'];
      if (tm === 'linear') t.fill(0, 2);
      return { focal: row[0] ?? 0, model: tm, terms: t };
    });
    const vignetting: LfVignetting[] = [];
    for (const [f, a, d, k1, k2, k3] of l.v ?? []) {
      for (const dist of Array.isArray(d) ? d : [d]) {
        vignetting.push({ focal: f as number, aperture: a as number, distance: dist ?? 0, k: [k1 as number, k2 as number, k3 as number] });
      }
    }
    const lens: LfLens = {
      id: '',
      maker: ml(l.m),
      model: ml(l.n),
      mounts: l.mt.map(mount),
      cropFactor: l.c,
      aspectRatio: l.ar ?? 1.5,
      type: l.t ?? 'rectilinear',
      center: l.ctr ?? [0, 0],
      minFocal: l.f?.[0] ?? 0,
      maxFocal: l.f?.[1] ?? 0,
      minAperture: l.a?.[0] ?? 0,
      maxAperture: l.a?.[1] ?? 0,
      distortion,
      tca,
      vignetting,
    };
    guessParameters(lens);
    return lens;
  });

  // Ids: the same lens can appear once per calibration crop factor.
  const byName = new Map<string, LfLens[]>();
  for (const l of lenses) {
    const key = `${l.maker[0] ?? ''}/${l.model[0] ?? ''}`;
    byName.set(key, [...(byName.get(key) ?? []), l]);
  }
  const lensById = new Map<string, LfLens>();
  for (const [key, list] of byName) {
    list.forEach((l, i) => {
      let id = list.length === 1 ? key : `${key}@${l.cropFactor}`;
      if (lensById.has(id)) id = `${key}#${i + 1}`;
      l.id = id;
      lensById.set(id, l);
    });
  }
  return { source: json.source, cameras, lenses, compat, lensById };
}

/** "Sony FE 50mm f/1.2 GM": the model, prefixed with the maker unless it already starts with it. */
export function lensDisplayName(lens: LfLens): string {
  return withMaker(lens.maker, lens.model[0] ?? '');
}

/** "Leica Q2": prefers the short (translated) maker name for the prefix. */
export function cameraDisplayName(camera: LfCamera): string {
  return withMaker(camera.maker.slice(1).concat(camera.maker.slice(0, 1)), camera.model[0] ?? '');
}

function withMaker(makers: string[], model: string): string {
  const lower = model.toLowerCase();
  if (!makers.length || makers.some((m) => lower.startsWith(m.toLowerCase()))) return model;
  return `${makers[0]} ${model}`;
}

// ---------------------------------------------------------------------------------------
// lfLens::GuessParameters (lens.cpp): focal and aperture ranges from the model name, else
// from the calibration data. Note the patterns are case-sensitive, as in Lensfun.

const LENS_NAME_PATTERNS: [RegExp, [number, number, number]][] = [
  // [min focal]-[max focal]mm f/[min aperture]-[max aperture]
  [/^[^:]*?([0-9]+[0-9.]*)[-]?([0-9]+[0-9.]*)?(mm)\s+(f\/|f|1\/|1:)?([0-9.]+)(-[0-9.]+)?.*$/, [1, 2, 5]],
  // 1:[min aperture]-[max aperture] [min focal]-[max focal]mm
  [/^.*?1:([0-9.]+)[-]?([0-9.]+)?\s+([0-9.]+)[-]?([0-9.]+)?(mm)?.*$/, [3, 4, 1]],
  // [min aperture]-[max aperture]/[min focal]-[max focal]
  [/^.*?([0-9.]+)[-]?([0-9.]+)?\s*\/\s*([0-9.]+)[-]?([0-9.]+)?.*$/, [3, 4, 1]],
];
// Lensfun's pattern has "[0.9]" where "[0-9]" was meant; kept as is.
const EXTENDER_PATTERN = /^.*?[0-9](\.[0.9]+)?x.*$/;
const atof = (s: string) => {
  const v = Number.parseFloat(s);
  return Number.isFinite(v) ? v : 0;
};

interface Ranges {
  minFocal: number;
  maxFocal: number;
  minAperture: number;
  maxAperture: number;
}

function guessParameters(lens: Ranges & { model: string[]; distortion?: LfDistortion[]; tca?: LfTca[]; vignetting?: LfVignetting[] }): void {
  const FMAX = 3.4028234663852886e38;
  const FMIN = 1.1754943508222875e-38; // numeric_limits<float>::min(), the smallest positive float
  let minf = FMAX;
  let maxf = FMIN;
  let mina = FMAX;
  let maxa = FMIN;
  const model = lens.model[0];
  if (
    model &&
    (!lens.minAperture || !lens.minFocal) &&
    !/adapter|reducer|booster|extender|converter|magnifier/.test(model) &&
    !EXTENDER_PATTERN.test(model)
  ) {
    for (const [re, [fMin, fMax, aMin]] of LENS_NAME_PATTERNS) {
      const m = re.exec(model);
      if (!m) continue;
      if (m[fMin] !== undefined) minf = atof(m[fMin]);
      if (m[fMax] !== undefined) maxf = atof(m[fMax]);
      if (m[aMin] !== undefined) mina = atof(m[aMin]);
      break;
    }
  }
  if (!lens.minAperture || !lens.minFocal) {
    for (const c of [...(lens.distortion ?? []), ...(lens.tca ?? [])]) {
      minf = Math.min(minf, c.focal);
      maxf = Math.max(maxf, c.focal);
    }
    for (const c of lens.vignetting ?? []) {
      minf = Math.min(minf, c.focal);
      maxf = Math.max(maxf, c.focal);
      mina = Math.min(mina, c.aperture);
      maxa = Math.max(maxa, c.aperture);
    }
  }
  if (minf !== FMAX && !lens.minFocal) lens.minFocal = minf;
  if (maxf !== FMIN && !lens.maxFocal) lens.maxFocal = maxf;
  if (mina !== FMAX && !lens.minAperture) lens.minAperture = mina;
  if (maxa !== FMIN && !lens.maxAperture) lens.maxAperture = maxa;
  if (!lens.maxFocal) lens.maxFocal = lens.minFocal;
}

// ---------------------------------------------------------------------------------------
// String matching (auxfun.cpp)

/** _lf_strcmp equality: case-insensitive, ignoring leading/trailing space, runs of space = one. */
function sameName(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
  return norm(a) === norm(b);
}

const isSpace = (c: string) => c === ' ' || (c >= '\t' && c <= '\r');
const isDigit = (c: string) => c >= '0' && c <= '9';
const isPunct = (c: string) => {
  const x = c.charCodeAt(0);
  return (x >= 33 && x <= 47) || (x >= 58 && x <= 64) || (x >= 91 && x <= 96) || (x >= 123 && x <= 126);
};
const byteOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * lfFuzzyStrCmp::Split: words are runs of digits (with dots; a trailing ".0" is dropped),
 * of punctuation, or of anything else. Single punctuation characters and a lone "f" are
 * skipped, except "*" and "+". Sorted, case-folded.
 */
export function fuzzyWords(str: string): string[] {
  const out: string[] = [];
  const n = str.length;
  let i = 0;
  while (i < n) {
    while (i < n && isSpace(str[i]!)) i++;
    if (i >= n) break;
    const start = i++;
    const c0 = str[start]!;
    let strip = 0;
    if (isDigit(c0)) {
      while (i < n && (isDigit(str[i]!) || str[i] === '.')) i++;
      if (i - start >= 2 && str[i - 2] === '.' && str[i - 1] === '0') strip = 2;
    } else if (isPunct(c0)) {
      while (i < n && isPunct(str[i]!)) i++;
    } else {
      while (i < n && !isSpace(str[i]!) && !isDigit(str[i]!) && !isPunct(str[i]!)) i++;
    }
    if (i - start === 1 && (isPunct(c0) || c0.toLowerCase() === 'f') && c0 !== '*' && c0 !== '+') continue;
    out.push(str.slice(start, i - strip).toLowerCase());
  }
  return out.sort(byteOrder);
}

/**
 * lfFuzzyStrCmp::Compare: 200 · matched / (pattern words + match words), so 100 when both
 * have the same words. With `allWords`, every pattern word must occur in the match
 * (Lensfun's default; LF_SEARCH_LOOSE turns it off).
 */
export function fuzzyCompare(pattern: string[], match: string[], allWords: boolean): number {
  if (!pattern.length || !match.length) return 0;
  let mi = 0;
  let score = 0;
  for (const p of pattern) {
    const old = mi;
    let found = false;
    for (; mi < match.length; mi++) {
      const r = byteOrder(p, match[mi]!);
      if (r === 0) {
        score++;
        found = true;
        break;
      }
      if (r < 0) break; // sorted: p cannot come later
    }
    if (found) mi++;
    else if (allWords) return 0;
    else mi = old;
  }
  return Math.trunc((score * 200) / (pattern.length + match.length));
}

/** Compare against a multi-language string: the best translation counts. */
function fuzzyCompareMl(pattern: string[], names: string[], allWords: boolean): number {
  let best = 0;
  for (const name of names) best = Math.max(best, fuzzyCompare(pattern, fuzzyWords(name), allWords));
  return best;
}

// ---------------------------------------------------------------------------------------
// Cameras

export interface CameraMatch {
  camera: LfCamera;
  /** 200 for an exact (case-insensitive) maker + model match, else lfFuzzyStrCmp maker + model scores. */
  score: number;
}

/**
 * lfDatabase::FindCameras (exact) and, failing that, FindCamerasExt (fuzzy, all words).
 * Translations count, so LibRaw's normalised names ("Nikon", "Z 7") match too.
 */
export function findCamera(db: LensfunDb, make: string, model: string): CameraMatch | null {
  if (!model.trim()) return null;
  const exact = db.cameras.find(
    (c) => (!make.trim() || c.maker.some((m) => sameName(m, make))) && c.model.some((m) => sameName(m, model)),
  );
  if (exact) return { camera: exact, score: 200 };
  const pMaker = fuzzyWords(make);
  const pModel = fuzzyWords(model);
  let best: CameraMatch | null = null;
  for (const camera of db.cameras) {
    const s1 = pMaker.length ? fuzzyCompareMl(pMaker, camera.maker, true) : 0;
    if (pMaker.length && !s1) continue;
    const s2 = fuzzyCompareMl(pModel, camera.model, true);
    if (!s2) continue;
    if (!best || s1 + s2 > best.score) best = { camera, score: s1 + s2 };
  }
  return best;
}

// ---------------------------------------------------------------------------------------
// Lenses

export interface LensMatch {
  lens: LfLens;
  /** lfDatabase::MatchScore (crop, focal/aperture, mount, name; higher is better). */
  score: number;
  /**
   * 'name': all words of the EXIF lens name found in a Lensfun name (Lensfun's default search);
   * 'fixed-lens': the camera's built-in lens, found by its mount; 'loose': partial name match
   * (Lensfun's LF_SEARCH_LOOSE), worth confirming in the UI; 'manual': chosen by id.
   */
  method: 'name' | 'fixed-lens' | 'loose' | 'manual';
}

const hasCalibration = (l: LfLens) => l.distortion.length > 0 || l.tca.length > 0 || l.vignetting.length > 0;

/** _lf_compare_num: 0 neutral (unknown), -1 mismatch, +1 match within 1 %. */
function compareNum(a: number, b: number): number {
  if (!a || !b) return 0;
  const r = a / b;
  return r <= 0.99 || r >= 1.01 ? -1 : 1;
}

/** lfDatabase::MatchScore (database.cpp); `nameScore` replaces the model comparison (null = no model given). */
function matchScore(pattern: Ranges, lens: LfLens, camera: LfCamera | null, compat: string[], nameScore: number | null): number {
  let score = 0;
  if (camera && hasCalibration(lens)) {
    const cc = camera.cropFactor;
    const lc = lens.cropFactor;
    let crop = 0;
    if (!(cc > 0.01 && cc < lc * 0.96)) {
      if (cc >= lc * 1.41) crop = 2;
      else if (cc >= lc * 1.31) crop = 4;
      else if (cc >= lc * 1.21) crop = 6;
      else if (cc >= lc * 1.11) crop = 8;
      else if (cc >= lc * 1.01) crop = 10;
      else if (cc >= lc) crop = 5;
      else if (cc >= lc * 0.96) crop = 3;
    }
    if (!crop) return 0;
    score += crop;
  }
  for (const [a, b] of [
    [pattern.minFocal, lens.minFocal],
    [pattern.maxFocal, lens.maxFocal],
    [pattern.minAperture, lens.minAperture],
    [pattern.maxAperture, lens.maxAperture],
  ] as const) {
    const c = compareNum(a, b);
    if (c < 0) return 0;
    if (c > 0) score += 10;
  }
  if (lens.mounts.length && (camera || compat.length)) {
    if (camera && lens.mounts.some((m) => sameName(m, camera.mount))) score += 10;
    else if (compat.some((c) => lens.mounts.some((m) => sameName(m, c)))) score += 9;
    else return 0;
  }
  if (nameScore !== null) {
    if (!nameScore) return 0;
    score += Math.max(1, Math.trunc((nameScore * 4) / 10));
  }
  return score;
}

/**
 * Model names to compare an EXIF lens string with: the model and its translations, and
 * each also prefixed with the maker, because EXIF strings often carry the brand ("Sony FE
 * 50mm F1.2 GM") where Lensfun keeps it in <maker> ("FE 50mm f/1.2 GM"). This extends
 * Lensfun, which compares <model> only.
 */
function nameVariants(lens: LfLens): string[] {
  const out = [...lens.model];
  for (const model of lens.model) {
    for (const maker of lens.maker) {
      if (!model.toLowerCase().startsWith(maker.toLowerCase())) out.push(`${maker} ${model}`);
    }
  }
  return out;
}

function lensPattern(name: string): Ranges {
  const p = { model: [name], minFocal: 0, maxFocal: 0, minAperture: 0, maxAperture: 0 };
  guessParameters(p);
  return p;
}

/** Can this lens have taken a photo at `focal` mm? Unknown values pass. */
function focalFits(lens: LfLens, focal: number): boolean {
  if (!(focal > 0) || !(lens.minFocal > 0)) return true;
  return focal >= lens.minFocal * 0.97 - 0.5 && focal <= Math.max(lens.minFocal, lens.maxFocal) * 1.03 + 0.5;
}

function ranked(db: LensfunDb, camera: LfCamera | null, pattern: Ranges, name: ((l: LfLens) => number) | null, filter: (l: LfLens) => boolean) {
  const compat = camera ? (db.compat.get(camera.mount) ?? []) : [];
  const out: LensMatch[] = [];
  for (const lens of db.lenses) {
    if (!filter(lens)) continue;
    const score = matchScore(pattern, lens, camera, compat, name ? name(lens) : null);
    if (score > 0) out.push({ lens, score, method: 'name' });
  }
  // Stable: equal scores keep database order.
  return out.sort((a, b) => b.score - a.score);
}

/**
 * Finds the lens of a photo, the way Lensfun's lfDatabase::FindLenses does, in this order:
 * 1. all words of `lensName` in the Lensfun name (with the maker-prefixed variants above);
 * 2. for fixed-lens cameras (lower-case mount), the lens on that mount, ignoring the name
 *    (compacts report generic EXIF names such as "28.0mm f/1.7");
 * 3. a loose name match that still contains every number of `lensName`.
 * Lenses whose focal range cannot contain `focalLength` are skipped throughout.
 */
export function findLens(db: LensfunDb, camera: LfCamera | null, lensName: string, focalLength = 0): LensMatch | null {
  const name = lensName.trim();
  const pattern = lensPattern(name);
  const fits = (l: LfLens) => focalFits(l, focalLength);
  if (name) {
    const words = fuzzyWords(name);
    const strict = ranked(db, camera, pattern, (l) => fuzzyCompareMl(words, nameVariants(l), true), fits);
    if (strict[0]) return strict[0];
  }
  if (camera?.fixedLens) {
    const fixed = ranked(db, camera, pattern, null, (l) => fits(l) && l.mounts.some((m) => sameName(m, camera.mount)));
    if (fixed[0]) return { ...fixed[0], method: 'fixed-lens' };
  }
  if (name) {
    const words = fuzzyWords(name);
    const numbers = words.filter((w) => isDigit(w[0]!));
    const loose = ranked(
      db,
      camera,
      pattern,
      (l) => fuzzyCompareMl(words, nameVariants(l), false),
      (l) => fits(l) && nameVariants(l).some((v) => numbers.every((n) => fuzzyWords(v).includes(n))),
    );
    if (loose[0]) return { ...loose[0], method: 'loose' };
  }
  return null;
}

/**
 * Lenses for a manual choice, best first: those with calibration data that fit the camera
 * (mount, adapters, crop factor) and contain every typed word, numbers exactly and other
 * words as prefixes ("sig 50 1.4" finds "Sigma 50mm f/1.4 DG HSM [A]"). Ranked by
 * Lensfun's MatchScore with the loose name comparison. Empty text lists every compatible lens.
 */
export function searchLenses(db: LensfunDb, camera: LfCamera | null, text: string, limit = 50): LensMatch[] {
  const name = text.trim();
  const words = fuzzyWords(name);
  const typed = (l: LfLens) =>
    nameVariants(l).some((v) => {
      const have = fuzzyWords(v);
      return words.every((q) => have.some((w) => (isDigit(q[0]!) ? w === q : w.startsWith(q))));
    });
  // Typed numbers are often partial ("50" for a 50-150 mm): no focal/aperture filter.
  const list = ranked(
    db,
    camera,
    { minFocal: 0, maxFocal: 0, minAperture: 0, maxAperture: 0 },
    words.length ? (l) => Math.max(1, fuzzyCompareMl(words, nameVariants(l), false)) : null,
    (l) => hasCalibration(l) && (!words.length || typed(l)),
  );
  return list
    .sort((a, b) => b.score - a.score || lensDisplayName(a.lens).length - lensDisplayName(b.lens).length)
    .slice(0, limit);
}

// ---------------------------------------------------------------------------------------
// Interpolation (lens.cpp)

/** _lf_interpolate (auxfun.cpp): cubic Hermite spline; a missing outer point (null) gives a one-sided tangent. */
export function hermite(y1: number | null, y2: number, y3: number, y4: number | null, t: number): number {
  const tg2 = y1 === null ? y3 - y2 : (y3 - y1) * 0.5;
  const tg3 = y4 === null ? y3 - y2 : (y4 - y2) * 0.5;
  const t2 = t * t;
  const t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * y2 + (t3 - 2 * t2 + t) * tg2 + (-2 * t3 + 3 * t2) * y3 + (t3 - t2) * tg3;
}

/**
 * The four calibrations around `focal` (__insert_spline): [1] is the nearest above, [0]
 * the next above, [2] the nearest below, [3] the next below. The spline runs from [1]
 * to [2]. Returns the exact match instead when there is one.
 */
function splineNeighbours<T extends { focal: number }>(rows: T[], focal: number): { exact: T } | { s: (T | null)[] } {
  const s: (T | null)[] = [null, null, null, null];
  const dist = [-Infinity, -Infinity, Infinity, Infinity];
  for (const c of rows) {
    const df = focal - c.focal;
    if (df === 0) return { exact: c };
    if (df < 0) {
      if (df > dist[1]!) {
        dist[0] = dist[1]!;
        s[0] = s[1]!;
        dist[1] = df;
        s[1] = c;
      } else if (df > dist[0]!) {
        dist[0] = df;
        s[0] = c;
      }
    } else if (df < dist[2]!) {
      dist[3] = dist[2]!;
      s[3] = s[2]!;
      dist[2] = df;
      s[2] = c;
    } else if (df < dist[3]!) {
      dist[3] = df;
      s[3] = c;
    }
  }
  return { s };
}

/** Lensfun uses a calibration made on a sensor at most 4 % larger than the camera's. */
const cropUsable = (lens: LfLens, crop: number) => crop / lens.cropFactor >= 0.96;

/**
 * lfLens::InterpolateDistortion: spline over focal length of terms · focal (the terms
 * roughly follow 1/f), divided by the target focal afterwards; the real focal length is
 * interpolated as is. Outside the calibrated range the nearest calibration is used.
 */
export function interpolateDistortion(lens: LfLens, crop: number, focal: number): LfDistortion | null {
  if (!lens.distortion.length || !cropUsable(lens, crop)) return null;
  const n = splineNeighbours(lens.distortion, focal);
  if ('exact' in n) return n.exact;
  const [s0, s1, s2, s3] = n.s;
  if (!s1 || !s2) return s1 ?? s2 ?? null;
  const t = (focal - s1.focal) / (s2.focal - s1.focal);
  const terms = s1.terms.map((_, i) =>
    hermite(s0 ? s0.terms[i]! * s0.focal : null, s1.terms[i]! * s1.focal, s2.terms[i]! * s2.focal, s3 ? s3.terms[i]! * s3.focal : null, t) / focal,
  );
  const realFocal = hermite(s0?.realFocal ?? null, s1.realFocal, s2.realFocal, s3?.realFocal ?? null, t);
  return { focal, model: s1.model, terms, realFocal };
}

/** lfLens::InterpolateTCA: like distortion, but the near-1 terms (kr, kb / vr, vb) are not scaled by focal. */
export function interpolateTca(lens: LfLens, crop: number, focal: number): LfTca | null {
  if (!lens.tca.length || !cropUsable(lens, crop)) return null;
  const n = splineNeighbours(lens.tca, focal);
  if ('exact' in n) return n.exact;
  const [s0, s1, s2, s3] = n.s;
  if (!s1 || !s2) return s1 ?? s2 ?? null;
  const t = (focal - s1.focal) / (s2.focal - s1.focal);
  const scale = (i: number, f: number) => (i < 2 ? 1 : f);
  const terms = s1.terms.map((_, i) =>
    hermite(
      s0 ? s0.terms[i]! * scale(i, s0.focal) : null,
      s1.terms[i]! * scale(i, s1.focal),
      s2.terms[i]! * scale(i, s2.focal),
      s3 ? s3.terms[i]! * scale(i, s3.focal) : null,
      t,
    ) / scale(i, focal),
  ) as LfTca['terms'];
  return { focal, model: s1.model, terms };
}

/**
 * lfLens::InterpolateVignetting: inverse distance weighting (power 3.5) in a space of
 * normalised focal length, 4 / aperture and 0.1 / distance. Gives up when the nearest
 * calibration is further than 1 in that space.
 */
export function interpolateVignetting(lens: LfLens, crop: number, focal: number, aperture: number, distance: number): LfVignetting | null {
  if (!lens.vignetting.length || !cropUsable(lens, crop)) return null;
  const df = lens.maxFocal - lens.minFocal;
  const nf = (f: number) => (df !== 0 ? (f - lens.minFocal) / df : f - lens.minFocal);
  const k = [0, 0, 0];
  let total = 0;
  let nearest = Infinity;
  for (const c of lens.vignetting) {
    const d = Math.hypot(nf(c.focal) - nf(focal), 4 / c.aperture - 4 / aperture, 0.1 / c.distance - 0.1 / distance);
    if (d < 0.0001) return c;
    nearest = Math.min(nearest, d);
    const w = Math.abs(1 / d ** 3.5);
    for (let i = 0; i < 3; i++) k[i]! += w * c.k[i]!;
    total += w;
  }
  if (nearest > 1 || !(total > 0)) return null;
  return { focal, aperture, distance, k: [k[0]! / total, k[1]! / total, k[2]! / total] };
}

// ---------------------------------------------------------------------------------------
// Conversion to LensCorrection

/** Lensfun's "infinity" for an unknown focus distance (darktable's default too). */
export const DEFAULT_DISTANCE = 1000;

/**
 * Converts a Lensfun calibration into the renderer's model for a decoded image of
 * width x height pixels taken with a camera of crop factor `cameraCrop`.
 *
 * Coordinates (modifier.cpp, mod-coord.cpp, mod-subpix.cpp, mod-color.cpp at the pinned
 * commit): lfModifier normalises pixel offsets from the image centre ((W-1)/2, pixel
 * centres) by NormScale = 43.27 mm / crop / hypot(W, H) / realFocal, i.e. the image
 * diagonal is the camera's sensor diagonal. The Hugin-style models (ptlens, poly3, poly5,
 * linear and poly3 TCA) are defined with r = 1 at half the height of the calibration
 * sensor (crop Cl, aspect Al); the pa vignetting model has r = 1 at its corner.
 * rescale_polynomial_coefficients maps both into the normalised units. In the frame used
 * here (r = 1 at the corner of the decoded image, scale = [W, H] / (hypot(W, H) / 2)):
 *   Hugin radius    = r · hypot(Al, 1) · Cl / Cc   (=: r · ρ)
 *   pa radius       = r · Cl / Cc
 * The real focal length cancels out of both. PT models are rescaled by their d = 1 - a - b - c
 * like Lensfun does (a/d⁴, b/d³, c/d²), so the image centre keeps its magnification.
 * Lensfun applies distortion first and TCA to the distorted (green) position; linear TCA
 * is a factor on the polynomial, poly3 TCA with c, b terms is fitted (fitRadialPoly).
 */
export function lensfunToCorrection(
  lens: LfLens,
  cameraCrop: number,
  photo: { focal: number; aperture: number; distance?: number; width: number; height: number },
): LensCorrection | null {
  const { width: w, height: h, focal } = photo;
  if (!(w > 0 && h > 0 && focal > 0 && cameraCrop > 0)) return null;
  const n = Math.hypot(w, h) / 2;
  const frame = {
    // lfModifier: centre at (W-1)/2 + min(W-1, H-1)/2 · lens.CenterX in pixel-centre coordinates.
    center: [
      0.5 + (Math.min(w - 1, h - 1) * lens.center[0]) / (2 * w),
      0.5 + (Math.min(w - 1, h - 1) * lens.center[1]) / (2 * h),
    ] as [number, number],
    scale: [w / n, h / n] as [number, number],
  };
  const cropRatio = lens.cropFactor / cameraCrop;

  let geometry: LensCorrection['geometry'] = null;
  if (lens.type === 'rectilinear') {
    const rho = Math.hypot(lens.aspectRatio, 1) * cropRatio;
    const dist = interpolateDistortion(lens, cameraCrop, focal);
    const tca = interpolateTca(lens, cameraCrop, focal);
    const green = dist ? distortionPoly(dist, rho) : ([...IDENTITY_POLY] as RadialPoly);
    if (dist || tca) {
      geometry = { ...frame, poly: tca ? tcaPolys(green, tca, rho) : [green, green, green] };
    }
  }

  let vignetting: LensCorrection['vignetting'] = null;
  if (photo.aperture > 0) {
    const v = interpolateVignetting(lens, cameraCrop, focal, photo.aperture, photo.distance || DEFAULT_DISTANCE);
    if (v) {
      const q = cropRatio * cropRatio;
      vignetting = { ...frame, mode: 'divide', k: [v.k[0] * q, v.k[1] * q * q, v.k[2] * q * q * q, 0, 0] };
    }
  }

  if (!geometry && !vignetting) return null;
  return { source: `Lensfun: ${lensDisplayName(lens)}`, geometry, vignetting };
}

/** ModifyCoord_Dist_* after rescale_polynomial_coefficients, in units where the Hugin radius is r · rho. */
export function distortionPoly(d: LfDistortion, rho: number): RadialPoly {
  const p = [...IDENTITY_POLY] as RadialPoly;
  const [t0 = 0, t1 = 0, t2 = 0] = d.terms;
  if (d.model === 'ptlens') {
    // Rd = Ru (a Ru³ + b Ru² + c Ru + d)
    const dd = 1 - t0 - t1 - t2;
    p[1] = (t2 * rho) / dd ** 2;
    p[2] = (t1 * rho ** 2) / dd ** 3;
    p[3] = (t0 * rho ** 3) / dd ** 4;
  } else if (d.model === 'poly3') {
    // Rd = Ru (1 - k1 + k1 Ru²)
    const dd = 1 - t0;
    p[2] = (t0 * rho ** 2) / dd ** 3;
  } else {
    // Rd = Ru (1 + k1 Ru² + k2 Ru⁴)
    p[2] = t0 * rho ** 2;
    p[4] = t1 * rho ** 4;
  }
  return p;
}

const evalPoly = (p: RadialPoly, r: number) => {
  let s = 0;
  for (let i = 6; i >= 0; i--) s = s * r + p[i]!;
  return s;
};

/** Red and blue after ModifyCoord_TCA_Linear / ModifyCoord_TCA_Poly3, composed with the green distortion. */
export function tcaPolys(green: RadialPoly, tca: LfTca, rho: number): [RadialPoly, RadialPoly, RadialPoly] {
  const [vr, vb, cr, cb, br, bb] = tca.terms;
  const times = (k: number) => green.map((c) => c * k) as RadialPoly;
  if (tca.model === 'linear' || (cr === 0 && cb === 0 && br === 0 && bb === 0)) return [times(vr), green, times(vb)];
  const range = fitRange(green);
  const channel = (v: number, c: number, b: number) =>
    fitRadialPoly((r) => {
      const rd = r * evalPoly(green, r);
      return rd * (v + c * rho * rd + b * rho * rho * rd * rd);
    }, range);
  return [channel(vr, cr, br), green, channel(vb, cb, bb)];
}

/**
 * Radius range a fit has to cover: every ideal point whose green source lies inside the
 * image, i.e. up to where the distortion reaches the corner (r = 1), plus a margin for
 * the colour channels. Strong barrel models fold back before reaching the corner
 * (r_src stops growing); nothing beyond the fold is usable (autoScale stops there too),
 * and fitting across it would cost accuracy where it matters.
 */
function fitRange(green: RadialPoly): number {
  let prev = 0;
  for (let i = 1; i <= 300; i++) {
    const x = i / 100;
    const rd = x * evalPoly(green, x);
    if (rd >= 1 || rd <= prev) return Math.max(1, x) * 1.05;
    prev = rd;
  }
  return 3 * 1.05;
}

// ---------------------------------------------------------------------------------------
// Main entry

export interface LensfunResult {
  correction: LensCorrection;
  /** Display names. */
  camera: string;
  lens: string;
  /** For opts.lens, to re-apply a choice. */
  lensId: string;
  /** Lens match score (see LensMatch.score). */
  score: number;
  method: LensMatch['method'];
}

/**
 * Finds camera and lens for a photo and returns its correction, or null when Lensfun has
 * no usable profile. `opts.lens` forces a lens by id (LfLens.id); `opts.cropFactor` stands
 * in for the camera's crop factor when the camera is not in the database.
 */
export function lensfunCorrection(db: LensfunDb, query: LensQuery, opts: { lens?: string; cropFactor?: number } = {}): LensfunResult | null {
  const cam = findCamera(db, query.cameraMake, query.cameraModel);
  const crop = cam?.camera.cropFactor ?? opts.cropFactor ?? 0;
  if (!(crop > 0)) return null;

  let match: LensMatch | null;
  if (opts.lens !== undefined) {
    const lens = db.lensById.get(opts.lens);
    if (!lens) return null;
    const compat = cam ? (db.compat.get(cam.camera.mount) ?? []) : [];
    // The user's choice wins; the score only says how well it fits the camera.
    match = { lens, score: matchScore(lensPattern(''), lens, cam?.camera ?? null, compat, null), method: 'manual' };
  } else {
    match = findLens(db, cam?.camera ?? null, query.lens, query.focalLength);
  }
  if (!match) return null;

  const { lens } = match;
  // A prime's focal length is known even when EXIF is missing it.
  const focal = query.focalLength > 0 ? query.focalLength : lens.minFocal > 0 && lens.minFocal === lens.maxFocal ? lens.minFocal : 0;
  const correction = lensfunToCorrection(lens, crop, {
    focal,
    aperture: query.aperture,
    distance: query.distance,
    width: query.width,
    height: query.height,
  });
  if (!correction) return null;
  return {
    correction,
    camera: cam ? cameraDisplayName(cam.camera) : `${query.cameraMake} ${query.cameraModel}`.trim(),
    lens: lensDisplayName(lens),
    lensId: lens.id,
    score: match.score,
    method: match.method,
  };
}
