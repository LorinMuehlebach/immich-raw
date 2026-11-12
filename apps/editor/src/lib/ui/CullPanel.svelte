<script lang="ts">
  // "Auto-stack…" popover above the filmstrip: preview (dry run), apply, undo the last run, and
  // what the run takes into account (remembered in this browser; automatic runs use the culler's
  // own settings).
  import type { AssetResponseDto } from '@immich/sdk';
  import { onMount } from 'svelte';
  import { parseContext } from '../immich/context.ts';
  import { describeRun, runPhase } from '../immich/cull-view.ts';
  import {
    applyRun,
    lastUndoableRun,
    loadCullOptions,
    saveCullOptions,
    startRun,
    undoRun,
    waitForRun,
    type CullerStatus,
    type CullOptions,
    type CullRun,
    type RunScope,
  } from '../immich/culler.ts';
  import CullOptionsFields from './CullOptionsFields.svelte';

  interface Props {
    ctx: string | null;
    current: AssetResponseDto;
    status: CullerStatus | null;
    onClose: () => void;
    onChanged: () => void;
  }

  let { ctx, current, status, onClose, onChanged }: Props = $props();

  const context = $derived(parseContext(ctx));
  const day = $derived((current.localDateTime ?? current.fileCreatedAt).slice(0, 10));
  const scope = $derived<RunScope>(context.kind === 'album' ? { kind: 'album', id: context.id } : { kind: 'day', date: day });
  const scopeLabel = $derived(
    context.kind === 'album'
      ? 'the photos of this album'
      : `the photos taken on ${new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, { dateStyle: 'long', timeZone: 'UTC' })}`,
  );

  let busy = $state<'preview' | 'apply' | 'undo' | null>(null);
  let progress = $state<CullRun | null>(null);
  let preview = $state<CullRun | null>(null);
  let result = $state<string | null>(null);
  let error = $state<string | null>(null);
  let undoable = $state<CullRun | null>(null);
  const controller = new AbortController();

  let options = $state<CullOptions>(loadCullOptions());

  function setOptions(o: CullOptions) {
    options = o;
    preview = null; // it was made with the other choice
    saveCullOptions(o);
  }

  onMount(() => {
    void refreshUndoable();
    return () => controller.abort();
  });

  async function refreshUndoable() {
    try {
      undoable = await lastUndoableRun();
    } catch {
      undoable = null;
    }
  }

  async function track(start: () => Promise<string>, kind: 'preview' | 'apply' | 'undo'): Promise<CullRun | null> {
    busy = kind;
    error = null;
    result = null;
    try {
      const run = await waitForRun(await start(), (r) => (progress = r), controller.signal);
      if (run.status === 'failed') {
        error = run.error ?? 'The run failed';
        return null;
      }
      return run;
    } catch (e) {
      if ((e as Error).name !== 'AbortError') error = e instanceof Error ? e.message : String(e);
      return null;
    } finally {
      busy = null;
      progress = null;
    }
  }

  async function doPreview() {
    preview = await track(() => startRun(scope, true, { options }), 'preview');
  }

  async function doApply() {
    if (!preview) return;
    const run = await track(() => applyRun(preview!.id), 'apply');
    if (!run) return;
    result = `Done: ${describeRun(run.summary)}.`;
    preview = null;
    onChanged();
    await refreshUndoable();
  }

  async function doUndo() {
    if (!undoable) return;
    const run = await track(() => undoRun(undoable!.id), 'undo');
    if (!run) return;
    const notes = run.summary?.notes ?? [];
    result = `Undone.${notes.length ? ` ${notes.join(' ')}` : ''}`;
    preview = null;
    onChanged();
    await refreshUndoable();
  }

</script>

<div class="panel" role="dialog" aria-label="Auto-stack">
  <div class="row title">
    <strong>Auto-stack</strong>
    <button class="close" onclick={onClose} aria-label="Close">×</button>
  </div>
  <p class="dim">
    Stacks similar photos of {scopeLabel}, puts the best one in front and tags the others with the reason: lighting, then
    sharpness, then closed eyes.
  </p>

  <CullOptionsFields {options} {status} disabled={!!busy} onChange={setOptions} />

  {#if busy}
    <p class="progress">{busy === 'preview' ? 'Checking' : busy === 'apply' ? 'Applying' : 'Undoing'}: {runPhase(progress)}</p>
  {:else if preview}
    <p>{describeRun(preview.summary)}.</p>
    {#if preview.summary?.changes}
      <p class="dim">{preview.summary.changes} changes in Immich (stacks, tags, reject flags).</p>
    {:else}
      <p class="dim">Immich is already up to date.</p>
    {/if}
  {/if}
  {#if result}<p class="ok">{result}</p>{/if}
  {#if error}<p class="err">{error}</p>{/if}

  <div class="row buttons">
    <button onclick={doPreview} disabled={!!busy}>Preview</button>
    <button class="primary" onclick={doApply} disabled={!!busy || !preview || !preview.summary?.changes}>Apply</button>
    <span class="spacer"></span>
    <button onclick={doUndo} disabled={!!busy || !undoable} title={undoable ? `Undo the run of ${new Date(undoable.createdAt).toLocaleString()}` : 'Nothing to undo'}>
      Undo last run
    </button>
  </div>
  {#if status}
    <p class="dim small">
      {#if status.watcher?.enabled}New uploads are stacked {status.watcher.autoApply ? 'automatically' : 'as suggestions'}.{:else}Automatic
        stacking of new uploads is off.{/if}
      {#if status.eyes === false}Faces, eyes and smiles are off (face models missing).{/if}
      {#if status.people === false}People without a visible face aren't found (model missing).{/if}
      These choices are for runs started here; automatic runs use the culler's settings.
    </p>
  {/if}
</div>

<style>
  .panel {
    position: absolute;
    bottom: 100%;
    left: 8px;
    z-index: 20;
    width: 340px;
    max-width: calc(100vw - 16px);
    margin-bottom: 6px;
    padding: 10px 12px;
    background: var(--panel-2);
    border: 1px solid var(--line);
    border-radius: 6px;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.5);
    font-size: 12px;
    color: var(--text);
  }
  p {
    margin: 6px 0;
    line-height: 1.4;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .title {
    justify-content: space-between;
  }
  .close {
    background: none;
    border: none;
    font-size: 16px;
    line-height: 1;
    color: var(--text-dim);
  }
  .buttons {
    margin-top: 8px;
  }
  .spacer {
    flex: 1;
  }
  .dim {
    color: var(--text-dim);
  }
  .small {
    font-size: 11px;
    margin-top: 8px;
  }
  .progress {
    color: var(--accent);
  }
  .ok {
    color: var(--ok);
  }
  .err {
    color: var(--danger);
  }
</style>
