<script lang="ts">
  // Export settings: Lightroom's export options for each of Low, Medium and High.
  import { editor } from '../state/editor.svelte.ts';
  import {
    AMOUNT_LABELS,
    EXPORT_PRESET_IDS,
    FORMAT_LABELS,
    METADATA_LABELS,
    NAMING_CHOICES,
    POSITION_LABELS,
    PPI_RANGE,
    PRESET_LABELS,
    QUALITY_SPECS,
    SHARPEN_LABELS,
    SIZE_MODE_LABELS,
    UNIT_LABELS,
    WATERMARK_OPACITY,
    WATERMARK_SIZE,
    exportFilename,
    sizeValueRange,
    withSizeMode,
    withSizeUnit,
    withSizeValue,
    type ExportFormat,
    type ExportPreset,
    type ExportPresetId,
    type MetadataMode,
    type SharpenAmount,
    type SharpenFor,
    type SizeMode,
    type SizeUnit,
    type WatermarkPosition,
  } from '../state/export-settings.ts';
  import { captureDate } from '../export/metadata.ts';
  import Slider from './Slider.svelte';

  let id = $state<ExportPresetId>(editor.exportSettings.immichPreset);
  const p = $derived(editor.exportSettings.presets[id]);
  const range = $derived(sizeValueRange(p.size));
  const known = $derived(NAMING_CHOICES.some((c) => c.template === p.naming));
  let custom = $state(false);
  const showCustom = $derived(custom || !known);
  let album = $state('');
  editor.contextAlbumName().then((a) => (album = a));

  const example = $derived(
    exportFilename(p, {
      originalFileName: editor.asset?.originalFileName ?? 'DSCF7697.RAF',
      preset: id,
      date: editor.asset ? captureDate(editor.asset) : new Date(),
      seq: 1,
      album: album || 'Album',
      owner: editor.ownerName(),
    }),
  );

  function set(patch: Partial<ExportPreset>) {
    editor.setExportPreset(id, patch);
  }

  function close() {
    editor.exportDialog = null;
  }

  function onKey(e: KeyboardEvent) {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  }

  function autofocus(node: HTMLElement) {
    queueMicrotask(() => node.focus());
  }

  function choose(next: ExportPresetId) {
    id = next;
    custom = false;
  }
</script>

