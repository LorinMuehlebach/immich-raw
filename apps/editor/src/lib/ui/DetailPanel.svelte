<script lang="ts">
  import { PARAMS, type ParamSpec } from '@immich-raw/recipe';
  import { ALT_VIEW, editor } from '../state/editor.svelte.ts';
  import Section from './Section.svelte';
  import Slider from './Slider.svelte';

  const sharpening: ParamSpec[] = [PARAMS.sharpenAmount, PARAMS.sharpenRadius, PARAMS.sharpenDetail, PARAMS.sharpenMasking];
  const noise: ParamSpec[] = [PARAMS.nrLuminance, PARAMS.nrLuminanceDetail, PARAMS.nrLuminanceContrast, PARAMS.nrColor, PARAMS.nrColorDetail, PARAMS.nrColorSmoothness];

  // Like Lightroom, the refining sliders only do something once their main slider is up.
  const inactive = (spec: ParamSpec) =>
    ((spec === PARAMS.nrLuminanceDetail || spec === PARAMS.nrLuminanceContrast) && editor.recipe.detail.nrLuminance === 0) ||
    ((spec === PARAMS.nrColorDetail || spec === PARAMS.nrColorSmoothness) && editor.recipe.detail.nrColor === 0);

  const slider = (spec: ParamSpec) => {
    const view = ALT_VIEW[spec.path];
    return {
      spec,
      value: editor.value(spec),
      onchange: (v: number) => editor.setParam(spec, v),
      oncommit: () => editor.commit(),
      onreset: () => editor.resetParam(spec),
      onalt: view ? (on: boolean) => editor.setMaskView(on ? view : 'none') : undefined,
      disabled: editor.readOnly || inactive(spec),
    };
  };
</script>

<Section title="Detail" open={false}>
  <div class="sub">Sharpening</div>
  {#each sharpening as spec (spec.path)}
    <Slider {...slider(spec)} />
  {/each}
  <div class="sub">Noise Reduction</div>
  {#each noise as spec (spec.path)}
    <Slider {...slider(spec)} />
  {/each}
  <p class="hint">Sharpening and noise reduction act at full resolution: double-click the photo to see them at 100 %. Alt-drag a sharpening slider to see what it does.</p>
</Section>

<style>
  .sub {
    color: var(--text-dim);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin: 6px 0 2px;
  }
  .hint {
    color: var(--text-dim);
    font-size: 11px;
    margin: 8px 0 0;
  }
</style>
