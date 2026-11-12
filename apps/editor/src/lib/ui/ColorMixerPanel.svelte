<script lang="ts">
  // Lightroom's Color Mixer (HSL) panel; with the Monochrome profile it becomes the B&W mix.
  import { BANDS, BW_PARAMS, MIXER_CHANNELS, MIXER_PARAMS, type Band, type MixerChannel, type ParamSpec } from '@immich-raw/recipe';
  import { editor } from '../state/editor.svelte.ts';
  import Section from './Section.svelte';
  import Slider from './Slider.svelte';

  type View = MixerChannel | 'all';
  let view = $state<View>('hue');

  const mono = $derived(editor.recipe.profile === 'monochrome');
  const tatOn = $derived(editor.tool === 'tat');

  // Band centres as HSV/HSL hues, and how far a ±100 hue shift reaches (60 % of the gap).
  const CENTRE: Record<Band, number> = { red: 0, orange: 30, yellow: 60, green: 120, aqua: 180, blue: 240, purple: 270, magenta: 300 };
  const hsl = (h: number, s = 85, l = 50) => `hsl(${((h % 360) + 360) % 360} ${s}% ${l}%)`;
  function track(channel: MixerChannel | 'bw', b: Band): string {
    const i = BANDS.indexOf(b);
    const c = CENTRE[b];
    const prev = CENTRE[BANDS[(i + 7) % 8]!];
    const next = CENTRE[BANDS[(i + 1) % 8]!];
    const gapPrev = (c - prev + 360) % 360;
    const gapNext = (next - c + 360) % 360;
    if (channel === 'hue') return `linear-gradient(90deg, ${hsl(c - gapPrev * 0.6)}, ${hsl(c)}, ${hsl(c + gapNext * 0.6)})`;
    if (channel === 'saturation') return `linear-gradient(90deg, #808080, ${hsl(c, 95)})`;
    if (channel === 'luminance') return `linear-gradient(90deg, ${hsl(c, 70, 18)}, ${hsl(c, 70, 50)}, ${hsl(c, 70, 85)})`;
    return `linear-gradient(90deg, #1e1e1e, ${hsl(c, 70, 45)}, #e8e8e8)`;
  }

  const LABEL: Record<View, string> = { hue: 'Hue', saturation: 'Saturation', luminance: 'Luminance', all: 'All' };
  const shown = $derived<MixerChannel[]>(view === 'all' ? MIXER_CHANNELS : [view]);

  function selectView(v: View) {
    view = v;
    if (v !== 'all') editor.setTatTarget(v);
  }

  function toggleTat() {
    if (!mono && view !== 'all') editor.setTatTarget(view);
    editor.setTool(tatOn ? 'edit' : 'tat');
  }

  function reset() {
    if (mono) editor.resetParams(Object.values(BW_PARAMS), 'Reset B&W');
    else editor.resetParams(shown.flatMap((c) => Object.values(MIXER_PARAMS[c])), view === 'all' ? 'Reset Color Mixer' : `Reset ${LABEL[view]}`);
  }

  const set = (spec: ParamSpec) => (v: number) => editor.setParam(spec, v);
</script>

<Section title={mono ? 'B&W' : 'Color Mixer'} open={false}>
  {#snippet actions()}
    <button
      class="icon tat"
      class:active={tatOn}
      onclick={toggleTat}
      disabled={editor.readOnly}
      title="Targeted adjustment: drag up or down on a colour in the photo"
      aria-label="Targeted adjustment"
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="7" /><circle cx="12" cy="12" r="1.5" fill="currentColor" /><path d="M12 1v5M12 18v5M1 12h5M18 12h5" /></svg>
    </button>
    <button class="small" onclick={reset} disabled={editor.readOnly}>Reset</button>
  {/snippet}

  {#if mono}
    {#each BANDS as b (b)}
      <Slider
        spec={BW_PARAMS[b]}
        value={editor.value(BW_PARAMS[b])}
        track={track('bw', b)}
        onchange={set(BW_PARAMS[b])}
        oncommit={() => editor.commit()}
        onreset={() => editor.resetParam(BW_PARAMS[b])}
        disabled={editor.readOnly}
      />
    {/each}
  {:else}
    <div class="tabs">
      {#each ['hue', 'saturation', 'luminance', 'all'] as const as v (v)}
        <button class:active={view === v} onclick={() => selectView(v)}>{LABEL[v]}</button>
      {/each}
    </div>
    {#each shown as channel (channel)}
      {#if view === 'all'}<div class="sub">{LABEL[channel]}</div>{/if}
      {#each BANDS as b (b)}
        {@const spec = MIXER_PARAMS[channel][b]}
        <Slider
          {spec}
          value={editor.value(spec)}
          track={track(channel, b)}
          onchange={set(spec)}
          oncommit={() => editor.commit()}
          onreset={() => editor.resetParam(spec)}
          disabled={editor.readOnly}
        />
      {/each}
    {/each}
  {/if}

  {#if tatOn}
    <p class="hint">
      Drag up or down on the photo to change the {mono ? 'B&W mix' : LABEL[editor.tatTarget === 'bw' ? 'saturation' : editor.tatTarget].toLowerCase()} of the colour under the pointer. Esc to finish.
    </p>
  {/if}
</Section>

<style>
  .tabs {
    display: flex;
    gap: 4px;
    margin-bottom: 8px;
  }
  .tabs button {
    flex: 1;
    padding: 2px 4px;
    font-size: 11px;
  }
  .tabs button.active {
    border-color: var(--accent);
    color: var(--text-bright);
  }
  .sub {
    color: var(--text-dim);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin: 8px 0 2px;
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
  .tat {
    padding: 1px 4px;
    display: flex;
    align-items: center;
  }
  .tat.active {
    border-color: var(--accent);
    color: var(--accent);
  }
</style>
