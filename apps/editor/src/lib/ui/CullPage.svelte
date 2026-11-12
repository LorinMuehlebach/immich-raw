<script lang="ts">
  // The page Immich's "Auto-stack" button opens for the selected photos (?cull=<key>): choose what
  // counts, look at a preview if wanted, then stack the similar photos and pick the best of each.
  // The stacks it made open in the stack window, and the run can be undone here.
  import type { SelectionHandoff } from '@immich-raw/inject/handoff';
  import { editorUrl } from '@immich-raw/inject/routes';
  import { onDestroy, onMount } from 'svelte';
  import { readHandoff } from '../handoff.ts';
  import { getSession, initApi } from '../immich/api.ts';
  import { describeRun, runPhase, stackCards, type StackCard } from '../immich/cull-view.ts';
  import {
    applyRun,
    cullerStatus,
    getRun,
    loadCullOptions,
    lookupCull,
    saveCullOptions,
    startRun,
    undoRun,
    waitForRun,
    type CullerStatus,
    type CullInfo,
    type CullOptions,
    type CullRun,
  } from '../immich/culler.ts';
  import type { StackFrame } from '../immich/stack-view.ts';
  import CullOptionsFields from './CullOptionsFields.svelte';
  import StackViewer from './StackViewer.svelte';
  import { imageLoader, thumbUrl } from './images.ts';

  const key = new URLSearchParams(location.search).get('cull') ?? '';
  // The applied run, for this tab: back from the editor or after a reload it shows again.
  const RUN_KEY = `immich-raw.cull-run.${key}`;

  let status = $state<'loading' | 'auth' | 'ready' | 'error'>('loading');
  let handoff = $state.raw<SelectionHandoff | null>(null);
  let culler = $state.raw<CullerStatus | null>(null);
  let error = $state('');
  const backUrl = $derived(handoff?.returnPath ?? '/');

  let options = $state<CullOptions>(loadCullOptions());
  /** Also stack the shots whose stack was taken apart in Immich (the culler leaves them alone otherwise). */
  let force = $state(false);
  let busy = $state<'preview' | 'apply' | 'undo' | null>(null);
  let progress = $state.raw<CullRun | null>(null);
  /** The preview or the applied run on show. */
  let run = $state.raw<CullRun | null>(null);
  let runError = $state<string | null>(null);
  let notice = $state<string | null>(null);
  // Changes made in the stack window since the run: the culler's new state, and trashed photos.
  let live = $state.raw<Record<string, CullInfo>>({});
  let trashed = $state.raw<ReadonlySet<string>>(new Set());
  let open = $state.raw<StackCard | null>(null);

  const controller = new AbortController();
  const { img, dispose } = imageLoader();

  const count = $derived(handoff ? handoff.expected || handoff.ids.length : 0);
  const unread = $derived(handoff ? Math.max(0, handoff.expected - handoff.ids.length) : 0);
  const applied = $derived(!!run && !run.dryRun);
  const changes = $derived(run?.summary?.changes ?? 0);
  const takenApart = $derived(run?.summary?.takenApart ?? 0);
  const cards = $derived(run?.report?.groups ? stackCards(run.report.groups, live, trashed) : []);
  // The culler undoes newest first: after a change in the stack window this run can't be undone.
  const changedSince = $derived(Object.keys(live).length > 0 || trashed.size > 0);

  const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

  onMount(async () => {
    document.title = 'Auto-stack · immich-raw';
    initApi();
    handoff = readHandoff(key);
    try {
      if (!(await getSession())) {
        status = 'auth';
        return;
      }
    } catch (e) {
      error = `Can't reach Immich: ${message(e)}`;
      status = 'error';
      return;
    }
    if (!handoff || handoff.ids.length < 2) {
      error = 'Select two photos or more in Immich and click the auto-stack button again.';
      status = 'error';
      return;
    }
    culler = await cullerStatus();
    if (!culler) {
      error = "The culler service isn't reachable, or it works on another Immich user's library.";
      status = 'error';
      return;
    }
    status = 'ready';
    await restore();
  });

  onDestroy(() => {
    controller.abort();
    dispose();
  });

  async function restore() {
    let id: string | null = null;
    try {
      id = sessionStorage.getItem(RUN_KEY);
    } catch {
      return;
    }
    const r = id ? await getRun(id).catch(() => null) : null;
    if (r?.status === 'done' && !r.dryRun && !r.undoneAt) run = r;
  }

  function show(r: CullRun | null) {
    run = r;
    live = {};
    trashed = new Set();
    try {
      if (r && !r.dryRun) sessionStorage.setItem(RUN_KEY, r.id);
      else sessionStorage.removeItem(RUN_KEY);
    } catch {
      // storage blocked: the result shows until the page is left
    }
  }

  async function track(start: () => Promise<string>, kind: 'preview' | 'apply' | 'undo'): Promise<CullRun | null> {
    busy = kind;
    runError = null;
    notice = null;
    try {
      const r = await waitForRun(await start(), (p) => (progress = p), controller.signal);
      if (r.status === 'failed') {
        runError = r.error ?? 'The run failed';
        return null;
      }
      return r;
    } catch (e) {
      if ((e as Error).name !== 'AbortError') runError = message(e);
      return null;
    } finally {
      busy = null;
      progress = null;
    }
  }

  const scope = () => ({ kind: 'assets' as const, ids: handoff?.ids ?? [] });

  async function preview() {
    if (busy) return;
    const r = await track(() => startRun(scope(), true, options, force), 'preview');
    if (r) show(r);
  }

  /** Applies the preview on show, or stacks right away. */
  async function stack() {
    if (busy) return;
    const previewed = run?.dryRun ? run : null;
    const r = await track(() => (previewed ? applyRun(previewed.id) : startRun(scope(), false, options, force)), 'apply');
    if (r) show(r);
  }

  /** The shots taken out of stacks before count too: preview again with them. */
  async function includeTakenApart() {
    force = true;
    await preview();
  }

  function setForce(on: boolean) {
    force = on;
    if (run?.dryRun) run = null; // the preview was made with the other choice
  }

  async function undo() {
    const done = run;
    if (busy || !done || done.dryRun) return;
    const r = await track(() => undoRun(done.id), 'undo');
    if (!r) return;
    show(null);
    const notes = r.summary?.notes ?? [];
    notice = `Undone: the photos are as they were before.${notes.length ? ` ${notes.join(' ')}` : ''}`;
  }

  function setOptions(o: CullOptions) {
    options = o;
    saveCullOptions(o);
    if (run?.dryRun) run = null; // the preview was made with the other choice
  }

  /** Another shot became the preferred one: ask the culler for the stack's new state. */
  async function refresh(c: StackCard) {
    const info = await lookupCull(c.assetIds).catch(() => null);
    if (info) live = { ...live, ...info };
  }

  function afterDelete(result: { trashed: string[]; kept: StackFrame; warning: string | null }) {
    trashed = new Set([...trashed, ...result.trashed]);
    open = null;
    notice = `Kept ${result.kept.face.originalFileName}, moved ${plural(result.trashed.length, 'photo')} to Immich's trash.`;
    if (result.warning) runError = result.warning;
  }

  function openInEditor(rawId: string) {
    location.assign(editorUrl(import.meta.env.BASE_URL, rawId, handoff?.context ?? 'timeline', location.pathname + location.search));
  }

  function details(c: StackCard): string {
    const aside = c.rejected.lighting + c.rejected.blur + c.rejected.eyes;
    const parts = [c.runnerUps && plural(c.runnerUps, 'runner-up'), aside && `${aside} set aside`].filter(Boolean);
    return parts.length ? parts.join(' · ') : 'all good';
  }

  function tooltip(c: StackCard): string {
    const r = c.rejected;
    const why = [r.lighting && `${r.lighting} lighting`, r.blur && `${r.blur} not sharp`, r.eyes && `${r.eyes} eyes closed`].filter(Boolean);
    return `${c.name}${why.length ? `\nSet aside: ${why.join(', ')}` : ''}${applied ? '\nClick to compare the shots' : ''}`;
  }
