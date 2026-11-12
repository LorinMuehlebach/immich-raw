<script lang="ts">
  // RGB histogram of the rendered preview, with Lightroom's clipping triangles (inside Scopes).
  import type { Histogram } from '@immich-raw/pipeline';

  let { histogram, clipping, onToggleClipping }: { histogram: Histogram | null; clipping: boolean; onToggleClipping: () => void } = $props();

  let canvas: HTMLCanvasElement | undefined = $state();
  const W = 256;
  const H = 96;

  const clip = $derived.by(() => {
    if (!histogram || !histogram.total) return { lo: false, hi: false };
    const lim = histogram.total * 0.0002;
    const lo = histogram.r[0]! + histogram.g[0]! + histogram.b[0]! > lim * 3;
    const hi = histogram.r[255]! > lim || histogram.g[255]! > lim || histogram.b[255]! > lim;
    return { lo, hi };
  });

  $effect(() => {
    const h = histogram;
    const ctx = canvas?.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);
    if (!h || !h.total) return;
    // Scale by a high percentile of the inner bins so one spike doesn't flatten everything.
    const inner: number[] = [];
    for (let i = 2; i < 254; i++) inner.push(h.r[i]!, h.g[i]!, h.b[i]!);
    inner.sort((a, b) => a - b);
    const peak = Math.max(1, inner[Math.floor(inner.length * 0.995)]!);
    ctx.globalCompositeOperation = 'lighter';
    const channels: [Uint32Array, string][] = [
      [h.r, 'rgba(220,60,60,0.75)'],
      [h.g, 'rgba(60,200,80,0.75)'],
      [h.b, 'rgba(70,110,235,0.8)'],
    ];
    for (const [data, color] of channels) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(0, H);
      for (let i = 0; i < 256; i++) ctx.lineTo(i, H - Math.min(1, data[i]! / peak) * (H - 4));
      ctx.lineTo(W, H);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  });
</script>

<div class="hist">
  <canvas bind:this={canvas} width={W} height={H} aria-label="Histogram"></canvas>
  <button class="tri lo" class:lit={clip.lo} class:on={clipping} title="Show shadow clipping (J)" aria-label="Show shadow clipping" onclick={onToggleClipping}></button>
  <button class="tri hi" class:lit={clip.hi} class:on={clipping} title="Show highlight clipping (J)" aria-label="Show highlight clipping" onclick={onToggleClipping}></button>
</div>

<style>
  .hist {
    position: relative;
  }
  canvas {
    width: 100%;
    height: 96px;
    display: block;
  }
  .tri {
    position: absolute;
    top: 0;
    width: 0;
    height: 0;
    padding: 0;
    border: 7px solid transparent;
    background: none;
    border-radius: 0;
  }
  .tri.lo {
    left: 0;
    border-left-color: #555;
    border-top-color: #555;
  }
  .tri.hi {
    right: 0;
    border-right-color: #555;
    border-top-color: #555;
  }
  .tri.lo.lit {
    border-left-color: #5a8cff;
    border-top-color: #5a8cff;
  }
  .tri.hi.lit {
    border-right-color: #ff5a5a;
    border-top-color: #ff5a5a;
  }
  .tri.on.lo {
    border-left-color: #fff;
    border-top-color: #fff;
  }
  .tri.on.hi {
    border-right-color: #fff;
    border-top-color: #fff;
  }
</style>
