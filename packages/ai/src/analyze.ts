// What each model contributes to a photo's analysis (runs in the AI worker). Inputs and
// sizes follow the models' own preprocessing; see docs/spike-results.md for how they were
// chosen.
import { ADE_CLASSES, ADE_GROUPS } from './ade.ts';
import { faceBox, LANDMARKS } from './faces.ts';
import { cropRgba, fitSize, resizeMap, resizeRgba, toBytes, toTensor } from './image.ts';
import { regions } from './labels.ts';
import type { Runtime } from './runtime.ts';
import type { ByteMap, PeopleMaps, RgbaImage, SceneClass, SceneMaps } from './types.ts';

const IMAGENET_MEAN = [0.485, 0.456, 0.406];
const IMAGENET_STD = [0.229, 0.224, 0.225];

/** Subject matte (IS-Net, 1024 x 1024, min-max normalised as the model's authors do). */
async function matte(rt: Runtime, img: RgbaImage): Promise<Float32Array> {
  const x = toTensor(img, 1024, 1024, [128, 128, 128], [256, 256, 256], 1);
  const { inputs, outputs } = await rt.names('subject');
  const out = await rt.run('subject', { [inputs[0]!]: await rt.tensor('float32', x, [1, 3, 1024, 1024]) });
  const m = out[outputs[0]!]!.data as Float32Array;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < 1024 * 1024; i++) {
    lo = Math.min(lo, m[i]!);
    hi = Math.max(hi, m[i]!);
  }
  const k = 1 / Math.max(1e-6, hi - lo);
  const f = new Float32Array(1024 * 1024);
  for (let i = 0; i < f.length; i++) f[i] = (m[i]! - lo) * k;
  return f;
}

/** The main subject, at up to 1024 px. */
export async function analyzeSubject(rt: Runtime, img: RgbaImage): Promise<ByteMap> {
  const f = await matte(rt, img);
  const [w, h] = fitSize(img.width, img.height, 1024);
  return { width: w, height: h, data: toBytes(resizeMap(f, 1024, 1024, w, h)) };
}

/**
 * Lightroom's rectangle around an object: the subject model looks inside the box (plus a
 * margin) and only what it finds there counts, fading out over the margin.
 */
export async function analyzeObjectBox(rt: Runtime, img: RgbaImage, box: [number, number, number, number]): Promise<ByteMap> {
  const { width: W, height: H } = img;
  const [bx0, by0, bx1, by1] = [box[0] * W, box[1] * H, box[2] * W, box[3] * H];
  const mx = Math.max(4, (bx1 - bx0) * 0.1);
  const my = Math.max(4, (by1 - by0) * 0.1);
  const x0 = Math.max(0, Math.floor(bx0 - mx));
  const y0 = Math.max(0, Math.floor(by0 - my));
  const x1 = Math.min(W, Math.ceil(bx1 + mx));
  const y1 = Math.min(H, Math.ceil(by1 + my));
  const crop = cropRgba(img, x0, y0, x1, y1);
  const f = resizeMap(await matte(rt, crop), 1024, 1024, crop.width, crop.height);
  const out = new Uint8Array(W * H);
  for (let y = 0; y < crop.height; y++) {
    const py = y0 + y + 0.5;
    const fy = Math.min(1, Math.max(0, (Math.min(py - (by0 - my), by1 + my - py)) / my));
    for (let x = 0; x < crop.width; x++) {
      const px = x0 + x + 0.5;
      const fx = Math.min(1, Math.max(0, (Math.min(px - (bx0 - mx), bx1 + mx - px)) / mx));
      out[(y0 + y) * W + x0 + x] = Math.round(Math.min(1, f[y * crop.width + x]!) * Math.min(fx, fy) * 255);
    }
  }
  return { width: W, height: H, data: out };
}

