// Turns what the models found (an "analysis") into the map of one AI component: pick and
// combine the right maps, sharpen the edges along the photo's own edges (guided filter), then
// map the result from the upright analysis image back to the decoded image.
import { guidedFilter } from '@immich-raw/pipeline/dehaze';
import type { LandscapeClass, PersonPart } from '@immich-raw/recipe';
import { faceBox, faceParts } from './faces.ts';
import { luma, resampleToSource, resizeMap } from './image.ts';
import type { Affine, AiSpec, ByteMap, PeopleMaps, PersonInfo, RasterResult, RgbaImage, SceneClass, SceneMaps } from './types.ts';

/** Everything known about one photo; maps may be at any resolution. */
export interface Analysis {
  /** The image the models saw (upright); compose works at its size. */
  image: RgbaImage;
  subject?: ByteMap;
  scene?: SceneMaps;
  people?: PeopleMaps;
  /** The object found for this component's box or points. */
  object?: ByteMap;
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

const up = (m: { width: number; height: number; data: ArrayLike<number> } | undefined, w: number, h: number): Float32Array =>
  m ? resizeMap(m.data, m.width, m.height, w, h, 1 / 255) : new Float32Array(w * h);

function sceneMap(a: Analysis, c: SceneClass, w: number, h: number): Float32Array {
  if (c === 'snow') return snowMap(a, w, h);
  const s = a.scene;
  return up(s && s.maps[c] ? { width: s.width, height: s.height, data: s.maps[c]! } : undefined, w, h);
}

/**
 * Snow: ADE20K has no class for it, so it is found by colour (bright and nearly neutral)
 * where the scene model sees ground, mountains, plants or buildings, and not sky.
 */
function snowMap(a: Analysis, w: number, h: number): Float32Array {
  const sky = sceneMap(a, 'sky', w, h);
  const person = sceneMap(a, 'person', w, h);
  const ground = new Float32Array(w * h);
  for (const c of ['naturalGround', 'mountains', 'vegetation', 'architecture', 'artificialGround'] as const) {
    const m = sceneMap(a, c, w, h);
    for (let i = 0; i < m.length; i++) ground[i] = ground[i]! + m[i]!;
  }
  const d = a.image.data;
  const out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) {
    const r = d[i * 4]!;
    const g = d[i * 4 + 1]!;
    const b = d[i * 4 + 2]!;
    const max = Math.max(r, g, b);
    const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    const chroma = (max - Math.min(r, g, b)) / Math.max(1, max);
    out[i] = smoothstep(0.55, 0.75, l) * (1 - smoothstep(0.1, 0.22, chroma)) * (1 - sky[i]!) * (1 - person[i]!) * smoothstep(0.15, 0.4, ground[i]!);
  }
  return out;
}

/** Faces (indices) whose centre lies in group `id`. */
function facesOf(p: PeopleMaps, id: number): number[] {
  const out: number[] = [];
  p.faces.forEach((lm, i) => {
    const [x0, y0, x1, y1] = faceBox(lm);
    const x = Math.min(p.width - 1, Math.max(0, Math.floor(((x0 + x1) / 2) * p.width)));
    const y = Math.min(p.height - 1, Math.max(0, Math.floor(((y0 + y1) / 2) * p.height)));
    if (p.labels[y * p.width + x] === id) out.push(i);
  });
  return out;
}

/**
 * The part of the photo that belongs to the person at `at` (normalised): their group of
 * people, split between the faces in it when there are several (each pixel goes to the
 * nearest face, measured mostly sideways, as bodies hang below faces). Also returns their
 * faces. null region: nobody there.
 */
