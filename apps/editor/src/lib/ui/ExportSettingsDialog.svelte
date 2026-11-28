<script lang="ts">
  // Export settings: Lightroom's export options for each of Low, Medium and High.
  import { editor } from '../state/editor.svelte.ts';
  import {
    AMOUNT_LABELS,
    EXPORT_PRESET_IDS,
    FAVORITE_LABELS,
    FORMAT_LABELS,
    FRONT_LABELS,
    LOGO_SIZE,
    METADATA_LABELS,
    NAMING_CHOICES,
    POSITION_LABELS,
    PPI_RANGE,
    PRESET_LABELS,
    QUALITY_SPECS,
    SHARPEN_LABELS,
    SIZE_MODE_LABELS,
    SPACE_LABELS,
    UNIT_LABELS,
    WATERMARK_KIND_LABELS,
    WATERMARK_OPACITY,
    WATERMARK_SIZE,
    colorChoices,
    exportFilename,
    hasLosslessOption,
    isLossy,
    sizeValueRange,
    validColor,
    withSizeMode,
    withSizeUnit,
    withSizeValue,
    type ExportFormat,
    type ExportPreset,
    type ExportPresetId,
    type ExportWatermark,
    type MetadataMode,
    type SaveFavorite,
    type SharpenAmount,
    type SharpenFor,
    type SizeMode,
    type SizeUnit,
    type StackFront,
    type WatermarkKind,
    type WatermarkPosition,
  } from '../state/export-settings.ts';
  import type { OutputSpace } from '@immich-raw/pipeline';
  import { captureDate } from '../export/metadata.ts';
  import { deleteUnusedLogo, importLogo, logoStorage, type StoredLogo } from '../state/logos.ts';
  import Slider from './Slider.svelte';

  const FORMAT_HINTS: Partial<Record<ExportFormat, string>> = {
    png: 'Lossless; 8 or 16 bits per channel.',
    tiff: 'Lossless (Deflate); 8 or 16 bits per channel.',
    webp: '8 bits per channel, at most 16383 pixels a side.',
    avif: '8 bits per channel. Slow at full size; no EXIF or XMP.',
    jxl: '8 bits per channel. Slow at full size; not every browser shows it yet.',
  };

  let id = $state<ExportPresetId>(editor.exportSettings.immichPreset);
  const p = $derived(editor.exportSettings.presets[id]);
  const colors = $derived(colorChoices(p.format));
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

  function setWatermark(patch: Partial<ExportWatermark>, presetId: ExportPresetId = id) {
    editor.setExportPreset(presetId, { watermark: { ...editor.exportSettings.presets[presetId].watermark, ...patch } });
  }

  // The watermark logo: picked as a PNG, kept in this browser (logos.ts).
  let fileInput = $state<HTMLInputElement | null>(null);
  let importing = $state(false);
  let logoError = $state<string | null>(null);
  let logo = $state<StoredLogo | null>(null);
  let logoUrl = $state<string | null>(null);

  // Name, size and thumbnail of the shown preset's logo.
  $effect(() => {
    const logoId = p.watermark.imageId;
    let cancelled = false;
    let url: string | null = null;
    logo = null;
    logoUrl = null;
    if (logoId) {
      logoStorage
        .get(logoId)
        .then((l) => {
          if (cancelled || !l) return;
          logo = l;
          url = URL.createObjectURL(l.blob);
          logoUrl = url;
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  });

  const usedLogos = () => EXPORT_PRESET_IDS.map((pid) => editor.exportSettings.presets[pid].watermark.imageId);

  async function pickLogo(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const presetId = id;
    const previous = editor.exportSettings.presets[presetId].watermark.imageId;
    importing = true;
    logoError = null;
    try {
      const stored = await importLogo(file);
      setWatermark({ imageId: stored.id }, presetId);
      await deleteUnusedLogo(previous, usedLogos()).catch(() => {});
    } catch (err) {
      logoError = err instanceof Error ? err.message : String(err);
    } finally {
      importing = false;
    }
  }

  function removeLogo() {
    const previous = p.watermark.imageId;
    setWatermark({ imageId: null });
    logoError = null;
    void deleteUnusedLogo(previous, usedLogos()).catch(() => {});
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
      {#if FORMAT_HINTS[p.format]}<p class="hint">{FORMAT_HINTS[p.format]}</p>{/if}
      {#if hasLosslessOption(p.format)}
        <label class="row check">
          <span class="lbl"></span>
          <input type="checkbox" checked={p.lossless} onchange={(e) => set({ lossless: e.currentTarget.checked })} />
          <span>Lossless</span>
        </label>
      {/if}

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

      {#if isLossy(p.format) && !(p.lossless && hasLosslessOption(p.format))}
        {@const f = p.format}
        <div class="slider">
          <Slider
            spec={QUALITY_SPECS[id][f]}
            value={p.quality[f]}
            onchange={(v) => set({ quality: { ...p.quality, [f]: Math.round(v) } })}
            oncommit={() => {}}
            onreset={() => set({ quality: { ...p.quality, [f]: QUALITY_SPECS[id][f].default } })}
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

      <label class="row">
        <span class="lbl">Colour space</span>
        <select value={p.color.space} aria-label="Colour space" onchange={(e) => set({ color: validColor(p.format, { ...p.color, space: e.currentTarget.value as OutputSpace }) })}>
          {#each Object.entries(SPACE_LABELS) as [value, label] (value)}
            <option {value} disabled={!colors.spaces.includes(value as OutputSpace)}>{label}{value === 'prophoto' ? ' (16-bit)' : ''}</option>
          {/each}
        </select>
        {#if colors.bits.length > 1}
          <select class="unit-select" value={String(p.color.bits)} aria-label="Bit depth" onchange={(e) => set({ color: validColor(p.format, { ...p.color, bits: e.currentTarget.value === '16' ? 16 : 8 }) })}>
            <option value="8" disabled={p.color.space === 'prophoto'}>8-bit</option>
            <option value="16">16-bit</option>
          </select>
        {/if}
      </label>
      {#if p.color.space !== 'srgb'}
        <p class="hint">The file carries the colour space's profile; apps without colour management show its colours duller.</p>
      {:else if colors.spaces.length === 1}
        <p class="hint">{FORMAT_LABELS[p.format]} is exported in sRGB.</p>
      {/if}

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
          <span class="lbl">Type</span>
          <select value={p.watermark.kind} aria-label="Watermark type" onchange={(e) => setWatermark({ kind: e.currentTarget.value as WatermarkKind })}>
            {#each Object.entries(WATERMARK_KIND_LABELS) as [value, label] (value)}<option {value}>{label}</option>{/each}
          </select>
        </label>
        {#if p.watermark.kind === 'image'}
          <div class="row logo">
            <span class="lbl">Logo</span>
            {#if logoUrl}<img src={logoUrl} alt="" class="thumb" />{/if}
            <span class="logo-name">{logo ? `${logo.name} · ${logo.width} × ${logo.height}` : p.watermark.imageId ? 'Not in this browser' : 'None chosen'}</span>
          </div>
          <div class="row">
            <span class="lbl"></span>
            <button onclick={() => fileInput?.click()} disabled={importing}>{importing ? 'Reading…' : 'Choose PNG…'}</button>
            {#if p.watermark.imageId}<button onclick={removeLogo}>Remove</button>{/if}
            <input bind:this={fileInput} class="hidden" type="file" accept="image/png" aria-label="Logo file" onchange={pickLogo} />
          </div>
          {#if logoError}<p class="hint error">{logoError}</p>{/if}
          <p class="hint">A PNG, transparency kept; up to 16 MB. Kept in this browser.</p>
        {:else}
          <label class="row">
            <span class="lbl">Text</span>
            <input type="text" value={p.watermark.text} onchange={(e) => setWatermark({ text: e.currentTarget.value })} />
          </label>
        {/if}
        <label class="row">
          <span class="lbl">Position</span>
          <select value={p.watermark.position} onchange={(e) => setWatermark({ position: e.currentTarget.value as WatermarkPosition })}>
            {#each Object.entries(POSITION_LABELS) as [value, label] (value)}<option {value}>{label}</option>{/each}
          </select>
          {#if p.watermark.kind === 'text'}
            <select class="unit-select" value={p.watermark.color} aria-label="Colour" onchange={(e) => setWatermark({ color: e.currentTarget.value as 'white' | 'black' })}>
              <option value="white">White</option>
              <option value="black">Black</option>
            </select>
          {/if}
        </label>
        <div class="slider">
          {#if p.watermark.kind === 'image'}
            <Slider spec={LOGO_SIZE} value={p.watermark.imageSize} onchange={(v) => setWatermark({ imageSize: v })} oncommit={() => {}} onreset={() => setWatermark({ imageSize: LOGO_SIZE.default })} />
          {:else}
            <Slider spec={WATERMARK_SIZE} value={p.watermark.size} onchange={(v) => setWatermark({ size: v })} oncommit={() => {}} onreset={() => setWatermark({ size: WATERMARK_SIZE.default })} />
          {/if}
          <Slider spec={WATERMARK_OPACITY} value={p.watermark.opacity} onchange={(v) => setWatermark({ opacity: v })} oncommit={() => {}} onreset={() => setWatermark({ opacity: WATERMARK_OPACITY.default })} />
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
      <p class="note">Save uses this preset for the copy in Immich: its size, quality and sharpening. That copy is always an sRGB JPEG without watermark and keeps the RAW's own metadata.</p>
    {/if}

    <div class="form save">
      <div class="sep"></div>
      <h3>Save to Immich</h3>
      <label class="row" title="Which photo Immich shows for the stack. A stack of several shots keeps its best shot in front.">
        <span class="lbl">In front of the stack</span>
        <select value={editor.exportSettings.save.front} onchange={(e) => editor.setSaveSettings({ front: e.currentTarget.value as StackFront })}>
          {#each Object.entries(FRONT_LABELS) as [value, label] (value)}<option {value}>{label}</option>{/each}
        </select>
      </label>
      <label class="row">
        <span class="lbl">Favourite</span>
        <select value={editor.exportSettings.save.favorite} onchange={(e) => editor.setSaveSettings({ favorite: e.currentTarget.value as SaveFavorite })}>
          {#each Object.entries(FAVORITE_LABELS) as [value, label] (value)}<option {value}>{label}</option>{/each}
        </select>
      </label>
      <p class="hint">Tags, albums, date, location, rating and description come from the RAW.</p>
    </div>

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
  .save {
    margin-top: 6px;
  }
  .logo .thumb {
    flex: none;
    width: 48px;
    height: 32px;
    object-fit: contain;
    /* A checkerboard shows the logo's transparency. */
    background: repeating-conic-gradient(#555 0% 25%, #333 0% 50%) 50% / 10px 10px;
    border: 1px solid var(--line);
    border-radius: 3px;
  }
  .logo-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-dim);
  }
  .hidden {
    display: none;
  }
  .hint.error {
    color: #ff8a80;
  }
  h3 {
    margin: 0 0 2px;
    font-size: 12px;
    font-weight: 600;
    color: var(--text-bright);
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