/** Probability of each Lightroom landscape category (UperNet on ADE20K, 512 x 512). */
export async function analyzeScene(rt: Runtime, img: RgbaImage): Promise<SceneMaps> {
  const x = toTensor(img, 512, 512, IMAGENET_MEAN, IMAGENET_STD);
  const { inputs, outputs } = await rt.names('scene');
  const out = await rt.run('scene', { [inputs[0]!]: await rt.tensor('float32', x, [1, 3, 512, 512]) });
  const logits = out[outputs[0]!]!;
  const [, , lh, lw] = logits.dims as number[];
  const l = logits.data as Float32Array;
  const n = lh! * lw!;
  // Softmax over the classes, then the sum over each category's classes.
  const groups = Object.entries(ADE_GROUPS) as [Exclude<SceneClass, 'snow'>, number[]][];
  const sums = groups.map(() => new Float32Array(n));
  const owner = new Int16Array(ADE_CLASSES).fill(-1);
  groups.forEach(([, ids], g) => ids.forEach((id) => (owner[id] = g)));
  for (let i = 0; i < n; i++) {
    let max = -Infinity;
    for (let c = 0; c < ADE_CLASSES; c++) max = Math.max(max, l[c * n + i]!);
    let total = 0;
    for (let c = 0; c < ADE_CLASSES; c++) total += Math.exp(l[c * n + i]! - max);
    for (let c = 0; c < ADE_CLASSES; c++) {
      const g = owner[c]!;
      if (g >= 0) sums[g]![i]! += Math.exp(l[c * n + i]! - max) / total;
    }
  }
  const [w, h] = fitSize(img.width, img.height, 512);
  const maps: SceneMaps['maps'] = {};
  groups.forEach(([name], g) => (maps[name] = toBytes(resizeMap(sums[g]!, lw!, lh!, w, h))));
  return { width: w, height: h, maps };
}

/** Square tiles (start offsets) covering a0..a1 with half-overlap. */
function tileStarts(a0: number, a1: number, side: number): number[] {
  if (a1 - a0 <= side) return [a0];
  const k = Math.ceil((a1 - a0 - side) / (side / 2)) + 1;
  return Array.from({ length: k }, (_, j) => Math.round(a0 + (j * (a1 - a0 - side)) / (k - 1)));
}

const toImageData = (img: RgbaImage) => new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);

/**
 * People and their parts. The scene model finds where people are; MediaPipe's multiclass
 * segmenter (256 px) runs on overlapping tiles over each group, so small people keep their
 * detail; faces found in the face-skin map get MediaPipe's face landmarks.
 */
