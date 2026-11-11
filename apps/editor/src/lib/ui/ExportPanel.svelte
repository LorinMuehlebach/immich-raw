<script lang="ts">
  // Export: downloads the edit at Low (web), Medium (screen) or High (print), exports a whole
  // album, and chooses which preset Save uses for the copy in Immich. Settings stay in this browser.
  import { editor } from '../state/editor.svelte.ts';
  import { EXPORT_PRESET_IDS, FORMAT_LABELS, PRESET_LABELS, presetSummary, sizeShort, type ExportPresetId } from '../state/export-settings.ts';
  import Section from './Section.svelte';

  const settings = $derived(editor.exportSettings);
  const busy = $derived(!!editor.saving);
</script>

<Section title="Export">
  {#snippet actions()}
    <button class="small gear" onclick={() => (editor.exportDialog = 'settings')} title="Export settings: file type, size, quality, sharpening, watermark, metadata and file name of Low, Medium and High" aria-label="Export settings">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M19.4 13a7.5 7.5 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.6 7.6 0 0 0-1.7-1L15 3.3h-4l-.4 2.6a7.6 7.6 0 0 0-1.7 1l-2.5-1-2 3.5L6.5 11a7.5 7.5 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1a7.6 7.6 0 0 0 1.7 1l.4 2.6h4l.4-2.6a7.6 7.6 0 0 0 1.7-1l2.5 1 2-3.5zM13 15.5A3.5 3.5 0 1 1 13 8.5a3.5 3.5 0 0 1 0 7z" /></svg>
    </button>
  {/snippet}

  <div class="presets">
    {#each EXPORT_PRESET_IDS as id (id)}
      {@const p = settings.presets[id]}
      <button class="preset" onclick={() => editor.exportPhoto(id)} disabled={busy} title="Download {PRESET_LABELS[id].purpose}: {presetSummary(p)}" aria-label={PRESET_LABELS[id].name}>
        <span class="name">{PRESET_LABELS[id].name}</span>
        <span class="meta">{sizeShort(p)}</span>
        <span class="meta">{p.format === 'jpeg' ? `quality ${p.quality}` : FORMAT_LABELS[p.format]}</span>
      </button>
    {/each}
  </div>

  <button class="album" onclick={() => (editor.exportDialog = 'album')} disabled={busy} title="Export every photo of an album with one of the presets, RAWs with their saved edit">Export album…</button>

  {#if !editor.readOnly}
    <label class="line" title="The preset Save uses for the photo in Immich (its size, quality and sharpening; always JPEG)">
      <span class="lbl">Immich copy</span>
      <select value={settings.immichPreset} onchange={(e) => editor.setImmichPreset(e.currentTarget.value as ExportPresetId)}>
        {#each EXPORT_PRESET_IDS as id (id)}<option value={id}>{PRESET_LABELS[id].name}</option>{/each}
      </select>
    </label>
    <p class="note">Used from the next save.</p>
  {/if}
</Section>

<style>
  .presets {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 6px;
  }
  .preset {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 5px 2px;
    min-width: 0;
  }
  .name {
    color: var(--text-bright);
  }
  .meta {
    font-size: 10px;
    color: var(--text-dim);
    white-space: nowrap;
  }
  .album {
    width: 100%;
    margin-top: 6px;
  }
  .line {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 28px;
    margin-top: 8px;
  }
  .lbl {
    flex: none;
    color: var(--text);
  }
  .line select {
    flex: 1;
    min-width: 0;
  }
  .note {
    margin: 2px 0 0;
    color: var(--text-dim);
    font-size: 11px;
  }
  .small {
    padding: 2px 8px;
    font-size: 11px;
  }
  .gear {
    padding: 2px 5px;
    display: inline-flex;
    align-items: center;
  }
</style>
