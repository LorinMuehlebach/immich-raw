<script lang="ts">
  // Lightroom's Effects panel: post-crop vignetting (relative to the crop) and grain.
  import { EFFECTS_PARAMS as E, VIGNETTE_STYLES, defaultRecipe, pickGroups, type ParamSpec, type VignetteStyle } from '@immich-raw/recipe';
  import { editor } from '../state/editor.svelte.ts';
  import Section from './Section.svelte';
  import Slider from './Slider.svelte';

  const DARK_LIGHT = 'linear-gradient(90deg, #111, #8a8a8a, #f2f2f2)';
  const vignette: ParamSpec[] = [E.vignetteAmount, E.vignetteMidpoint, E.vignetteRoundness, E.vignetteFeather, E.vignetteHighlights];
  const grain: ParamSpec[] = [E.grainAmount, E.grainSize, E.grainRoughness];

  const fx = $derived(editor.recipe.effects);

  // As in Lightroom: the shape sliders wait for an Amount, Highlights only works when
  // darkening with a priority style, and grain size/roughness wait for a grain Amount.
  function inactive(spec: ParamSpec): boolean {
    if (spec === E.vignetteHighlights) return fx.vignetteStyle === 'paint' || fx.vignetteAmount >= 0;
    if (vignette.includes(spec) && spec !== E.vignetteAmount) return fx.vignetteAmount === 0;
    if (spec === E.grainSize || spec === E.grainRoughness) return fx.grainAmount === 0;
    return false;
  }

  const slider = (spec: ParamSpec) => ({
    spec,
    value: editor.value(spec),
    track: spec === E.vignetteAmount ? DARK_LIGHT : '',
    onchange: (v: number) => editor.setParam(spec, v),
    oncommit: () => editor.commit(),
    onreset: () => editor.resetParam(spec),
    disabled: editor.readOnly || inactive(spec),
  });

  function setStyle(style: VignetteStyle) {
    const label = VIGNETTE_STYLES.find((s) => s.id === style)?.label ?? style;
    editor.applyPatch({ effects: { vignetteStyle: style } }, `Post-Crop Vignetting: ${label}`);
  }
</script>

<Section title="Effects" open={false}>
  {#snippet actions()}
    <button class="small" onclick={() => editor.applyPatch(pickGroups(defaultRecipe(), ['effects']), 'Reset Effects')} disabled={editor.readOnly}>Reset</button>
  {/snippet}
  <div class="sub">Post-Crop Vignetting</div>
  <div class="line">
    <span class="lbl">Style</span>
    <select value={fx.vignetteStyle} onchange={(e) => setStyle(e.currentTarget.value as VignetteStyle)} disabled={editor.readOnly}>
      {#each VIGNETTE_STYLES as s (s.id)}<option value={s.id}>{s.label}</option>{/each}
    </select>
  </div>
  {#each vignette as spec (spec.path)}
    <Slider {...slider(spec)} />
  {/each}
  <div class="sub grain">Grain</div>
  {#each grain as spec (spec.path)}
    <Slider {...slider(spec)} />
  {/each}
  <p class="hint">Grain is sized for the full-resolution photo: double-click the photo to see it at 100 %.</p>
</Section>

<style>
  .sub {
    color: var(--text-dim);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin: 6px 0 2px;
  }
  .sub.grain {
    margin-top: 12px;
  }
  .line {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 28px;
  }
  .lbl {
    width: 88px;
    color: var(--text);
  }
  .line select {
    flex: 1;
    min-width: 0;
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