export async function analyzePeople(rt: Runtime, img: RgbaImage, scene: SceneMaps): Promise<PeopleMaps> {
  const [pw, ph] = fitSize(img.width, img.height, 1024);
  const n = pw * ph;
  const person = scene.maps.person ? resizeMap(scene.maps.person, scene.width, scene.height, pw, ph, 1 / 255) : new Float32Array(n);
  const { labels, boxes } = regions(person, pw, ph, 0.5, Math.max(16, n * 0.0015));
  const p: PeopleMaps = {
    width: pw,
    height: ph,
    hair: new Uint8Array(n),
    bodySkin: new Uint8Array(n),
    faceSkin: new Uint8Array(n),
    clothes: new Uint8Array(n),
    anyone: new Uint8Array(n),
    labels,
    groups: [],
    faces: [],
  };
  if (!boxes.length) return p;
  const segmenter = await rt.segmenterTask();
  const sx = img.width / pw;
  const sy = img.height / ph;
  // Parts the segmenter reports (0 is background, 5 accessories).
  const parts: [keyof Pick<PeopleMaps, 'hair' | 'bodySkin' | 'faceSkin' | 'clothes'>, number][] = [['hair', 1], ['bodySkin', 2], ['faceSkin', 3], ['clothes', 4]];
  for (const [bx0, by0, bx1, by1] of boxes) {
    const padX = (bx1 - bx0) * 0.1 + 4;
    const padY = (by1 - by0) * 0.1 + 4;
    // Box in analysis-image pixels.
    const X0 = Math.max(0, Math.floor((bx0 - padX) * sx));
    const Y0 = Math.max(0, Math.floor((by0 - padY) * sy));
    const X1 = Math.min(img.width, Math.ceil((bx1 + padX) * sx));
    const Y1 = Math.min(img.height, Math.ceil((by1 + padY) * sy));
    p.groups.push([X0 / img.width, Y0 / img.height, X1 / img.width, Y1 / img.height]);
    const side = Math.max(64, Math.min(X1 - X0, Y1 - Y0, Math.round(0.45 * Math.max(X1 - X0, Y1 - Y0))));
    for (const ty of tileStarts(Y0, Y1, side)) {
      for (const tx of tileStarts(X0, X1, side)) {
        const tile = cropRgba(img, tx, ty, Math.min(img.width, tx + side), Math.min(img.height, ty + side));
        const res = segmenter.segment(toImageData(tile));
        try {
          const masks = res.confidenceMasks ?? [];
          const read = (k: number) => {
            const m = masks[k];
            return m ? { w: m.width, h: m.height, d: m.getAsFloat32Array() } : null;
          };
          const bg = read(0);
          const layers = parts.map(([name, k]) => [name, read(k)] as const);
          // Write into the part maps (pw x ph) over the tile's footprint.
          const fx0 = Math.floor(tx / sx);
          const fy0 = Math.floor(ty / sy);
          const fx1 = Math.min(pw, Math.ceil((tx + tile.width) / sx));
          const fy1 = Math.min(ph, Math.ceil((ty + tile.height) / sy));
          for (let y = fy0; y < fy1; y++) {
            const v = ((y + 0.5) * sy - ty) / tile.height;
            if (v < 0 || v >= 1) continue;
            for (let x = fx0; x < fx1; x++) {
              const u = ((x + 0.5) * sx - tx) / tile.width;
              if (u < 0 || u >= 1) continue;
              const i = y * pw + x;
              const at = (m: { w: number; h: number; d: Float32Array }) => m.d[Math.min(m.h - 1, Math.floor(v * m.h)) * m.w + Math.min(m.w - 1, Math.floor(u * m.w))]!;
              if (bg) p.anyone[i] = Math.max(p.anyone[i]!, Math.round((1 - at(bg)) * 255));
              for (const [name, m] of layers) if (m) p[name][i] = Math.max(p[name][i]!, Math.round(at(m) * 255));
            }
          }
        } finally {
          res.close();
        }
      }
    }
  }
  // Faces: each patch of face skin, cropped square and handed to the landmarker.
  const faces = regions(p.faceSkin, pw, ph, 127, Math.max(12, n * 0.00005));
  const landmarker = faces.boxes.length ? await rt.landmarkerTask() : null;
  for (const [fx0, fy0, fx1, fy1] of faces.boxes) {
    const cx = ((fx0 + fx1) / 2) * sx;
    const cy = ((fy0 + fy1) / 2) * sy;
    const r = Math.max((fx1 - fx0) * sx, (fy1 - fy0) * sy);
    const X0 = Math.max(0, Math.floor(cx - r));
    const Y0 = Math.max(0, Math.floor(cy - r));
    const X1 = Math.min(img.width, Math.ceil(cx + r));
    const Y1 = Math.min(img.height, Math.ceil(cy + r));
    if (X1 - X0 < 16 || Y1 - Y0 < 16) continue;
    const crop = resizeRgba(cropRgba(img, X0, Y0, X1, Y1), 256, 256);
    const res = landmarker!.detect(toImageData(crop));
    for (const lm of res.faceLandmarks) {
      const pts = new Float32Array(LANDMARKS * 2);
      for (let i = 0; i < Math.min(LANDMARKS, lm.length); i++) {
        pts[2 * i] = (X0 + lm[i]!.x * (X1 - X0)) / img.width;
        pts[2 * i + 1] = (Y0 + lm[i]!.y * (Y1 - Y0)) / img.height;
      }
      // The same face found from two skin patches: keep one.
      const b = faceBox(pts);
      const dup = p.faces.some((q) => {
        const c = faceBox(q);
        const ix = Math.max(0, Math.min(b[2], c[2]) - Math.max(b[0], c[0]));
        const iy = Math.max(0, Math.min(b[3], c[3]) - Math.max(b[1], c[1]));
        return ix * iy > 0.3 * Math.min((b[2] - b[0]) * (b[3] - b[1]), (c[2] - c[0]) * (c[3] - c[1]));
      });
      if (!dup) p.faces.push(pts);
    }
  }
  return p;
}