export function personRegion(p: PeopleMaps, at: [number, number], w: number, h: number): { region: Float32Array; faces: Float32Array[] } | null {
  const px = Math.min(p.width - 1, Math.max(0, Math.floor(at[0] * p.width)));
  const py = Math.min(p.height - 1, Math.max(0, Math.floor(at[1] * p.height)));
  let id = p.labels[py * p.width + px]!;
  if (!id) {
    // Close to a group (within 10 % of the image)? Take that one.
    let best = 0.1;
    p.groups.forEach(([x0, y0, x1, y1], i) => {
      const dx = Math.max(x0 - at[0], 0, at[0] - x1);
      const dy = Math.max(y0 - at[1], 0, at[1] - y1);
      const d = Math.hypot(dx, dy);
      if (d < best) {
        best = d;
        id = i + 1;
      }
    });
  }
  if (!id) return null;
  const faceIdx = facesOf(p, id);
  const centres = faceIdx.map((i) => {
    const [x0, y0, x1, y1] = faceBox(p.faces[i]!);
    return { i, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, fw: Math.max(1e-3, x1 - x0) };
  });
  let mine = centres[0];
  for (const c of centres) if (Math.hypot(c.cx - at[0], c.cy - at[1]) < Math.hypot(mine!.cx - at[0], mine!.cy - at[1])) mine = c;
  const region = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const ly = Math.min(p.height - 1, Math.floor(((y + 0.5) / h) * p.height));
    for (let x = 0; x < w; x++) {
      const lx = Math.min(p.width - 1, Math.floor(((x + 0.5) / w) * p.width));
      if (p.labels[ly * p.width + lx] !== id) continue;
      if (centres.length > 1) {
        const u = (x + 0.5) / w;
        const v = (y + 0.5) / h;
        let near = centres[0]!;
        let nd = Infinity;
        for (const c of centres) {
          const d = Math.abs(u - c.cx) / c.fw + (0.25 * Math.abs(v - c.cy)) / c.fw;
          if (d < nd) {
            nd = d;
            near = c;
          }
        }
        if (near !== mine) continue;
      }
      region[y * w + x] = 1;
    }
  }
  const faces = centres.length > 1 ? [p.faces[mine!.i]!] : faceIdx.map((i) => p.faces[i]!);
  return { region, faces };
}

const FACE_PARTS: PersonPart[] = ['faceSkin', 'eyebrows', 'eyeSclera', 'iris', 'lips', 'teeth', 'facialHair', 'hair'];

function peopleMap(spec: AiSpec, a: Analysis, w: number, h: number): Float32Array {
  const p = a.people;
  const out = new Float32Array(w * h);
  if (!p) return out;
  let faces = p.faces;
  let region: Float32Array | null = null;
  if (spec.person) {
    const r = personRegion(p, spec.person, w, h);
    if (!r) return out;
    region = r.region;
    faces = r.faces;
  }
  const parts = spec.parts?.length ? spec.parts : (['person'] as PersonPart[]);
  const map = (k: 'hair' | 'bodySkin' | 'faceSkin' | 'clothes' | 'anyone') => up({ width: p.width, height: p.height, data: p[k] }, w, h);
  const f = parts.some((x) => FACE_PARTS.includes(x)) ? faceParts(faces, w, h) : null;
  const hair = parts.includes('hair') || parts.includes('facialHair') || parts.includes('faceSkin') ? map('hair') : null;
  const facialHair = hair && f ? hair.map((v, i) => v * f.lowerFace[i]!) : null;
  let l: Float32Array | null = null;
  let mouthLuma = 0;
  if (parts.includes('teeth') && f) {
    l = luma(a.image);
    let sum = 0;
    let n = 0;
    for (let i = 0; i < f.mouth.length; i++) {
      if (f.mouth[i]) {
        sum += l[i]!;
        n++;
      }
    }
    mouthLuma = n ? sum / n : 1;
  }
  const add = (m: ArrayLike<number>) => {
    for (let i = 0; i < out.length; i++) out[i] = Math.max(out[i]!, m[i]!);
  };
  for (const part of parts) {
    switch (part) {
      case 'person':
        add(map('anyone'));
        break;
      case 'bodySkin':
        add(map('bodySkin'));
        break;
      case 'clothes':
        add(map('clothes'));
        break;
      case 'hair':
        add(hair!.map((v, i) => v * (1 - (facialHair?.[i] ?? 0))));
        break;
      case 'facialHair':
        if (facialHair) add(facialHair);
        break;
      case 'faceSkin': {
        const s = map('faceSkin');
        if (f) for (let i = 0; i < s.length; i++) s[i] = s[i]! * (1 - Math.max(f.eyes[i]!, f.brows[i]!, f.lips[i]!, f.mouth[i]!, facialHair?.[i] ?? 0));
        add(s);
        break;
      }
      case 'eyebrows':
        if (f) add(f.brows);
        break;
      case 'eyeSclera':
        if (f) add(f.eyes.map((v, i) => v * (1 - f.iris[i]!)));
        break;
      case 'iris':
        if (f) add(f.iris);
        break;
      case 'lips':
        if (f) add(f.lips);
        break;
      case 'teeth':
        if (f && l) {
          const d = a.image.data;
          add(
            f.mouth.map((v, i) => {
              if (!v) return 0;
              const max = Math.max(d[i * 4]!, d[i * 4 + 1]!, d[i * 4 + 2]!);
              const chroma = (max - Math.min(d[i * 4]!, d[i * 4 + 1]!, d[i * 4 + 2]!)) / Math.max(1, max);
              return smoothstep(mouthLuma * 0.95, mouthLuma * 1.2 + 0.04, l![i]!) * (1 - smoothstep(0.15, 0.35, chroma));
            }),
          );
        }
        break;
    }
  }
  if (region) for (let i = 0; i < out.length; i++) out[i] = out[i]! * region[i]!;
  return out;
}

