<script lang="ts">
  import { ASPECTS, PARAMS, type AspectId } from '@immich-raw/recipe';
  import { editor } from '../state/editor.svelte.ts';
  import Section from './Section.svelte';
  import Slider from './Slider.svelte';

  const LABEL: Record<AspectId, string> = {
    original: 'Original',
    free: 'Custom (free)',
    '1:1': '1 × 1',
    '4:5': '4 × 5 / 8 × 10',
    '5:7': '5 × 7',
    '2:3': '2 × 3 / 4 × 6',
    '3:4': '3 × 4',
    '9:16': '9 × 16',
  };
</script>

<Section title="Crop & Straighten">
  {#snippet actions()}
    <button class="small" onclick={() => editor.resetCrop()}>Reset</button>
  {/snippet}
  <div class="line">
    <span class="lbl">Aspect</span>
    <select value={editor.recipe.crop.aspect} onchange={(e) => editor.setAspect(e.currentTarget.value as AspectId)}>
      {#each ASPECTS as a (a)}<option value={a}>{LABEL[a]}</option>{/each}
    </select>
    <button class="icon" title="Swap portrait/landscape (X)" aria-label="Swap orientation" disabled={editor.recipe.crop.aspect === 'free'} onclick={() => editor.togglePortrait()}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 4h8a2 2 0 0 1 2 2v3h-2V6H8v12h3v2H8a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm7 9h5v7h-9v-5h2v3h5v-3h-3z"/></svg>
    </button>
  </div>
  <Slider
    spec={PARAMS.angle}
    value={editor.recipe.crop.angle}
    onchange={(v) => editor.setParam(PARAMS.angle, v)}
    oncommit={() => editor.commit()}
    onreset={() => editor.resetParam(PARAMS.angle)}
  />
  <div class="line buttons">
    <button onclick={() => editor.rotate90(-1)} title="Rotate left (Ctrl+[)">⟲ Rotate left</button>
    <button onclick={() => editor.rotate90(1)} title="Rotate right (Ctrl+])">⟳ Rotate right</button>
  </div>
  <p class="hint">Drag the corners or edges to crop, drag inside to move. <kbd>Enter</kbd> or <kbd>R</kbd> when done.</p>
  <button class="primary done" onclick={() => editor.setTool('edit')}>Done</button>
</Section>

<style>
  .line {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 30px;
  }
  .lbl {
    width: 88px;
  }
  .line select {
    flex: 1;
  }
  .buttons button {
    flex: 1;
  }
  .small {
    padding: 2px 8px;
    font-size: 11px;
  }
  .hint {
    color: var(--text-dim);
    font-size: 11px;
    margin: 10px 0;
  }
  .done {
    width: 100%;
  }
</style>
