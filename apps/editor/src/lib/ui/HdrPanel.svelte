<script lang="ts">
  // HDR: opens Merge to HDR, which merges the photo's bracket into an HDR DNG, or brings out the
  // range of this photo alone when there is no bracket.
  import { editor } from '../state/editor.svelte.ts';
  import Section from './Section.svelte';
</script>

<Section title="HDR">
  <button class="merge" onclick={() => editor.openHdrDialog()} disabled={editor.status !== 'ready' || !!editor.saving} title="Merge the bracket around this photo into an HDR DNG">Merge to HDR…</button>
  <p class="note">Merges a bracket into one HDR DNG, or brings out the range of this photo alone.</p>
</Section>

<style>
  .merge {
    width: 100%;
  }
  .note {
    margin: 4px 0 0;
    color: var(--text-dim);
    font-size: 11px;
  }
</style>
