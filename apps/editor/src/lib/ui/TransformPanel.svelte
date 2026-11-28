<script lang="ts">
  // Lightroom's Transform panel: Guided Upright and manual perspective (Upright's automatic
  // modes are not here).
  import { MAX_UPRIGHT_GUIDES, TRANSFORM_PARAMS as T, type ParamSpec } from '@immich-raw/recipe';
  import { editor } from '../state/editor.svelte.ts';
  import Section from './Section.svelte';
  import Slider from './Slider.svelte';

  const set = (spec: ParamSpec) => (v: number) => editor.setParam(spec, v);
  const rows: ParamSpec[] = [T.vertical, T.horizontal, T.rotate, T.aspect, T.scale, T.offsetX, T.offsetY];
  const guides = $derived(editor.uprightGuides.length);
  const drawing = $derived(editor.tool === 'upright');
</script>

<Section title="Transform" open={false}>
  {#snippet actions()}
    <button class="small" onclick={() => editor.resetTransform()} disabled={editor.readOnly}>Reset</button>
  {/snippet}
  <div class="upright">
    <span class="lbl">Guided Upright</span>
    <button class:active={drawing} onclick={() => editor.setTool(drawing ? 'edit' : 'upright')} disabled={editor.readOnly || editor.status !== 'ready'} title="Draw guides along edges that should be vertical or horizontal (Shift+T)">
      {drawing ? 'Done' : guides ? 'Edit guides' : 'Draw guides'}
    </button>
    {#if guides}<button class="small" onclick={() => editor.clearUprightGuides()} disabled={editor.readOnly}>Clear</button>{/if}
  </div>
  {#if drawing || guides}
    <p class="hint" class:warn={editor.uprightFailed}>
      {#if editor.uprightFailed}
        These guides would turn the photo too far, so they do nothing: move or remove one.
      {:else}
        {guides} of {MAX_UPRIGHT_GUIDES} guides. Two along converging edges make them parallel and upright; a third and fourth across fix the other direction. Drag a guide's ends to adjust it; select it and press Delete to remove it. The sliders below apply on top.
      {/if}
    </p>
  {/if}
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
  .hint.warn {
    color: var(--danger);
  }
  .upright {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 2px 0 8px;
  }
  .upright .lbl {
    flex: 1;
  }
</style>
