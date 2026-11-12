<script lang="ts">
  // The page Immich's "Export with immich-raw" button opens (?export=<key>): renders the photos
  // selected in Immich with one of the export presets, in this tab.
  import { setLibRawUrl } from '@immich-raw/decoder';
  import type { SelectionHandoff } from '@immich-raw/inject/handoff';
  import { onMount } from 'svelte';
  import { readHandoff } from '../handoff.ts';
  import { getSession, initApi } from '../immich/api.ts';
  import { editor } from '../state/editor.svelte.ts';
  import BatchExportDialog from './BatchExportDialog.svelte';
  import ExportSettingsDialog from './ExportSettingsDialog.svelte';

  let status = $state<'loading' | 'auth' | 'ready' | 'error'>('loading');
  let handoff = $state.raw<SelectionHandoff | null>(null);
  let error = $state('');
  const backUrl = $derived(handoff?.returnPath ?? '/');

  onMount(async () => {
    document.title = 'Export · immich-raw';
    setLibRawUrl(`${import.meta.env.BASE_URL}libraw/index.js`);
    initApi();
    handoff = readHandoff(new URLSearchParams(location.search).get('export') ?? '');
    try {
      editor.me = await getSession();
    } catch (e) {
      error = `Can't reach Immich: ${e instanceof Error ? e.message : String(e)}`;
      status = 'error';
      return;
    }
    if (!editor.me) {
      status = 'auth';
      return;
    }
    if (!handoff?.ids.length) {
      error = 'Nothing to export. Select photos in Immich and click the export button again.';
      status = 'error';
      return;
    }
    editor.ctx = handoff.context;
    status = 'ready';
  });

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && editor.exportDialog) editor.exportDialog = null;
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="page">
  <header>
    <a class="back" href={backUrl} title="Back to Immich">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20z" /></svg>
    </a>
    <span class="name">immich-raw</span>
    <span class="dim">Export</span>
  </header>
  <main>
    {#if status === 'loading'}
      <p class="dim">Loading…</p>
    {:else if status === 'auth'}
      <div class="card">
        <h2>Log in to Immich first</h2>
        <p>The export uses your Immich session. <a href="/auth/login">Open Immich</a>, log in, then select the photos again.</p>
      </div>
    {:else if status === 'error'}
      <div class="card">
        <h2>Can't export</h2>
        <p>{error}</p>
        <a class="button" href={backUrl}>Back to Immich</a>
      </div>
    {:else if handoff}
      <BatchExportDialog
        page
        selection={{ ids: handoff.ids, expected: handoff.expected, context: handoff.context }}
        onClose={() => location.assign(backUrl)}
        onSettings={() => (editor.exportDialog = 'settings')}
      />
    {/if}
  </main>
</div>

{#if editor.exportDialog === 'settings'}
  <ExportSettingsDialog />
{/if}

<style>
  .page {
    height: 100%;
    overflow: auto;
    background: var(--bg-view);
  }
  header {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 48px;
    padding: 0 12px;
    background: var(--panel);
    border-bottom: 1px solid #111;
  }
  .back {
    display: inline-flex;
    padding: 6px;
    border-radius: 4px;
    color: var(--text);
  }
  .back:hover {
    background: var(--panel-2);
  }
  .name {
    color: var(--text-bright);
    font-weight: 600;
  }
  .dim {
    color: var(--text-dim);
  }
  main {
    display: flex;
    justify-content: center;
    padding: 32px 16px;
  }
  .card {
    width: 460px;
    max-width: 100%;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 16px 18px;
  }
  .card h2 {
    margin: 0 0 8px;
    font-size: 14px;
    color: var(--text-bright);
  }
  .card p {
    line-height: 1.45;
  }
  a {
    color: var(--accent);
  }
  .button {
    display: inline-block;
    padding: 4px 10px;
    border: 1px solid var(--line);
    border-radius: 4px;
    background: var(--panel-2);
    color: var(--text);
    text-decoration: none;
  }
</style>
