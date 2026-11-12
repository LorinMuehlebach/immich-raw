<script lang="ts">
  // Lightroom's Transform panel: manual perspective (Upright's automatic modes are not here).
  import { TRANSFORM_PARAMS as T, type ParamSpec } from '@immich-raw/recipe';
  import { editor } from '../state/editor.svelte.ts';
  import Section from './Section.svelte';
  import Slider from './Slider.svelte';

  const set = (spec: ParamSpec) => (v: number) => editor.setParam(spec, v);
  const rows: ParamSpec[] = [T.vertical, T.horizontal, T.rotate, T.aspect, T.scale, T.offsetX, T.offsetY];
</script>

<Section title="Transform" open={false}>
  {#snippet actions()}
    <button class="small" onclick={() => editor.resetTransform()} disabled={editor.readOnly}>Reset</button>
  {/snippet}
  {#each rows as spec (spec.path)}
    <Slider
      {spec}
      value={editor.value(spec)}
      onchange={set(spec)}
      oncommit={() => editor.commit()}
      onreset={() => editor.resetParam(spec)}
      disabled={editor.readOnly}
    />
  {/each}
  <label class="check">
    <input type="checkbox" checked={editor.recipe.transform.constrain} onchange={(e) => editor.setConstrainCrop(e.currentTarget.checked)} disabled={editor.readOnly} />
    Constrain Crop
  </label>
  <p class="hint">Without Constrain Crop, areas the image no longer covers show up white.</p>
</Section>

<style>
  .check {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 8px 0 2px;
    cursor: pointer;
  }
  .check input {
    accent-color: var(--accent);
  }
  .hint {
    margin: 4px 0 0;
    color: var(--text-dim);
    font-size: 11px;
    line-height: 1.4;
  }
</style>