<div class="backdrop" role="presentation" onclick={close} onkeydown={onKey}>
  <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="export-title" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={onKey} use:autofocus>
    <h2 id="export-title">Export settings</h2>

    <div class="tabs" role="tablist">
      {#each EXPORT_PRESET_IDS as pid (pid)}
        <button role="tab" class:active={pid === id} aria-selected={pid === id} onclick={() => choose(pid)}>
          <b>{PRESET_LABELS[pid].name}</b>
          <span>{PRESET_LABELS[pid].purpose}</span>
          {#if pid === editor.exportSettings.immichPreset}<span class="immich">Immich copy</span>{/if}
        </button>
      {/each}
    </div>

    <div class="form">
      <label class="row">
        <span class="lbl">File type</span>
        <select value={p.format} onchange={(e) => set({ format: e.currentTarget.value as ExportFormat })}>
          {#each Object.entries(FORMAT_LABELS) as [value, label] (value)}<option {value}>{label}</option>{/each}
        </select>
      </label>
      {#if p.format === 'tiff'}<p class="hint">8 bits per channel, lossless (Deflate).</p>{/if}
      {#if p.format === 'png'}<p class="hint">8 bits per channel, lossless.</p>{/if}

      <label class="row">
        <span class="lbl">Size</span>
        <select value={p.size.mode} onchange={(e) => set({ size: withSizeMode(p.size, e.currentTarget.value as SizeMode) })}>
          {#each Object.entries(SIZE_MODE_LABELS) as [value, label] (value)}<option {value}>{label}</option>{/each}
        </select>
      </label>
      {#if p.size.mode !== 'full'}
        <div class="row">
          <span class="lbl"></span>
          <input
            class="num"
            type="number"
            min={range.min}
            max={range.max}
            step={range.step}
            value={p.size.value}
            aria-label="Size value"
            onchange={(e) => set({ size: withSizeValue(p.size, e.currentTarget.valueAsNumber) })}
          />
          {#if p.size.mode === 'megapixels'}
            <span class="unit">megapixels</span>
          {:else}
            <select class="unit-select" value={p.size.unit} aria-label="Unit" onchange={(e) => set({ size: withSizeUnit(p.size, e.currentTarget.value as SizeUnit, p.ppi) })}>
              {#each Object.entries(UNIT_LABELS) as [value, label] (value)}<option {value}>{label}</option>{/each}
            </select>
          {/if}
        </div>
      {/if}
      <label class="row" title="Pixels per inch: turns cm and inches into pixels and tells printers the size">
        <span class="lbl">Resolution</span>
        <input
          class="num"
          type="number"
          min={PPI_RANGE.min}
          max={PPI_RANGE.max}
          step="1"
          value={p.ppi}
          onchange={(e) => set({ ppi: Math.round(Math.min(PPI_RANGE.max, Math.max(PPI_RANGE.min, e.currentTarget.valueAsNumber || p.ppi))) })}
        />
        <span class="unit">ppi</span>
      </label>
      <p class="hint">Never larger than the photo.</p>

      {#if p.format === 'jpeg'}
        <div class="slider">
          <Slider
            spec={QUALITY_SPECS[id]}
            value={p.quality}
            onchange={(v) => set({ quality: Math.round(v) })}
            oncommit={() => {}}
            onreset={() => set({ quality: QUALITY_SPECS[id].default })}
          />
        </div>
      {/if}

      <div class="sep"></div>

      <label class="row">
        <span class="lbl">Output sharpening</span>
        <select value={p.sharpen.for} onchange={(e) => set({ sharpen: { ...p.sharpen, for: e.currentTarget.value as SharpenFor } })}>
          {#each Object.entries(SHARPEN_LABELS) as [value, label] (value)}<option {value}>{label}</option>{/each}
        </select>
      </label>
      <label class="row">
        <span class="lbl">Amount</span>
        <select value={p.sharpen.amount} disabled={p.sharpen.for === 'none'} onchange={(e) => set({ sharpen: { ...p.sharpen, amount: e.currentTarget.value as SharpenAmount } })}>
          {#each Object.entries(AMOUNT_LABELS) as [value, label] (value)}<option {value}>{label}</option>{/each}
        </select>
      </label>

      <label class="row" title="Display P3 and Adobe RGB are planned">
        <span class="lbl">Colour space</span>
        <select disabled><option>sRGB</option></select>
      </label>

      <div class="sep"></div>

      <div class="row top">
        <span class="lbl">Metadata</span>
        <div class="radios">
          {#each Object.entries(METADATA_LABELS) as [value, label] (value)}
            <label class="radio">
              <input type="radio" name="export-metadata" {value} checked={p.metadata === value} onchange={() => set({ metadata: value as MetadataMode })} />
              {label}
            </label>
          {/each}
        </div>
      </div>
      <label class="row" title="Written into every export (all presets). {'{year}'}: year taken, {'{owner}'}: the photo's owner in Immich">
        <span class="lbl">Copyright</span>
        <input type="text" value={editor.exportSettings.copyright} placeholder="© {'{year}'} {'{owner}'}" onchange={(e) => editor.setExportCopyright(e.currentTarget.value)} />
      </label>

      <div class="sep"></div>

      <label class="row check">
        <span class="lbl">Watermark</span>
        <input type="checkbox" checked={p.watermark.enabled} onchange={(e) => set({ watermark: { ...p.watermark, enabled: e.currentTarget.checked } })} />
        <span>Add a watermark</span>
      </label>
      {#if p.watermark.enabled}
        <label class="row">
          <span class="lbl">Text</span>
          <input type="text" value={p.watermark.text} onchange={(e) => set({ watermark: { ...p.watermark, text: e.currentTarget.value } })} />
        </label>
        <label class="row">
          <span class="lbl">Position</span>
          <select value={p.watermark.position} onchange={(e) => set({ watermark: { ...p.watermark, position: e.currentTarget.value as WatermarkPosition } })}>
            {#each Object.entries(POSITION_LABELS) as [value, label] (value)}<option {value}>{label}</option>{/each}
          </select>
          <select class="unit-select" value={p.watermark.color} aria-label="Colour" onchange={(e) => set({ watermark: { ...p.watermark, color: e.currentTarget.value as 'white' | 'black' } })}>
            <option value="white">White</option>
            <option value="black">Black</option>
          </select>
        </label>
        <div class="slider">
          <Slider spec={WATERMARK_SIZE} value={p.watermark.size} onchange={(v) => set({ watermark: { ...p.watermark, size: v } })} oncommit={() => {}} onreset={() => set({ watermark: { ...p.watermark, size: WATERMARK_SIZE.default } })} />
          <Slider spec={WATERMARK_OPACITY} value={p.watermark.opacity} onchange={(v) => set({ watermark: { ...p.watermark, opacity: v } })} oncommit={() => {}} onreset={() => set({ watermark: { ...p.watermark, opacity: WATERMARK_OPACITY.default } })} />
        </div>
      {/if}

      <div class="sep"></div>

      <label class="row">
        <span class="lbl">File name</span>
        <select
          value={showCustom ? 'custom' : p.naming}
          onchange={(e) => {
            const v = e.currentTarget.value;
            custom = v === 'custom';
            if (!custom) set({ naming: v });
          }}
        >
          {#each NAMING_CHOICES as c (c.template)}<option value={c.template}>{c.label}</option>{/each}
          <option value="custom">Custom…</option>
        </select>
      </label>
      {#if showCustom}
        <label class="row">
          <span class="lbl"></span>
          <input type="text" value={p.naming} aria-label="File name template" onchange={(e) => set({ naming: e.currentTarget.value })} />
        </label>
        <p class="hint">{'{name}'} {'{preset}'} {'{date}'} {'{seq}'} {'{album}'} {'{owner}'} {'{year}'}</p>
      {/if}
      <p class="hint">Example: {example}</p>
    </div>

    {#if id === editor.exportSettings.immichPreset}
      <p class="note">Save uses this preset for the copy in Immich: its size, quality and sharpening. That copy is always a JPEG without watermark and keeps the RAW's own metadata.</p>
    {/if}

    <div class="buttons">
      <button onclick={() => editor.resetExportPreset(id)}>Defaults for {PRESET_LABELS[id].name}</button>
      <span class="spacer"></span>
      <button class="primary" onclick={close}>Done</button>
    </div>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 100;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .dialog {
    width: 420px;
    max-width: calc(100vw - 32px);
    max-height: calc(100vh - 32px);
    overflow: auto;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 16px 18px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
    outline: none;
  }
  h2 {
    margin: 0 0 10px;
    font-size: 14px;
    color: var(--text-bright);
  }
  .tabs {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 6px;
    margin-bottom: 12px;
  }
  .tabs button {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 5px 4px;
    min-width: 0;
  }
  .tabs b {
    font-weight: 600;
    color: var(--text-bright);
  }
  .tabs span {
    font-size: 10px;
    color: var(--text-dim);
    text-align: center;
  }
  .tabs .immich {
    color: var(--accent);
  }
  .tabs button.active {
    border-color: var(--accent);
    background: #2b3646;
  }
  .form {
    display: grid;
    gap: 4px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 28px;
  }
  .row.top {
    align-items: flex-start;
  }
  .row.top .lbl {
    padding-top: 2px;
  }
  .lbl {
    flex: none;
    width: 118px;
    color: var(--text-dim);
  }
  .row select,
  .row input[type='text'] {
    flex: 1;
    min-width: 0;
  }
  input[type='text'],
  input[type='number'] {
    font: inherit;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 4px;
    padding: 4px 6px;
  }
  .num {
    width: 90px;
  }
  .row .unit-select {
    flex: none;
    width: 96px;
  }
  .unit {
    color: var(--text-dim);
  }
  .check input {
    accent-color: var(--accent);
    margin: 0;
  }
  .radios {
    display: grid;
    gap: 4px;
  }
  .radio {
    display: flex;
    gap: 6px;
    align-items: center;
    cursor: pointer;
  }
  .radio input {
    accent-color: var(--accent);
    margin: 0;
  }
  .hint {
    margin: 0 0 2px 126px;
    color: var(--text-dim);
    font-size: 11px;
    overflow-wrap: anywhere;
  }
  .slider {
    padding-left: 0;
  }
  .slider :global(.row) {
    grid-template-columns: 118px 1fr 52px;
  }
  .sep {
    border-top: 1px solid var(--line);
    margin: 6px 0;
  }
  .note {
    margin: 10px 0 0;
    color: var(--text-dim);
    font-size: 11px;
    line-height: 1.45;
  }
  .buttons {
    display: flex;
    gap: 6px;
    align-items: center;
    margin-top: 14px;
  }
  .spacer {
    flex: 1;
  }
</style>