</script>

{#snippet stackBody(c: StackCard)}
  <span class="thumb">
    <img use:img={thumbUrl(c.faceId)} alt={c.name} draggable="false" />
    <span class="count">{c.shots}</span>
  </span>
  <span class="caption">★ {c.pinned ? 'Your pick' : 'Best'} of {c.shots}</span>
  <span class="sub">{details(c)}</span>
{/snippet}

<div class="page">
  <header>
    <a class="back" href={backUrl} title="Back to Immich">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20z" /></svg>
    </a>
    <span class="name">immich-raw</span>
    <span class="dim">Auto-stack</span>
  </header>
  <main>
    {#if status === 'loading'}
      <p class="dim">Loading…</p>
    {:else if status === 'auth'}
      <div class="card">
        <h2>Log in to Immich first</h2>
        <p>Auto-stack uses your Immich session. <a href="/auth/login">Open Immich</a>, log in, then select the photos again.</p>
      </div>
    {:else if status === 'error'}
      <div class="card">
        <h2>Can't auto-stack</h2>
        <p>{error}</p>
        <a class="button" href={backUrl}>Back to Immich</a>
      </div>
    {:else if handoff}
      <div class="column">
        <div class="card">
          <h2>Auto-stack {plural(count, 'selected photo')}</h2>
          <p class="dim">
            Stacks the similar photos among them (bursts, re-takes), puts the best one in front and tags the others with the reason: lighting, then
            sharpness, then closed eyes. Nothing is deleted.
          </p>
          {#if unread}
            <p class="warn">Immich had {handoff.expected} photos selected, but only {handoff.ids.length} could be read. Select them again to include the others.</p>
          {/if}

          <h3>What counts</h3>
          <CullOptionsFields {options} status={culler} disabled={!!busy || applied} onChange={setOptions} />
          <label class="force" title="Photos you took out of a stack, or whose stack you deleted, in Immich. The culler leaves them alone unless you include them here.">
            <input type="checkbox" checked={force} disabled={!!busy || applied} onchange={(e) => setForce(e.currentTarget.checked)} />
            Include previously stacked pictures
          </label>
          {#if culler?.eyes === false}<p class="dim small">Faces, eyes and smiles are off: the culler has no face models.</p>{/if}
          {#if culler?.people === false}<p class="dim small">People without a visible face aren't found: the culler has no people model.</p>{/if}

          {#if busy}
            <p class="progress">{busy === 'preview' ? 'Checking' : busy === 'apply' ? 'Stacking' : 'Undoing'}: {runPhase(progress)}</p>
          {/if}
          {#if runError}<p class="err">{runError}</p>{/if}
          {#if notice}<p class="ok">{notice}</p>{/if}

          <div class="buttons">
            {#if applied}
              {#if changes}
                <button
                  onclick={undo}
                  disabled={!!busy || changedSince}
                  title={changedSince ? 'Stacks were changed in the stack window since, so this run can no longer be undone here' : 'Take the stacks apart and remove the tags again'}
                >
                  Undo
                </button>
              {/if}
              <span class="spacer"></span>
              <a class="button primary" href={backUrl}>Back to Immich</a>
            {:else}
              <button onclick={preview} disabled={!!busy}>Preview</button>
              <span class="spacer"></span>
              <button class="primary" onclick={stack} disabled={!!busy || (!!run?.dryRun && !changes)}>Stack and pick the best</button>
            {/if}
          </div>
        </div>

        {#if run}
          <section class="result" aria-label={applied ? 'Stacks made' : 'Preview'}>
            <p><strong>{applied ? 'Done' : 'Preview'}:</strong> {describeRun(run.summary)}.</p>
            {#if run.dryRun}
              <p class="dim">
                {changes ? `Nothing has changed yet. Stacking makes ${plural(changes, 'change')} in Immich (stacks, tags, reject flags).` : 'Immich is already up to date.'}
              </p>
            {:else if run.summary?.errors}
              <p class="err">{plural(run.summary.errors, 'change')} in Immich failed; the culler's log has the details.</p>
            {:else if !changes}
              <p class="dim">Nothing changed in Immich.</p>
            {:else if cards.length}
              <p class="dim">Click a stack to compare its shots, pick another one or delete the others.</p>
            {/if}
            {#if takenApart && !run.force}
              <div class="note">
                <p>
                  {plural(takenApart, 'shot was', 'shots were')} left alone: their stacks were taken apart in Immich before (or they were taken out of
                  one), and the culler doesn't stack them again on its own.
                </p>
                {#if !applied}<button onclick={includeTakenApart} disabled={!!busy}>Include them</button>{/if}
              </div>
            {/if}
            {#if cards.length}
              <ul class="stacks">
                {#each cards as c (c.groupId)}
                  <li>
                    {#if applied}
                      <button class="stack" onclick={() => (open = c)} title={tooltip(c)}>{@render stackBody(c)}</button>
                    {:else}
                      <div class="stack" title={tooltip(c)}>{@render stackBody(c)}</div>
                    {/if}
                  </li>
                {/each}
              </ul>
            {:else if !takenApart || run.force}
              <p class="dim">No similar photos to stack in this selection.</p>
            {/if}
          </section>
        {/if}
      </div>
    {/if}
  </main>
</div>

{#if open}
  {@const c = open}
  <StackViewer assetId={c.faceId} canCull onClose={() => (open = null)} onOpenInEditor={openInEditor} onPicked={() => refresh(c)} onDeleted={afterDelete} />
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
  .column {
    width: 760px;
    max-width: 100%;
    display: grid;
    gap: 16px;
    align-content: start;
  }
  .card {
    width: 460px;
    max-width: 100%;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 16px 18px;
    font-size: 13px;
  }
  .column .card {
    width: auto;
  }
  .card h2 {
    margin: 0 0 8px;
    font-size: 15px;
    color: var(--text-bright);
  }
  h3 {
    margin: 14px 0 4px;
    font-size: 13px;
    color: var(--text-bright);
  }
  p {
    margin: 6px 0;
    line-height: 1.45;
  }
  .small {
    font-size: 12px;
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
  .button.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #0b1220;
    font-weight: 600;
  }
  .buttons {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 14px;
  }
  .buttons button,
  .buttons .button {
    padding: 6px 14px;
  }
  .spacer {
    flex: 1;
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
  .warn {
    color: #e0b050;
  }
  .result {
    font-size: 13px;
  }
  .force {
    display: flex;
    gap: 6px;
    align-items: center;
    margin-top: 3px;
    cursor: pointer;
  }
  .force input {
    accent-color: var(--accent);
    margin: 0;
  }
  .note {
    display: flex;
    gap: 12px;
    align-items: center;
    margin: 8px 0;
    padding: 8px 12px;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--panel);
  }
  .note p {
    flex: 1;
    margin: 0;
  }
  .note button {
    flex: none;
    padding: 6px 14px;
  }
  .stacks {
    list-style: none;
    margin: 12px 0 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 18px 14px;
  }
  .stack {
    display: grid;
    gap: 2px;
    width: 100%;
    padding: 0;
    border: none;
    background: none;
    text-align: left;
    color: var(--text);
  }
  button.stack:hover .thumb img,
  button.stack:focus-visible .thumb img {
    outline: 2px solid var(--accent);
  }
  .thumb {
    position: relative;
    display: block;
    margin: 8px 8px 6px 0;
  }
  /* Two cards behind the photo: it is a stack. */
  .thumb::before,
  .thumb::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: 4px;
    border: 1px solid var(--line);
    background: var(--panel-2);
  }
  .thumb::before {
    transform: translate(8px, -8px);
  }
  .thumb::after {
    transform: translate(4px, -4px);
  }
  .thumb img {
    position: relative;
    z-index: 1;
    display: block;
    width: 100%;
    aspect-ratio: 1;
    object-fit: cover;
    border-radius: 4px;
    background: var(--panel);
  }
  .count {
    position: absolute;
    z-index: 2;
    right: 6px;
    bottom: 6px;
    min-width: 20px;
    padding: 1px 6px;
    border-radius: 10px;
    background: rgba(0, 0, 0, 0.7);
    color: var(--text-bright);
    font-size: 11px;
    text-align: center;
  }
  .caption {
    color: var(--text-bright);
  }
  .sub {
    color: var(--text-dim);
    font-size: 12px;
  }
  @media (pointer: coarse) {
    .buttons button,
    .buttons .button {
      padding: 10px 16px;
    }
    .force {
      min-height: 32px;
    }
  }
  @media (max-width: 499px) {
    main {
      padding: 16px;
    }
    .stacks {
      grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
    }
    .note {
      flex-direction: column;
      align-items: stretch;
    }
  }
</style>
