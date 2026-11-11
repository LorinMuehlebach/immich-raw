// Connected regions of a mask (8-connected), largest first: separate groups of people.

export interface Regions {
  /** Region number 1..n per pixel, 0 = outside. */
  labels: Uint8Array;
  /** Bounding box of each region in pixels (x0, y0, x1, y1), x1/y1 exclusive. */
  boxes: [number, number, number, number][];
}

/**
 * Labels the pixels where mask > threshold, keeping regions of at least minArea pixels,
 * at most 255 of them (the largest).
 */
export function regions(mask: ArrayLike<number>, w: number, h: number, threshold: number, minArea: number): Regions {
  const id = new Int32Array(w * h).fill(-1);
  const found: { pixels: number[]; box: [number, number, number, number] }[] = [];
  const stack: number[] = [];
  for (let start = 0; start < w * h; start++) {
    if (id[start] !== -1 || mask[start]! <= threshold) continue;
    const pixels: number[] = [];
    const box: [number, number, number, number] = [w, h, 0, 0];
    id[start] = found.length;
    stack.push(start);
    while (stack.length) {
      const i = stack.pop()!;
      pixels.push(i);
      const x = i % w;
      const y = (i - x) / w;
      box[0] = Math.min(box[0], x);
      box[1] = Math.min(box[1], y);
      box[2] = Math.max(box[2], x + 1);
      box[3] = Math.max(box[3], y + 1);
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const j = ny * w + nx;
          if (id[j] === -1 && mask[j]! > threshold) {
            id[j] = found.length;
            stack.push(j);
          }
        }
      }
    }
    found.push({ pixels, box });
  }
  const kept = found.filter((r) => r.pixels.length >= minArea).sort((a, b) => b.pixels.length - a.pixels.length).slice(0, 255);
  const labels = new Uint8Array(w * h);
  kept.forEach((r, k) => {
    for (const i of r.pixels) labels[i] = k + 1;
  });
  return { labels, boxes: kept.map((r) => r.box) };
}
