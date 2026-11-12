<script lang="ts">
  // Batch export: every photo of an Immich album, or the photos selected in Immich, with one of
  // the export presets, rendered in this tab (RAWs with their saved edit) into a folder, or one
  // ZIP where the browser can't write into folders.
  import { getAlbumInfo, type AlbumResponseDto } from '@immich/sdk';
  import { onDestroy, onMount } from 'svelte';
  import { listAlbums, planAlbumExport, planSelectionExport, runAlbumExport, type AlbumPlan, type AlbumProgress, type AlbumResult, type PhotoProgress, type PhotoStep } from '../export/album.ts';
  import { MAX_PARALLEL, defaultParallel, deviceSpecs, parallelOr } from '../export/parallel.ts';
  import { canPickFolder, pickFolder, zipDestination } from '../export/destination.ts';
  import { parseContext } from '../immich/context.ts';
  import { editor } from '../state/editor.svelte.ts';
  import { EXPORT_PRESET_IDS, PRESET_LABELS, presetSummary, safeFileName, type ExportPreset, type ExportPresetId } from '../state/export-settings.ts';

  interface Props {
    /** Photos selected in Immich; without it the user picks an album. */
    selection?: { ids: string[]; expected: number; context: string } | null;
    /** Shown as the page opened from Immich rather than over the editor. */
    page?: boolean;
    onClose: () => void;
    /** Opens the export settings (page only; the editor has its own gear). */
    onSettings?: () => void;
  }

  let { selection = null, page = false, onClose, onSettings }: Props = $props();

  type Phase = 'setup' | 'running' | 'done';

  let phase = $state<Phase>('setup');
  let albums = $state<AlbumResponseDto[] | null>(null);
  let albumId = $state('');
  /** For a selection: the album it was made in ('' elsewhere). */
  let selectionAlbum = $state<string | null>(null);
  let presetId = $state<ExportPresetId>('high');
  let skipTwins = $state(true);
  let plan = $state<(AlbumPlan & { missing?: number }) | null>(null);
  let planning = $state(false);
  let error = $state<string | null>(null);
  let progress = $state<AlbumProgress | null>(null);
  let result = $state<AlbumResult | null>(null);
  let destinationLabel = $state('');
  let abort = $state<AbortController | null>(null);
  let stopping = $state(false);
  const folder = canPickFolder();

  // Photos worked on at once: remembered in this browser, else what this computer can take.
  const PARALLEL_KEY = 'raw-editor.export.parallel';
  const autoParallel = defaultParallel(deviceSpecs());
  let parallel = $state(parallelOr(readStored(PARALLEL_KEY), autoParallel));

  function readStored(key: string): unknown {
    try {
      return JSON.parse(localStorage.getItem(key) ?? 'null');
    } catch {
      return null;
    }
  }

  function setParallel(n: number) {
    parallel = n;
    try {
      localStorage.setItem(PARALLEL_KEY, JSON.stringify(n));
    } catch {
      // blocked storage: the choice just isn't remembered
    }
  }

  const preset = $derived(editor.exportSettings.presets[presetId]);
  const album = $derived(albums?.find((a) => a.id === albumId) ?? null);
  const raws = $derived(plan ? plan.items.filter((i) => i.kind === 'raw').length : 0);
  const others = $derived(plan ? plan.items.length - raws : 0);
  const unread = $derived(selection ? Math.max(0, selection.expected - selection.ids.length) : 0);
  const title = $derived(selection ? `Export ${plural(selection.expected || selection.ids.length, 'selected photo')}` : 'Export album');

  const STEP: Record<PhotoStep, string> = {
    download: 'Downloading',
    decode: 'Decoding',
    queued: 'Waiting to render',
    render: 'Rendering',
    resize: 'Resizing',
    sharpen: 'Sharpening',
    encode: 'Encoding',
    write: 'Writing',
  };
  /** How far along one photo is, 0 to 1 (decoding takes the longest, without progress of its own). */
  function photoDone(p: PhotoProgress): number {
    switch (p.step) {
      case 'download':
        return 0.1 * p.fraction;
      case 'decode':
        return 0.15;
      case 'queued':
        return 0.3;
      case 'render':
        return 0.3 + 0.5 * p.fraction;
      case 'write':
        return 0.95;
      default:
        return 0.85;
    }
  }
  const overall = $derived(progress ? (progress.done + progress.active.reduce((sum, p) => sum + photoDone(p), 0)) / progress.total : 0);
  const working = $derived(progress?.active.length ?? 0);

  function plural(n: number, one: string, many = `${one}s`) {
    return `${n} ${n === 1 ? one : many}`;
  }

  const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

  onMount(() => {
    if (selection) {
      const ctx = parseContext(selection.context);
      if (ctx.kind === 'album') {
        getAlbumInfo({ id: ctx.id })
          .then((a) => (selectionAlbum = a.albumName))
          .catch(() => (selectionAlbum = ''));
      } else selectionAlbum = '';
      return;
    }
    listAlbums()
      .then((list) => {
        albums = list;
        const ctx = parseContext(editor.ctx);
        albumId = ctx.kind === 'album' && list.some((a) => a.id === ctx.id) ? ctx.id : (list[0]?.id ?? '');
      })
      .catch((e) => (error = `Could not load your albums: ${message(e)}`));
  });

  let planFor = '';
  $effect(() => {
    const skip = skipTwins;
    const sel = selection;
    const name = sel ? selectionAlbum : (album?.albumName ?? null);
    const a = album;
    if (phase !== 'setup' || name === null || (!sel && !a)) return;
    const key = `${sel ? 'selection' : a!.id}:${skip}`;
    if (key === planFor) return;
    planFor = key;
    plan = null;
    planning = true;
    error = null;
    (sel ? planSelectionExport(sel.ids, name, skip) : planAlbumExport(a!, skip))
      .then((p) => {
        if (planFor === key) plan = p;
      })
      .catch((e) => {
        if (planFor === key) error = `Could not read the photos: ${message(e)}`;
      })
      .finally(() => {
        if (planFor === key) planning = false;
      });
  });

  function zipName(): string {
    const name = plan?.source.name;
    if (name) return `${safeFileName(name)}.zip`;
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `immich-export-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.zip`;
  }

  function beforeUnload(e: BeforeUnloadEvent) {
    e.preventDefault();
  }

  async function start() {
    if (!plan) return;
    error = null;
    const destination = folder ? await pickFolder().catch((e) => ((error = `Could not open the folder: ${message(e)}`), null)) : zipDestination(zipName());
    if (!destination) return;
    destinationLabel = destination.label;
    phase = 'running';
    abort = new AbortController();
    addEventListener('beforeunload', beforeUnload);
    try {
      // Two full decodes at once can run LibRaw out of memory: let the editor's own finish first.
      if (editor.session?.fullStarted) await editor.session.full().catch(() => {});
      result = await runAlbumExport(plan, {
        preset: structuredClone($state.snapshot(preset) as ExportPreset),
        presetId,
        copyright: editor.exportSettings.copyright,
        fallbackOwner: editor.me?.name ?? '',
        destination,
        signal: abort.signal,
        parallel,
        onProgress: (p) => (progress = p),
      });
      await destination.finish();
    } catch (e) {
      error = `Export failed: ${message(e)}`;
    } finally {
      removeEventListener('beforeunload', beforeUnload);
      abort = null;
      phase = 'done';
    }
  }

  function close() {
    if (phase !== 'running') onClose();
  }

  onDestroy(() => {
    abort?.abort();
    removeEventListener('beforeunload', beforeUnload);
  });

  function onKey(e: KeyboardEvent) {
    e.stopPropagation();
    if (e.key === 'Escape' && !page) {
      e.preventDefault();
      close();
    }
  }

  function autofocus(node: HTMLElement) {
    queueMicrotask(() => node.focus());
  }
