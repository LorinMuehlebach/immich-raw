<script lang="ts">
  // Lightroom's Lens Corrections panel: profile (Lensfun, or the correction a DNG carries),
  // Remove Chromatic Aberration (measured on the photo), and the manual sliders.
  import { LENS_PARAMS, type ParamSpec } from '@immich-raw/recipe';
  import { editor } from '../state/editor.svelte.ts';
  import Section from './Section.svelte';
  import Slider from './Slider.svelte';

  const PURPLE = 'linear-gradient(90deg, #5a4bff, #a24bff 35%, #ff4bd8 70%, #ff4b6e)';
  const GREEN = 'linear-gradient(90deg, #c8d23c, #6fd23c 35%, #3cd28c 70%, #3cc8d2)';
  const TRACK: Partial<Record<string, string>> = {
    [LENS_PARAMS.defringePurpleLo.path]: PURPLE,
    [LENS_PARAMS.defringePurpleHi.path]: PURPLE,
    [LENS_PARAMS.defringeGreenLo.path]: GREEN,
    [LENS_PARAMS.defringeGreenHi.path]: GREEN,
  };

  const L = $derived(editor.recipe.lens);
  const info = $derived(editor.lensInfo);

  const slider = (spec: ParamSpec) => ({
    spec,
    value: editor.value(spec),
    track: TRACK[spec.path] ?? '',
    onchange: (v: number) => editor.setParam(spec, v),
    oncommit: () => editor.commit(),
    onreset: () => editor.resetParam(spec),
    disabled: editor.readOnly,
  });
</script>

<Section title="Lens Corrections" open={false}>
  {#snippet actions()}
    <button class="small" onclick={() => editor.resetLens()} disabled={editor.readOnly} title="Reset lens corrections">Reset</button>
  {/snippet}

  <label class="check">
    <input type="checkbox" checked={L.profile} onchange={(e) => editor.setLensFlag('profile', e.currentTarget.checked)} disabled={editor.readOnly} />
    Enable Profile Corrections
  </label>
  <p class="status" class:warn={L.profile && !info.profile && !info.searching}>
    {#if info.searching}
      Looking for a lens profile…
    {:else if info.profile}
      {info.profile}
    {:else}
      No profile found for {info.lensName || 'this lens'}.
    {/if}
  </p>
  {#if L.profile && info.candidates.length}
    <div class="line">
      <span class="lbl">Lens</span>
      <select value={L.lensId} onchange={(e) => editor.chooseLens(e.currentTarget.value)} disabled={editor.readOnly}>
        <option value="">Auto{info.autoName ? ` (${info.autoName})` : ''}</option>
        {#each info.candidates as c (c.id)}<option value={c.id}>{c.name}</option>{/each}
      </select>
    </div>
  {/if}
  {#if L.profile && info.profile}
    <Slider {...slider(LENS_PARAMS.profileDistortion)} />
    <Slider {...slider(LENS_PARAMS.profileVignetting)} />
  {/if}

  <label class="check">
    <input type="checkbox" checked={L.removeCA} onchange={(e) => editor.setLensFlag('removeCA', e.currentTarget.checked)} disabled={editor.readOnly} />
    Remove Chromatic Aberration
  </label>
  {#if L.removeCA}
    <p class="status">{info.caText}</p>
  {/if}

  <div class="group">
    <div class="sub">Manual</div>
    <Slider {...slider(LENS_PARAMS.distortion)} />
  </div>
  <div class="group">
    <div class="sub">Defringe</div>
    <Slider {...slider(LENS_PARAMS.defringePurple)} />
    <Slider {...slider(LENS_PARAMS.defringePurpleLo)} />
    <Slider {...slider(LENS_PARAMS.defringePurpleHi)} />
    <Slider {...slider(LENS_PARAMS.defringeGreen)} />
    <Slider {...slider(LENS_PARAMS.defringeGreenLo)} />
    <Slider {...slider(LENS_PARAMS.defringeGreenHi)} />
  </div>
  <div class="group">
    <div class="sub">Lens Vignetting</div>
    <Slider {...slider(LENS_PARAMS.vignetting)} />
    <Slider {...slider(LENS_PARAMS.vignetteMidpoint)} />
  </div>
</Section>

<style>
  .check {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 6px 0 2px;
    color: var(--text-bright);
  }
  .status {
    margin: 0 0 4px 22px;
    color: var(--text-dim);
    font-size: 11px;
  }
  .status.warn {
    color: #e0b43a;
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
  .group {
    margin-top: 10px;
  }
  .sub {
    color: var(--text-dim);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin: 4px 0 2px;
  }
  .small {
    padding: 2px 8px;
    font-size: 11px;
  }
</style>
