// Dehaze by the dark channel prior (He et al.), estimated once on the low-resolution
// analysis image so the preview and every export tile use the same airlight and
// transmission map.

export interface DehazeEstimate {
  /** Haze colour in scene-linear working space. */
  airlight: [number, number, number];
  /** Transmission 0.1..1, row-major, top row first. */
  transmission: Float32Array;
  width: number;
  height: number;
}

/** Separable sliding minimum with radius r (edge pixels clamp). */
function minFilter(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = Infinity;
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) m = Math.min(m, src[y * w + k]!);
      tmp[y * w + x] = m;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let m = Infinity;
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) m = Math.min(m, tmp[k * w + x]!);
      out[y * w + x] = m;
    }
  }
  return out;
}

/** Box mean with radius r via a summed-area table. */
function boxMean(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const sat = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += src[y * w + x]!;
      sat[(y + 1) * (w + 1) + x + 1] = sat[y * (w + 1) + x + 1]! + row;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      const s = sat[y1 * (w + 1) + x1]! - sat[y0 * (w + 1) + x1]! - sat[y1 * (w + 1) + x0]! + sat[y0 * (w + 1) + x0]!;
      out[y * w + x] = s / ((x1 - x0) * (y1 - y0));
    }
  }
  return out;
}

/** Guided filter of p with guide I (both w*h). */
export function guidedFilter(I: Float32Array, p: Float32Array, w: number, h: number, r: number, eps: number): Float32Array {
  const n = w * h;
  const Ip = new Float32Array(n);
  const II = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    Ip[i] = I[i]! * p[i]!;
    II[i] = I[i]! * I[i]!;
  }
  const mI = boxMean(I, w, h, r);
  const mp = boxMean(p, w, h, r);
  const mIp = boxMean(Ip, w, h, r);
  const mII = boxMean(II, w, h, r);
  const a = new Float32Array(n);
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const cov = mIp[i]! - mI[i]! * mp[i]!;
    const v = mII[i]! - mI[i]! * mI[i]!;
    a[i] = cov / (v + eps);
    b[i] = mp[i]! - a[i]! * mI[i]!;
  }
  const ma = boxMean(a, w, h, r);
  const mb = boxMean(b, w, h, r);
  const q = new Float32Array(n);
  for (let i = 0; i < n; i++) q[i] = ma[i]! * I[i]! + mb[i]!;
  return q;
}

/**
 * @param lin RGBA float pixels (scene-linear, exposure applied), w*h*4, top row first
 * @param strength 0..1 (Dehaze slider / 100, positive side)
 * @param radius dark-channel window radius in pixels
 */
export function estimateDehaze(lin: Float32Array, w: number, h: number, strength: number, radius: number): DehazeEstimate {
  const n = w * h;
  const minC = new Float32Array(n);
  const gray = new Float32Array(n);
  let maxY = 1e-6;
  for (let i = 0; i < n; i++) {
    const r = Math.max(0, lin[i * 4]!);
    const g = Math.max(0, lin[i * 4 + 1]!);
    const b = Math.max(0, lin[i * 4 + 2]!);
    minC[i] = Math.min(r, g, b);
    const y = 0.288 * r + 0.712 * g;
    gray[i] = y;
    if (y > maxY) maxY = y;
  }
  // Airlight: mean colour of the 0.1% pixels with the brightest dark channel.
  const dark = minFilter(minC, w, h, radius);
  const order = Array.from(dark.keys()).sort((a, b) => dark[b]! - dark[a]!);
  const top = Math.max(1, Math.floor(n * 0.001));
  const A: [number, number, number] = [0, 0, 0];
  for (let k = 0; k < top; k++) {
    const i = order[k]!;
    for (let c = 0; c < 3; c++) A[c] += Math.max(0, lin[i * 4 + c]!);
  }
  for (let c = 0; c < 3; c++) A[c] = Math.max(A[c]! / top, 1e-4);

  const norm = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    norm[i] = Math.min(
      Math.max(0, lin[i * 4]!) / A[0],
      Math.max(0, lin[i * 4 + 1]!) / A[1],
      Math.max(0, lin[i * 4 + 2]!) / A[2],
    );
  }
  const darkN = minFilter(norm, w, h, radius);
  const omega = 0.95 * Math.min(1, Math.max(0, strength));
  const tRaw = new Float32Array(n);
  for (let i = 0; i < n; i++) tRaw[i] = 1 - omega * Math.min(1, darkN[i]!);
  for (let i = 0; i < n; i++) gray[i] = gray[i]! / maxY;
  const refined = guidedFilter(gray, tRaw, w, h, radius * 2, 1e-3);
  for (let i = 0; i < n; i++) refined[i] = Math.min(1, Math.max(0.1, refined[i]!));
  return { airlight: A, transmission: refined, width: w, height: h };
}
