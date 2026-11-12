<script lang="ts">
  // DNG: opens Convert to DNG, which replaces the original RAW in Immich with a smaller DNG.
  import { editor } from '../state/editor.svelte.ts';
  import Section from './Section.svelte';
</script>

<Section title="DNG">
  <button class="convert" onclick={() => editor.openDngDialog()} disabled={editor.readOnly || !!editor.saving} title="Convert to DNG: replaces the original RAW with a smaller DNG">Convert to DNG…</button>
  <p class="note">Replaces the RAW in Immich with a smaller DNG.</p>
</Section>

<style>
  .convert {
    width: 100%;
  }
  .note {
    margin: 4px 0 0;
    color: var(--text-dim);
    font-size: 11px;
  }
</style>
