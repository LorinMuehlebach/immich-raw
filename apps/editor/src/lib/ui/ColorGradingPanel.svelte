<script lang="ts">
  // Lightroom's Color Grading: shadow / midtone / highlight wheels (3-way view), a global
  // wheel, and Blending / Balance.
  import { formatParam, GRADING_BALANCE, GRADING_BLENDING, GRADING_PARAMS, WHEEL_LABELS, WHEELS, type ParamSpec, type Wheel } from '@immich-raw/recipe';
  import { editor } from '../state/editor.svelte.ts';
  import ColorWheel from './ColorWheel.svelte';
  import Section from './Section.svelte';
  import Slider from './Slider.svelte';

  type View = '3way' | Wheel;
  let view = $state<View>('3way');

  const g = $derived(editor.recipe.colorGrading);
  const set = (spec: ParamSpec) => (v: number) => editor.setParam(spec, v);
  const LUM_TRACK = 'linear-gradient(90deg, #111, #eee)';

  function resetWheel(w: Wheel) {
    const p = GRADING_PARAMS[w];
    editor.resetParams([p.hue, p.sat, p.lum], `Reset ${WHEEL_LABELS[w]}`);
  }

  function resetAll() {
    editor.resetParams([...WHEELS.flatMap((w) => Object.values(GRADING_PARAMS[w])), GRADING_BLENDING, GRADING_BALANCE], 'Reset Color Grading');
  }

  const hueTrack = 'linear-gradient(90deg, hsl(0 70% 50%), hsl(60 70% 50%), hsl(120 70% 50%), hsl(180 70% 50%), hsl(240 70% 50%), hsl(300 70% 50%), hsl(359 70% 50%))';
  const satTrack = (h: number) => `linear-gradient(90deg, #808080, hsl(${h} 80% 50%))`;
</script>

{#snippet compact(w: Wheel, size: number)}
  {@const p = GRADING_PARAMS[w]}
  <div class="cell">
    <div class="cap">
      {WHEEL_LABELS[w]}
      <span class="dim">{g[w].sat > 0 ? `${g[w].hue}° · ${g[w].sat}` : ''}</span>
    </div>
    <ColorWheel
      hue={g[w].hue}
      sat={g[w].sat}
      {size}
      label={WHEEL_LABELS[w]}
      disabled={editor.readOnly}
      onchange={(h, s) => editor.setWheel(w, h, s)}
      oncommit={() => editor.commit()}
      onreset={() => resetWheel(w)}
    />
    <div class="lum" title="Luminance (double-click to reset)">
      <input
        type="range"
        min={p.lum.min}
        max={p.lum.max}
        step="1"
        value={g[w].lum}
        disabled={editor.readOnly}
        aria-label="{WHEEL_LABELS[w]} luminance"
        oninput={(e) => editor.setParam(p.lum, Number(e.currentTarget.value))}
        onchange={() => editor.commit()}
        ondblclick={() => editor.resetParam(p.lum)}
      />
      <span class="val">{formatParam(p.lum, g[w].lum)}</span>
    </div>
  </div>
{/snippet}

<Section title="Color Grading" open={false}>
  {#snippet actions()}
    <button class="small" onclick={resetAll} disabled={editor.readOnly}>Reset</button>
  {/snippet}

  <div class="tabs">
    <button class:active={view === '3way'} onclick={() => (view = '3way')} title="Shadows, midtones and highlights">3-Way</button>
    {#each WHEELS as w (w)}
      <button class:active={view === w} onclick={() => (view = w)}>{WHEEL_LABELS[w]}</button>
    {/each}
  </div>

  {#if view === '3way'}
    <div class="three">
      <div class="top">{@render compact('midtones', 112)}</div>
      <div class="pair">
        {@render compact('shadows', 104)}
        {@render compact('highlights', 104)}
      </div>
    </div>
  {:else}
    {@const p = GRADING_PARAMS[view]}
    <div class="single">
      <ColorWheel
        hue={g[view].hue}
        sat={g[view].sat}
        size={180}
        label={WHEEL_LABELS[view]}
        disabled={editor.readOnly}
        onchange={(h, s) => editor.setWheel(view as Wheel, h, s)}
        oncommit={() => editor.commit()}
        onreset={() => resetWheel(view as Wheel)}
      />
    </div>
    <Slider spec={p.hue} value={g[view].hue} track={hueTrack} onchange={set(p.hue)} oncommit={() => editor.commit()} onreset={() => editor.resetParam(p.hue)} disabled={editor.readOnly} />
    <Slider spec={p.sat} value={g[view].sat} track={satTrack(g[view].hue)} onchange={set(p.sat)} oncommit={() => editor.commit()} onreset={() => editor.resetParam(p.sat)} disabled={editor.readOnly} />
    <Slider spec={p.lum} value={g[view].lum} track={LUM_TRACK} onchange={set(p.lum)} oncommit={() => editor.commit()} onreset={() => editor.resetParam(p.lum)} disabled={editor.readOnly} />
  {/if}

  {#if view !== 'global'}
    <div class="sep"></div>
    <Slider spec={GRADING_BLENDING} value={g.blending} onchange={set(GRADING_BLENDING)} oncommit={() => editor.commit()} onreset={() => editor.resetParam(GRADING_BLENDING)} disabled={editor.readOnly} />
    <Slider spec={GRADING_BALANCE} value={g.balance} onchange={set(GRADING_BALANCE)} oncommit={() => editor.commit()} onreset={() => editor.resetParam(GRADING_BALANCE)} disabled={editor.readOnly} />
  {/if}
  <p class="hint">Drag in a wheel to pick a tint; Shift-drag changes only the strength. Double-click a wheel to reset it.</p>
</Section>

<style>
  .tabs {
    display: flex;
    gap: 3px;
    margin-bottom: 10px;
  }
  .tabs button {
    flex: 1;
    padding: 2px 2px;
    font-size: 10.5px;
  }
  .tabs button.active {
    border-color: var(--accent);
    color: var(--text-bright);
  }
  .three {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .top {
    display: flex;
    justify-content: center;
  }
  .pair {
    display: flex;
    justify-content: space-around;
  }
  .cell {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    width: 130px;
  }
  .cap {
    font-size: 11px;
    color: var(--text);
    display: flex;
    gap: 6px;
  }
  .dim {
    color: var(--text-dim);
  }
  .lum {
    display: flex;
    align-items: center;
    gap: 4px;
    width: 100%;
  }
  .lum input {
    flex: 1;
    min-width: 0;
    accent-color: #bbb;
  }
  .val {
    font: 11px ui-monospace, SFMono-Regular, Consolas, monospace;
    width: 30px;
    text-align: right;
    color: var(--text-dim);
  }
  .single {
    display: flex;
    justify-content: center;
    margin: 4px 0 10px;
  }
  .sep {
    height: 8px;
  }
  .hint {
    color: var(--text-dim);
    font-size: 11px;
    margin: 8px 0 0;
  }
  .small {
    padding: 2px 8px;
    font-size: 11px;
  }
</style>