</script>

{#snippet body()}
  <h2 id="batch-export-title">{title}</h2>

  {#if phase === 'setup'}
    <p class="intro">
      {selection ? 'Renders the selected photos in this tab.' : 'Exports every photo of an album.'} RAWs get their saved edit (RAWs without one get the default settings); other photos are exported as they are, at the preset's size and file type.
    </p>

    {#if !selection}
      <label class="row">
        <span class="lbl">Album</span>
        {#if albums}
          <select bind:value={albumId} disabled={!albums.length}>
            {#each albums as a (a.id)}<option value={a.id}>{a.albumName} ({a.assetCount})</option>{/each}
          </select>
        {:else}
          <span class="dim">Loading albums…</span>
        {/if}
      </label>
    {/if}
    <label class="row">
      <span class="lbl">Preset</span>
      <select bind:value={presetId} aria-label="Preset">
        {#each EXPORT_PRESET_IDS as id (id)}<option value={id}>{PRESET_LABELS[id].name} ({PRESET_LABELS[id].purpose})</option>{/each}
      </select>
      {#if onSettings}<button class="small" onclick={onSettings}>Settings…</button>{/if}
    </label>
    <p class="hint">{presetSummary(preset)}</p>
    <label class="row check">
      <span class="lbl"></span>
      <input type="checkbox" bind:checked={skipTwins} />
      <span>Skip camera JPEGs that come with a RAW</span>
    </label>
    <label class="row">
      <span class="lbl">At once</span>
      <select value={parallel} onchange={(e) => setParallel(Number(e.currentTarget.value))} aria-label="Photos at once">
        {#each Array.from({ length: MAX_PARALLEL }, (_, k) => k + 1) as n (n)}
          <option value={n}>{plural(n, 'photo')}{n === autoParallel ? ' (recommended)' : ''}</option>
        {/each}
      </select>
    </label>
    <p class="hint">Each photo in progress needs about 0.5 GB (26 MP) to 1 GB (60 MP) more memory. More than your computer can take is slower, or crashes the tab.</p>

    <div class="summary">
      {#if planning}
        <span class="dim">Reading the photos…</span>
      {:else if plan}
        <div><b>{plural(plan.items.length, 'photo')}</b> to export: {plural(raws, 'RAW')} ({plan.edited} edited){others ? `, ${plural(others, 'other photo')}` : ''}.</div>
        {#if plan.renders}
          <div class="dim">{plan.renders === 1 ? 'The edited JPEG is' : `The ${plan.renders} edited JPEGs are`} rendered again from {plan.renders === 1 ? 'its RAW' : 'their RAWs'}, so no quality is lost.</div>
        {/if}
        {#if plan.skipped.videos || plan.skipped.jpegTwins}
          <div class="dim">Skipped: {[plan.skipped.videos ? plural(plan.skipped.videos, 'video') : '', plan.skipped.jpegTwins ? plural(plan.skipped.jpegTwins, 'camera JPEG') : ''].filter(Boolean).join(', ')}.</div>
        {/if}
        {#if plan.missing}<div class="dim">{plural(plan.missing, 'photo')} no longer in Immich (deleted or in the trash).</div>{/if}
        {#if raws}<div class="dim">Each RAW is downloaded and rendered in this tab, about 10–20 s of work per photo{parallel > 1 ? `, ${parallel} at a time` : ''}.</div>{/if}
      {:else if albums && !albums.length}
        <span class="dim">You have no albums yet.</span>
      {/if}
    </div>
    {#if unread}
      <p class="warn">Immich had {selection?.expected} photos selected, but only {selection?.ids.length} could be read. Select them again, or export the album they are in.</p>
    {/if}
    <p class="hint wide">
      {folder ? 'You pick a folder; files already in it are kept (new ones get a number).' : 'This browser can’t write into a folder here, so the photos are downloaded as one ZIP.'}
    </p>
    {#if error}<p class="error">{error}</p>{/if}

    <div class="buttons">
      <span class="spacer"></span>
      <button onclick={close}>{page ? 'Back to Immich' : 'Cancel'}</button>
      <button class="primary" onclick={start} disabled={!plan || !plan.items.length || planning}>{folder ? 'Choose folder and export' : 'Export as ZIP'}</button>
    </div>
  {:else if phase === 'running'}
    <div class="progress">
      <div class="label">
        {#if progress}
          {progress.done} of {progress.total} done
        {:else}
          {editor.session ? 'Waiting for the open photo to finish decoding…' : 'Starting…'}
        {/if}
      </div>
      <div class="bar"><i style:width="{Math.round(overall * 100)}%"></i></div>
      {#if progress?.active.length}
        <ul class="photos">
          {#each progress.active as p (p.index)}
            <li><span class="name">{p.index + 1}. {p.name}</span><span class="dim">{STEP[p.step]}…</span></li>
          {/each}
        </ul>
      {/if}
      <p class="dim">Into {destinationLabel}. Keep this tab open.</p>
    </div>
    <div class="buttons">
      <span class="spacer"></span>
      <button
        onclick={() => {
          abort?.abort();
          stopping = true;
        }}
        disabled={!abort || stopping}>{working > 1 ? (stopping ? 'Stopping after these photos…' : 'Stop after these photos') : stopping ? 'Stopping after this photo…' : 'Stop after this photo'}</button
      >
    </div>
  {:else}
    <div class="result" class:bad={!!error || !!result?.failed.length}>
      {#if result}
        <div>
          {result.cancelled ? 'Stopped. ' : ''}Exported {plural(result.written.length, 'photo')} into {destinationLabel}.
        </div>
        {#if result.copied.length}
          <div class="dim">{plural(result.copied.length, 'file')} the browser can’t read (e.g. HEIC) {result.copied.length === 1 ? 'was' : 'were'} copied unchanged.</div>
        {/if}
        {#each result.notes as note (note)}<div class="note">{note}</div>{/each}
        {#if result.failed.length}
          <div>{plural(result.failed.length, 'photo')} failed:</div>
          <ul>
            {#each result.failed.slice(0, 8) as f (f.name)}<li><b>{f.name}</b>: {f.error}</li>{/each}
            {#if result.failed.length > 8}<li>… and {result.failed.length - 8} more</li>{/if}
          </ul>
        {/if}
      {/if}
      {#if error}<div class="error">{error}</div>{/if}
    </div>
    <div class="buttons">
      <span class="spacer"></span>
      <button class="primary" onclick={close}>{page ? 'Back to Immich' : 'Close'}</button>
    </div>
  {/if}
{/snippet}

{#if page}
  <div class="dialog page" role="main" aria-labelledby="batch-export-title">{@render body()}</div>
{:else}
  <div class="backdrop" role="presentation" onclick={close} onkeydown={onKey}>
    <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="batch-export-title" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={onKey} use:autofocus>
      {@render body()}
    </div>
  </div>
{/if}

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
    width: 460px;
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
  .dialog.page {
    max-height: none;
    box-shadow: none;
  }
  h2 {
    margin: 0 0 8px;
    font-size: 14px;
    color: var(--text-bright);
  }
  .intro {
    margin: 0 0 12px;
    line-height: 1.45;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 30px;
  }
  .lbl {
    flex: none;
    width: 70px;
    color: var(--text-dim);
  }
  .row select {
    flex: 1;
    min-width: 0;
  }
  .small {
    padding: 3px 8px;
    font-size: 11px;
  }
  .check input {
    accent-color: var(--accent);
    margin: 0;
  }
  .hint {
    margin: 0 0 4px 78px;
    color: var(--text-dim);
    font-size: 11px;
  }
  .hint.wide {
    margin-left: 0;
  }
  .summary {
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 8px 10px;
    margin: 10px 0;
    display: grid;
    gap: 3px;
    line-height: 1.4;
    min-height: 34px;
  }
  .dim {
    color: var(--text-dim);
  }
  .warn {
    margin: 0 0 8px;
    color: #f0c674;
    line-height: 1.4;
  }
  .result .note {
    color: #f0c674;
  }
  .error {
    color: #ff8a80;
  }
  .progress {
    margin: 4px 0 12px;
  }
  .progress .label {
    margin-bottom: 6px;
    overflow-wrap: anywhere;
  }
  .progress p {
    margin: 8px 0 0;
    font-size: 11px;
  }
  .photos {
    list-style: none;
    margin: 8px 0 0;
    padding: 0;
    display: grid;
    gap: 2px;
  }
  .photos li {
    display: flex;
    gap: 8px;
    justify-content: space-between;
  }
  .photos .name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .photos .dim {
    flex: none;
  }
  .bar {
    height: 4px;
    background: var(--bg);
    border-radius: 2px;
    overflow: hidden;
  }
  .bar i {
    display: block;
    height: 100%;
    background: var(--accent);
    transition: width 0.2s;
  }
  .result {
    border: 1px solid var(--line);
    border-left: 3px solid #4caf50;
    border-radius: 4px;
    padding: 8px 10px;
    margin-bottom: 10px;
    display: grid;
    gap: 4px;
    line-height: 1.4;
  }
  .result.bad {
    border-left-color: #e5534b;
  }
  .result ul {
    margin: 0;
    padding-left: 18px;
  }
  .buttons {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .spacer {
    flex: 1;
  }
</style>