/** Segment Anything's image embedding (computed once per photo). */
export interface SamEmbedding {
  embeddings: Float32Array;
  positional: Float32Array;
  /** Scale from analysis-image pixels to the model's 1024 px frame. */
  scale: number;
  w: number;
  h: number;
}

export async function samEmbedding(rt: Runtime, img: RgbaImage): Promise<SamEmbedding> {
  const scale = 1024 / Math.max(img.width, img.height);
  const w = Math.round(img.width * scale);
  const h = Math.round(img.height * scale);
  const x = toTensor(img, w, h, IMAGENET_MEAN, IMAGENET_STD, 1 / 255, 1024, 1024);
  const { inputs, outputs } = await rt.names('objectEncoder');
  const out = await rt.run('objectEncoder', { [inputs[0]!]: await rt.tensor('float32', x, [1, 3, 1024, 1024]) });
  return { embeddings: out[outputs[0]!]!.data as Float32Array, positional: out[outputs[1]!]!.data as Float32Array, scale, w, h };
}

/**
 * Lightroom's brush over an object: Segment Anything with the brushed points as positive
 * clicks. Of its three answers, the one that is confident and covers most of the points wins.
 */
export async function analyzeObjectPoints(rt: Runtime, img: RgbaImage, emb: SamEmbedding, points: number[]): Promise<ByteMap> {
  const all: [number, number][] = [];
  for (let i = 0; i + 1 < points.length; i += 2) all.push([points[i]!, points[i + 1]!]);
  // Up to 8 points, spread along the strokes.
  const pick = all.length <= 8 ? all : Array.from({ length: 8 }, (_, k) => all[Math.round((k * (all.length - 1)) / 7)]!);
  const coords = new Float32Array(pick.length * 2);
  pick.forEach(([u, v], i) => {
    coords[2 * i] = u * img.width * emb.scale;
    coords[2 * i + 1] = v * img.height * emb.scale;
  });
  const out = await rt.run('objectDecoder', {
    input_points: await rt.tensor('float32', coords, [1, 1, pick.length, 2]),
    input_labels: await rt.tensor('int64', new BigInt64Array(pick.length).fill(1n), [1, 1, pick.length]),
    image_embeddings: await rt.tensor('float32', emb.embeddings, [1, 256, 64, 64]),
    image_positional_embeddings: await rt.tensor('float32', emb.positional, [1, 256, 64, 64]),
  });
  const iou = out.iou_scores!.data as Float32Array;
  const masks = out.pred_masks!.data as Float32Array;
  const [, , k, mh, mw] = out.pred_masks!.dims as number[];
  // The masks cover the padded 1024 square; the image is its top-left w x h.
  const vw = Math.max(1, Math.round((emb.w / 1024) * mw!));
  const vh = Math.max(1, Math.round((emb.h / 1024) * mh!));
  let best: Float32Array | null = null;
  let bestScore = -Infinity;
  for (let m = 0; m < k!; m++) {
    const plane = masks.subarray(m * mw! * mh!, (m + 1) * mw! * mh!);
    const valid = new Float32Array(vw * vh);
    for (let y = 0; y < vh; y++) for (let x = 0; x < vw; x++) valid[y * vw + x] = plane[y * mw! + x]!;
    let hit = 0;
    for (const [u, v] of pick) if (valid[Math.min(vh - 1, Math.floor(v * vh)) * vw + Math.min(vw - 1, Math.floor(u * vw))]! > 0) hit++;
    const score = iou[m]! * (hit / pick.length);
    if (score > bestScore) {
      bestScore = score;
      best = valid;
    }
  }
  const up = resizeMap(best!, vw, vh, img.width, img.height);
  for (let i = 0; i < up.length; i++) up[i] = 1 / (1 + Math.exp(-up[i]!));
  return { width: img.width, height: img.height, data: toBytes(up) };
}
