<script lang="ts">
  // "Auto-stack…" popover above the filmstrip: preview (dry run), apply, undo the last run, and
  // what the run takes into account (remembered in this browser; automatic runs use the culler's
  // own settings).
  import type { AssetResponseDto } from '@immich/sdk';
  import { onMount } from 'svelte';
  import { parseContext } from '../immich/context.ts';
  import {
    applyRun,
    lastUndoableRun,
    parseCullOptions,
    startRun,
    undoRun,
    waitForRun,
    type CullerStatus,
    type CullOptions,
    type CullRun,
    type RunCounts,
    type RunScope,
  } from '../immich/culler.ts';

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

  const OPTIONS_KEY = 'raw-editor.cull.options';
  let options = $state<CullOptions>(readOptions());

  function readOptions(): CullOptions {
    try {
      return parseCullOptions(JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? 'null'));
    } catch {
      return parseCullOptions(null);
    }
  }

  function setOption(key: keyof CullOptions, on: boolean) {
    options = { ...options, [key]: on };
    preview = null; // it was made with the other choice
    try {
      localStorage.setItem(OPTIONS_KEY, JSON.stringify(options));
    } catch {
      // storage blocked: the choice holds while the panel is open
    }
  }

  const CHOICES: { key: keyof CullOptions; label: string; title: string }[] = [
    { key: 'peopleFirst', label: "People's exposure counts most", title: 'Judge the exposure on the faces, or else on the people, before the rest of the photo' },
    { key: 'people', label: 'Find people without a visible face', title: 'Also people seen from the side, from behind or far away' },
    { key: 'smiles', label: 'Prefer the most smiles', title: 'Among the good shots, the one with the most smiling faces is the best' },
    { key: 'eyes', label: 'Set aside closed eyes', title: 'Shots with more closed eyes than the best one, or clearly less open eyes (a half-blink), are rejected' },
  ];
  const unavailable = (key: keyof CullOptions) =>
    (key === 'people' && status?.people === false) || ((key === 'eyes' || key === 'smiles') && status?.eyes === false);

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
    preview = await track(() => startRun(scope, true, options), 'preview');
  }

  async function doApply() {
    if (!preview) return;
    const run = await track(() => applyRun(preview!.id), 'apply');
    if (!run) return;
    result = `Done: ${describe(run.summary)}.`;
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

  function describe(c: Partial<RunCounts> | null | undefined): string {
    if (!c) return 'nothing to do';
    const r = c.rejected ?? { lighting: 0, blur: 0, eyes: 0 };
    const rejected = r.lighting + r.blur + r.eyes;
    const parts = [`${c.groups ?? 0} ${c.groups === 1 ? 'stack' : 'stacks'} from ${c.photos ?? 0} photos`];
    if (c.runnerUps) parts.push(`${c.runnerUps} runner-ups`);
    if (rejected) {
      const why = [r.lighting && `${r.lighting} lighting`, r.blur && `${r.blur} not sharp`, r.eyes && `${r.eyes} eyes closed`].filter(Boolean);
      parts.push(`${rejected} set aside (${why.join(', ')})`);
    }
    if (c.pending) parts.push(`${c.pending} still waiting for Immich's preview`);
    return parts.join(' · ');
  }

  const phaseText = (r: CullRun | null) =>
    !r ? 'starting…' : r.status === 'queued' ? 'waiting for another run…' : `${r.phase ?? 'working'}${r.total ? ` ${r.done}/${r.total}` : '…'}`;
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

  <fieldset class="choices" disabled={!!busy}>
    {#each CHOICES as c (c.key)}
      <label title={c.title} class:off={unavailable(c.key)}>
        <input type="checkbox" checked={options[c.key] && !unavailable(c.key)} disabled={unavailable(c.key)} onchange={(e) => setOption(c.key, e.currentTarget.checked)} />
        {c.label}
      </label>
    {/each}
  </fieldset>

  {#if busy}
    <p class="progress">{busy === 'preview' ? 'Checking' : busy === 'apply' ? 'Applying' : 'Undoing'}: {phaseText(progress)}</p>
  {:else if preview}
    <p>{describe(preview.summary)}.</p>
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
  .choices {
    border: none;
    margin: 6px 0;
    padding: 0;
    display: grid;
    gap: 3px;
  }
  .choices label {
    display: flex;
    gap: 6px;
    align-items: center;
    cursor: pointer;
  }
  .choices label.off {
    color: var(--text-dim);
    cursor: default;
  }
  .choices input {
    accent-color: var(--accent);
    margin: 0;
  }
  @media (pointer: coarse) {
    .choices label {
      min-height: 32px;
    }
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
