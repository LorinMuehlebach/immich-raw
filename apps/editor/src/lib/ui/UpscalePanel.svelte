<script lang="ts">
  // AI Upscale: makes the edit 2x or 4x larger with an AI model running in this browser, then
  // downloads it or saves a copy to Immich in the RAW's stack. Preview shows a detail before and after.
  import { onMount } from 'svelte';
  import type { UpscaleScale, UpscaleStyle } from '@immich-raw/ai';
  import { aiConsent } from '../ai.svelte.ts';
  import { editor } from '../state/editor.svelte.ts';
  import { STYLE_LABELS, formatDuration, type UpscaleFormat } from '../state/upscale.ts';
  import Section from './Section.svelte';

  const up = editor.upscale;
  const settings = $derived(up.settings);
  const busy = $derived(!!editor.saving);
  const check = $derived(editor.upscaleCheck());
  const previewing = $derived(editor.tool === 'upscale');
  const where = $derived(!up.backend ? '' : up.backend.gpu ? 'GPU (WebGPU)' : `CPU, ${up.backend.threads} thread${up.backend.threads === 1 ? '' : 's'}`);
  const STYLES: UpscaleStyle[] = ['sharp', 'natural'];
  const SCALES: UpscaleScale[] = [2, 4];

  onMount(() => {
    void up.loadBackend();
  });

  function togglePreview() {
    if (previewing) return editor.setTool('edit');
    // An earlier "Not now" shouldn't block a preview the user asks for.
    aiConsent.again();
    editor.setTool('upscale');
  }
</script>

<Section title="AI Upscale">
  <div class="seg" role="group" aria-label="Model">
    {#each STYLES as s (s)}
      <button class:active={settings.style === s} onclick={() => up.set({ style: s })} disabled={busy} title={STYLE_LABELS[s].hint}>{STYLE_LABELS[s].name}</button>
    {/each}
  </div>
  <div class="seg" role="group" aria-label="Scale">
    {#each SCALES as sc (sc)}
      <button class:active={settings.scale === sc} onclick={() => up.set({ scale: sc })} disabled={busy} title="{sc} times the width and height">{sc}×</button>
    {/each}
  </div>

  <button class="wide" class:active={previewing} onclick={togglePreview} disabled={editor.status !== 'ready'} title="Before and after of a detail; drag the square on the photo">
    {previewing ? 'Hide preview' : 'Preview a detail'}
  </button>

  {#if check}
    <p class="info">
      {check.width} × {check.height} ({Math.round((check.width * check.height) / 1e6)} MP){#if where && check.seconds !== null}<br />{formatDuration(check.seconds)} on the {where}{/if}
    </p>
    {#if check.blocked}<p class="blocked">{check.blocked}</p>{/if}
  {/if}

  <div class="run">
    <button class="primary" onclick={() => editor.upscalePhoto('download')} disabled={busy || !check || !!check.blocked} title="Upscale the edit and download it">Download</button>
    <select value={settings.format} onchange={(e) => up.set({ format: e.currentTarget.value as UpscaleFormat })} disabled={busy} aria-label="File type of the download">
      <option value="jpeg">JPEG</option>
      <option value="tiff">TIFF</option>
    </select>
  </div>
  {#if !editor.readOnly}
    <button class="wide" onclick={() => editor.upscalePhoto('immich')} disabled={busy || !check || !!check.blocked} title="Upscale the edit and save it to Immich as a JPEG, stacked with the RAW (the RAW and your saved edit stay as they are)">
      Save to Immich
    </button>
  {/if}
  <p class="note">Runs in this browser; the photo isn't uploaded to any AI service.</p>
</Section>

<style>
  .seg {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 4px;
    margin-bottom: 6px;
  }
  .seg button,
  .wide {
    min-width: 0;
  }
  .wide {
    width: 100%;
    margin-top: 6px;
  }
  .info {
    margin: 6px 0 0;
    font-size: 11px;
    color: var(--text);
  }
  .blocked {
    margin: 4px 0 0;
    font-size: 11px;
    color: #e0a040;
  }
  .run {
    display: flex;
    gap: 6px;
    margin-top: 8px;
  }
  .run .primary {
    flex: 1;
  }
  .note {
    margin: 6px 0 0;
    color: var(--text-dim);
    font-size: 11px;
  }
</style>
