<script lang="ts">
  // Waveform, RGB parade or vectorscope of the rendered preview, with its graticule.
  import { SKIN_TONE_ANGLE, VECTOR_TARGETS, fromChroma, scopeDensity, type ScopeData, type ScopeKind } from '@immich-raw/pipeline';

  let { kind, data }: { kind: Exclude<ScopeKind, 'histogram'>; data: ScopeData | null } = $props();

  const LABELS = { waveform: 'Waveform', parade: 'RGB parade', vectorscope: 'Vectorscope' };
  const PARADE: [number, number, number][] = [
    [255, 95, 95],
    [95, 225, 115],
    [115, 155, 255],
  ];
  const LUMA: [number, number, number] = [225, 232, 225];
  const PARADE_GAP = 8;

  const vector = $derived(kind === 'vectorscope');
  // Canvas pixels: twice the CSS size, for sharp lines on high-density screens.
  const W = $derived(vector ? 320 : 512);
  const H = $derived(vector ? 320 : 256);
  let canvas: HTMLCanvasElement | undefined = $state();

  /** The bins as a small picture: one canvas pixel per bin, brightness from the density. */
  function binsImage(width: number, height: number, density: Float32Array, color: (i: number) => [number, number, number], flip: boolean): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    const img = new ImageData(width, height);
    for (let y = 0; y < height; y++) {
      // Waveform rows count up from black; the picture has black at the bottom.
      const src = (flip ? height - 1 - y : y) * width;
      for (let x = 0; x < width; x++) {
        const d = density[src + x]!;
        if (!d) continue;
        const [r, g, b] = color(src + x);
        const o = (y * width + x) * 4;
        img.data[o] = r;
        img.data[o + 1] = g;
        img.data[o + 2] = b;
        img.data[o + 3] = Math.round(255 * d);
      }
    }
    c.getContext('2d')!.putImageData(img, 0, 0);
    return c;
  }

  /** Each vectorscope bin in its own hue, light enough to read near the centre. */
  const hueCache = new Map<number, Uint8Array>();
  function hues(size: number): Uint8Array {
    let t = hueCache.get(size);
    if (t) return t;
    t = new Uint8Array(size * size * 3);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const rgb = fromChroma(0.6, (x + 0.5) / size - 0.5, 0.5 - (y + 0.5) / size);
        for (let k = 0; k < 3; k++) t[(y * size + x) * 3 + k] = Math.round(255 * (0.35 + 0.65 * Math.max(0, Math.min(1, rgb[k]!))));
      }
    }
    hueCache.set(size, t);
    return t;
  }

  function drawWaveform(ctx: CanvasRenderingContext2D, d: Extract<ScopeData, { kind: 'waveform' | 'parade' }>): void {
    const n = d.channels.length;
    const panel = (W - PARADE_GAP * (n - 1)) / n;
    d.channels.forEach((bins, i) => {
      const color = n === 1 ? LUMA : PARADE[i]!;
      ctx.drawImage(binsImage(d.columns, d.levels, scopeDensity(bins), () => color, true), i * (panel + PARADE_GAP), 0, panel, H);
    });
  }

  /** Lines at 0, 25, 50, 75 and 100 %. */
  function drawWaveGraticule(ctx: CanvasRenderingContext2D): void {
    ctx.strokeStyle = 'rgba(255,255,255,0.13)';
    ctx.lineWidth = 1;
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.font = '16px system-ui, sans-serif';
    for (const p of [0, 25, 50, 75, 100]) {
      const y = Math.round((1 - p / 100) * (H - 1)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }
    ctx.textBaseline = 'top';
    ctx.fillText('100', 3, 3);
    ctx.textBaseline = 'bottom';
    ctx.fillText('0', 3, H - 3);
  }

  function drawVectorscope(ctx: CanvasRenderingContext2D, d: Extract<ScopeData, { kind: 'vectorscope' }>): void {
    const t = hues(d.size);
    const color = (i: number): [number, number, number] => [t[i * 3]!, t[i * 3 + 1]!, t[i * 3 + 2]!];
    ctx.drawImage(binsImage(d.size, d.size, scopeDensity(d.bins), color, false), 0, 0, W, H);
  }

  function drawVectorGraticule(ctx: CanvasRenderingContext2D): void {
    const cx = W / 2;
    const cy = H / 2;
    const at = (cb: number, cr: number): [number, number] => [(cb + 0.5) * W, (0.5 - cr) * H];
    ctx.strokeStyle = 'rgba(255,255,255,0.13)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, W / 2 - 1, 0, 2 * Math.PI);
    ctx.moveTo(cx, 8);
    ctx.lineTo(cx, H - 8);
    ctx.moveTo(8, cy);
    ctx.lineTo(W - 8, cy);
    ctx.stroke();
    // Skin tone line.
    const a = (SKIN_TONE_ANGLE * Math.PI) / 180;
    ctx.strokeStyle = 'rgba(255,200,160,0.4)';
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a) * (W / 2 - 1), cy - Math.sin(a) * (H / 2 - 1));
    ctx.stroke();
    // 75 % colour targets.
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.font = '15px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const g of VECTOR_TARGETS) {
      const [x, y] = at(g.cb, g.cr);
      ctx.strokeRect(x - 6, y - 6, 12, 12);
      const len = Math.hypot(g.cb, g.cr) || 1;
      ctx.fillText(g.label, x + (g.cb / len) * 20, y - (g.cr / len) * 20);
    }
  }

  $effect(() => {
    const ctx = canvas?.getContext('2d');
    if (!ctx) return;
    const d = data;
    ctx.clearRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = true;
    if (d?.kind === 'vectorscope') drawVectorscope(ctx, d);
    else if (d) drawWaveform(ctx, d);
    if (vector) drawVectorGraticule(ctx);
    else drawWaveGraticule(ctx);
  });
</script>

<div class="plot" class:vector>
  <canvas bind:this={canvas} width={W} height={H} aria-label={LABELS[kind]}></canvas>
</div>

<style>
  canvas {
    display: block;
    width: 100%;
    height: 128px;
  }
  .vector canvas {
    width: 160px;
    height: 160px;
    margin: 0 auto;
  }
</style>
