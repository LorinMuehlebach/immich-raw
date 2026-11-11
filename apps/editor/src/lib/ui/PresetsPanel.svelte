<script lang="ts">
  // Presets panel: folders of presets, hover to preview, click to apply, + to save the
  // current settings, import Lightroom .xmp / our .json, export all.
  import { DEFAULT_GROUPS, type GroupId, type Recipe, type SettingsPatch } from '@immich-raw/recipe';
  import { onMount } from 'svelte';
  import { downloadBlob } from '../download.ts';
  import { presetFolders, type ImportResult, type Preset, type PresetStore, type XmpParser } from '../state/presets.ts';
  import CopySettingsDialog from './CopySettingsDialog.svelte';
  import Section from './Section.svelte';

  interface Props {
    store: PresetStore;
    getCurrent: () => Recipe;
    onApply: (patch: SettingsPatch, name: string) => void;
    onPreview: (patch: SettingsPatch | null) => void;
    parseXmp?: XmpParser;
    disabled?: boolean;
  }

  let { store, getCurrent, onApply, onPreview, parseXmp, disabled = false }: Props = $props();

  let presets = $state<Preset[]>([]);
  let closed = $state<Record<string, boolean>>({});
  let creating = $state(false);
  let renaming = $state<string | null>(null);
  let renameText = $state('');
  let result = $state<ImportResult | null>(null);
  let error = $state<string | null>(null);
  let fileInput: HTMLInputElement | undefined = $state();
  let previewing = false;

  const folders = $derived(presetFolders(presets));
  const byFolder = $derived(Object.fromEntries(folders.map((f) => [f, presets.filter((p) => p.group === f)])) as Record<string, Preset[]>);

  async function refresh() {
    try {
      presets = await store.list();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  onMount(() => {
    refresh();
    return () => stopPreview();
  });

  function preview(p: Preset) {
    if (disabled || renaming) return;
    previewing = true;
    onPreview(p.patch);
  }

  function stopPreview() {
    if (!previewing) return;
    previewing = false;
    onPreview(null);
  }

  function apply(p: Preset) {
    if (disabled) return;
    stopPreview();
    onApply(p.patch, p.name);
  }

  async function create(groups: GroupId[], name?: string, folder?: string) {
    creating = false;
    try {
      await store.create(name ?? 'Untitled preset', getCurrent(), groups, folder);
      await refresh();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  function startRename(p: Preset) {
    stopPreview();
    renaming = p.id;
    renameText = p.name;
  }

  async function finishRename(apply: boolean) {
    const id = renaming;
    renaming = null;
    if (apply && id && renameText.trim()) {
      await store.rename(id, renameText);
      await refresh();
    }
  }

  async function remove(p: Preset) {
    stopPreview();
    if (!confirm(`Delete the preset "${p.name}"?`)) return;
    await store.remove(p.id);
    await refresh();
  }

  async function onFiles(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = '';
    if (!files.length) return;
    error = null;
    result = await store.importFiles(files, parseXmp);
    await refresh();
  }

  function exportAll() {
    downloadBlob(store.exportJson(presets), 'raw-editor-presets.json');
  }

  function focusSelect(node: HTMLInputElement) {
    node.focus();
    node.select();
  }
</script>

<Section title="Presets">
  {#snippet actions()}
    <button class="small" title="Create a preset from the current settings" aria-label="New preset" disabled={disabled} onclick={() => (creating = true)}>+</button>
    <button class="small" title="Import Lightroom .xmp or .json presets" onclick={() => fileInput?.click()}>Import</button>
    <button class="small" title="Download all presets as JSON" disabled={!presets.length} onclick={exportAll}>Export</button>
  {/snippet}

  <input bind:this={fileInput} type="file" accept=".xmp,.json,application/json" multiple hidden onchange={onFiles} />

  {#if result}
    <div class="result" class:warn={result.failed.length > 0}>
      <span>
        Imported {result.imported.length} preset{result.imported.length === 1 ? '' : 's'}{#if result.failed.length}, {result.failed.length} failed{/if}.
      </span>
      <button class="link" onclick={() => (result = null)} aria-label="Dismiss">✕</button>
      {#if result.failed.length}
        <ul>
          {#each result.failed as f (f.file + f.reason)}<li><b>{f.file}</b>: {f.reason}</li>{/each}
        </ul>
      {/if}
    </div>
  {/if}
  {#if error}<div class="result warn">{error}</div>{/if}

  {#if !presets.length}
    <p class="empty">No presets yet. Use <b>+</b> to save the current settings, or import Lightroom presets.</p>
  {/if}

  {#each folders as folder (folder)}
    {#if byFolder[folder]?.length}
      <div class="folder">
        <button class="folder-head" onclick={() => (closed[folder] = !closed[folder])} aria-expanded={!closed[folder]}>
          <span class="tri" class:open={!closed[folder]}>▸</span>
          {folder}
          <span class="count">{byFolder[folder]?.length}</span>
        </button>
        {#if !closed[folder]}
          <ul class="list" role="list" onmouseleave={stopPreview}>
            {#each byFolder[folder] ?? [] as p (p.id)}
              <!-- Hover preview with a mouse only: on a touch screen the tap applies. -->
              <li class="row" onpointerenter={(e) => e.pointerType === 'mouse' && preview(p)} onmouseleave={stopPreview}>
                {#if renaming === p.id}
                  <input
                    class="rename"
                    bind:value={renameText}
                    use:focusSelect
                    onblur={() => finishRename(true)}
                    onkeydown={(e) => {
                      e.stopPropagation();
                      if (e.key === 'Enter') finishRename(true);
                      if (e.key === 'Escape') finishRename(false);
                    }}
                  />
                {:else}
                  <button class="name" {disabled} title={p.groups.join(', ')} onclick={() => apply(p)} ondblclick={() => startRename(p)}>{p.name}</button>
                  <span class="tools">
                    <button class="icon" title="Rename" aria-label="Rename {p.name}" onclick={() => startRename(p)}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75z" /></svg>
                    </button>
                    <button class="icon" title="Delete" aria-label="Delete {p.name}" onclick={() => remove(p)}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6zM19 4h-3.5l-1-1h-5l-1 1H5v2h14z" /></svg>
                    </button>
                  </span>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    {/if}
  {/each}
</Section>

{#if creating}
  <CopySettingsDialog
    title="New Develop Preset"
    confirmLabel="Create"
    initial={DEFAULT_GROUPS}
    withName
    nameDefault="Untitled preset"
    {folders}
    onConfirm={create}
    onCancel={() => (creating = false)}
  />
{/if}

<style>
  .small {
    padding: 2px 8px;
    font-size: 11px;
  }
  .empty {
    color: var(--text-dim);
    font-size: 11px;
    margin: 0;
  }
  .folder + .folder {
    margin-top: 4px;
  }
  .folder-head {
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    padding: 3px 0;
    color: var(--text);
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .tri {
    display: inline-block;
    width: 12px;
    color: var(--text-dim);
    transition: transform 0.12s;
  }
  .tri.open {
    transform: rotate(90deg);
  }
  .count {
    margin-left: auto;
    color: var(--text-dim);
    font-size: 11px;
  }
  .list {
    list-style: none;
    margin: 0 0 0 14px;
    padding: 0;
  }
  .row {
    display: flex;
    align-items: center;
    height: 24px;
    border-radius: 3px;
  }
  .row:hover {
    background: var(--panel-2);
  }
  .name {
    flex: 1;
    min-width: 0;
    text-align: left;
    background: none;
    border: none;
    padding: 2px 6px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tools {
    display: none;
    gap: 2px;
    padding-right: 2px;
  }
  .row:hover .tools,
  .row:focus-within .tools {
    display: flex;
  }
  .tools .icon {
    padding: 1px 5px;
    line-height: 1.2;
    font-size: 11px;
    background: none;
    border-color: transparent;
  }
  /* No hover on touch screens: rename and delete stay visible. */
  @media (hover: none) {
    .tools {
      display: flex;
    }
  }
  @media (pointer: coarse) {
    .row {
      height: 38px;
    }
    .tools .icon {
      padding: 8px 9px;
    }
  }
  .rename {
    flex: 1;
    font: inherit;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--accent);
    border-radius: 3px;
    padding: 2px 6px;
    outline: none;
  }
  .result {
    position: relative;
    font-size: 11px;
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 4px;
    padding: 6px 24px 6px 8px;
    margin-bottom: 8px;
  }
  .result.warn {
    border-color: #8a6d2b;
  }
  .result ul {
    margin: 4px 0 0;
    padding-left: 16px;
    color: var(--text-dim);
  }
  .link {
    position: absolute;
    top: 3px;
    right: 3px;
    background: none;
    border: none;
    padding: 2px 5px;
    font-size: 11px;
  }
</style>