/** The component's map at the analysis image's size, before edge refinement. */
export function coarseMap(spec: AiSpec, a: Analysis): Float32Array {
  const { width: w, height: h } = a.image;
  switch (spec.target) {
    case 'subject':
      return up(a.subject, w, h);
    case 'background':
      return up(a.subject, w, h).map((v) => 1 - v);
    case 'object':
      return up(a.object, w, h);
    case 'sky':
      return sceneMap(a, 'sky', w, h);
    case 'landscape': {
      const out = new Float32Array(w * h);
      for (const c of spec.classes ?? ([] as LandscapeClass[])) {
        const m = sceneMap(a, c, w, h);
        for (let i = 0; i < out.length; i++) out[i] = Math.min(1, out[i]! + m[i]!);
      }
      return out;
    }
    case 'people':
      return peopleMap(spec, a, w, h);
  }
}

/**
 * Edge-aware refinement: the map's edges snap to the photo's edges (guided filter), then the
 * soft band left along them is narrowed. Without that, darkening a sky leaves a pale glow
 * around masts and branches (and brightening a subject spills into the sky).
 */
export function refine(map: Float32Array, guide: Float32Array, w: number, h: number, spec: Pick<AiSpec, 'target'>): Float32Array {
  const diag = Math.hypot(w, h);
  // The scene model sees the photo at 512 px: its edges need a wider window.
  const frac = spec.target === 'sky' || spec.target === 'landscape' ? 0.006 : spec.target === 'people' ? 0.002 : 0.003;
  const r = Math.max(2, Math.round(frac * diag));
  const q = guidedFilter(guide, map, w, h, r, 1e-3);
  for (let i = 0; i < q.length; i++) q[i] = smoothstep(0.3, 0.7, q[i]!);
  return q;
}

/** Fraction of the image a map must cover (above half) to count as found. */
const MIN_AREA = 0.0002;

/**
 * The finished map of one component, rw x rh over the decoded image. sToT maps the decoded
 * image (0..1) to the analysis image (0..1).
 */
export function composeRaster(spec: AiSpec, a: Analysis, out: { width: number; height: number; sToT: Affine }, guide = luma(a.image)): RasterResult {
  const { width: w, height: h } = a.image;
  const coarse = coarseMap(spec, a);
  const fine = refine(coarse, guide, w, h, spec);
  let n = 0;
  for (let i = 0; i < fine.length; i++) if (fine[i]! > 0.5) n++;
  const empty = n < MIN_AREA * fine.length;
  const data = empty ? new Uint8Array(out.width * out.height) : resampleToSource(fine, w, h, out.sToT, out.width, out.height);
  return { width: out.width, height: out.height, data, empty };
}

/** The people found, left to right: each face, and groups with no face found. */
export function listPeople(p: PeopleMaps): PersonInfo[] {
  const out: PersonInfo[] = p.faces.map((lm) => {
    const box = faceBox(lm);
    return { at: [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2], box };
  });
  p.groups.forEach((g, i) => {
    if (!facesOf(p, i + 1).length) out.push({ at: [(g[0] + g[2]) / 2, (g[1] + g[3]) / 2], box: g });
  });
  return out.sort((a, b) => a.at[0] - b.at[0]);
}
