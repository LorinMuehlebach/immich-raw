<script lang="ts">
  // The page Immich's "Auto-stack" button opens for the selected photos (?cull=<key>): choose what
  // counts, look at a preview if wanted, then stack the similar photos and pick the best of each.
  // The result lists every stack (its preferred shot and all its shots) and the single photos, in
  // the order taken. A shot can be taken out of its stack (−) and a single photo added to the stack
  // before or after it; the culler remembers these edits. Stacks open in the stack window, and
  // every change can be undone here, newest first.
  import type { SelectionHandoff } from '@immich-raw/inject/handoff';
  import { editorUrl } from '@immich-raw/inject/routes';
  import { onDestroy, onMount } from 'svelte';
  import { readHandoff } from '../handoff.ts';
  import { getSession, initApi } from '../immich/api.ts';
  import {
    badgeFor,
    describeRun,
    layoutRows,
    NO_EDITS,
    runPhase,
    sameEdits,
    stackChoices,
    tooltipFor,
    withJoin,
    withRemove,
    type StackRow,
  } from '../immich/cull-view.ts';
  import {
    applyRun,
    cullerStatus,
    getRun,
    loadCullOptions,
    saveCullOptions,
    startRun,
    undoRun,
    waitForRun,
    type CullerStatus,
    type CullInfo,
    type CullOptions,
    type CullRun,
    type ReportFrame,
    type RunEdits,
  } from '../immich/culler.ts';
  import type { StackFrame } from '../immich/stack-view.ts';
  import CullOptionsFields from './CullOptionsFields.svelte';
  import StackViewer from './StackViewer.svelte';
  import { imageLoader, thumbUrl } from './images.ts';

  const key = new URLSearchParams(location.search).get('cull') ?? '';
  // What was stacked, for this tab: back from the editor or after a reload it shows again.
  const SAVED_KEY = `immich-raw.cull-run.${key}`;

  interface Applied {
    id: string;
    edits: RunEdits;
  }

  let status = $state<'loading' | 'auth' | 'ready' | 'error'>('loading');
  let handoff = $state.raw<SelectionHandoff | null>(null);
  let culler = $state.raw<CullerStatus | null>(null);
  let error = $state('');
  const backUrl = $derived(handoff?.returnPath ?? '/');

  let options = $state<CullOptions>(loadCullOptions());
  /** Also stack the shots whose stack was taken apart in Immich (the culler leaves them alone otherwise). */
  let force = $state(false);
  /** The user's own edits: shots taken out of their stack, single shots added to one. */
  let edits = $state.raw<RunEdits>(NO_EDITS);
  let busy = $state<'preview' | 'apply' | 'undo' | 'update' | null>(null);
  let progress = $state.raw<CullRun | null>(null);
  /** The run whose result is on show: a preview, the stacking, or the latest change. */
  let run = $state.raw<CullRun | null>(null);
  /** The photos are stacked: edits apply right away. */
  let stacked = $state(false);
  /** The runs this page applied that can be undone, newest last, each with the edits it had. */
  let applied = $state.raw<Applied[]>([]);
  let runError = $state<string | null>(null);
  let notice = $state<string | null>(null);
  /** Shots just clicked, dimmed until the culler has answered. */
  let pending = $state.raw<ReadonlySet<string>>(new Set());
  /** The single photo whose "add to a stack" choice is open. */
  let choosing = $state<string | null>(null);
  /** A stack was changed in the stack window: the culler can't undo this page's runs any more. */
  let windowChanged = $state(false);
  let open = $state<string | null>(null);

  const controller = new AbortController();
  const { img, dispose } = imageLoader();

  const count = $derived(handoff ? handoff.expected || handoff.ids.length : 0);
  const unread = $derived(handoff ? Math.max(0, handoff.expected - handoff.ids.length) : 0);
  const changes = $derived(run?.summary?.changes ?? 0);
  // Shots left alone that weren't taken out on this page: the note is for those.
  const takenApart = $derived(
    run?.report?.singles ? run.report.singles.filter((s) => s.leftAlone && !edits.remove.includes(s.frameId)).length : (run?.summary?.takenApart ?? 0),
  );
  const rows = $derived(layoutRows(run?.report));
  const hasEdits = (e: RunEdits) => e.remove.length > 0 || Object.keys(e.join).length > 0;
  const names = $derived(
    new Map([...(run?.report?.groups ?? []).flatMap((g) => g.frames.map((f) => [f.frameId, f.name] as const)), ...(run?.report?.singles ?? []).map((s) => [s.frameId, s.name] as const)]),
  );
  const ignored = $derived(run?.report?.edits?.ignored ?? []);
  // Edits wait while a preview, the stacking or an undo runs; during an update they queue.
  const canEdit = $derived(!busy || busy === 'update');

  const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const clock = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');

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

  interface Saved {
    shown: string;
    applied: Applied[];
    edits: RunEdits;
  }

  async function restore() {
    let saved: Saved | null = null;
    try {
      saved = JSON.parse(sessionStorage.getItem(SAVED_KEY) ?? 'null') as Saved | null;
    } catch {
      return;
    }
    if (!saved?.shown) return;
    const r = await getRun(saved.shown).catch(() => null);
    if (r?.status !== 'done') return;
    run = r;
    stacked = true;
    applied = saved.applied ?? [];
    edits = saved.edits ?? NO_EDITS;
  }

  function save() {
    try {
      if (stacked && run) sessionStorage.setItem(SAVED_KEY, JSON.stringify({ shown: run.id, applied, edits } satisfies Saved));
      else sessionStorage.removeItem(SAVED_KEY);
    } catch {
      // storage blocked: the result shows until the page is left
    }
  }

  async function track(start: () => Promise<string>, kind: NonNullable<typeof busy>): Promise<CullRun | null> {
    busy = kind;
    runError = null;
    if (kind !== 'update') notice = null;
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

  /** Keeps an applied run for Undo when it changed something (Immich, or the culler's memory of an edit). */
  function remember(r: CullRun, used: RunEdits) {
    const before = applied.at(-1)?.edits ?? NO_EDITS;
    if ((r.summary?.changes ?? 0) > 0 || !sameEdits(used, before)) applied = [...applied, { id: r.id, edits: used }];
  }

  async function preview() {
    if (busy) return;
    const r = await track(() => startRun(scope(), true, { options, force, edits }), 'preview');
    if (r) run = r;
  }

  /** Applies the preview on show (when it has the current choices), or stacks right away. */
  async function stack() {
    if (busy) return;
    const used = edits;
    const previewed = run?.dryRun && !!run.force === force && sameEdits(run.edits, used) ? run : null;
    const r = await track(() => (previewed ? applyRun(previewed.id) : startRun(scope(), false, { options, force, edits: used })), 'apply');
    if (!r) return;
    run = r;
    stacked = true;
    remember(r, used);
    save();
  }

  // --- the user's edits ---------------------------------------------------------------------------------
  let again = false;
  let againApply = false;

  /**
   * Asks the culler for the result with the current edits: applied when the photos are stacked (and
   * `apply`), else a preview. Clicks during an update queue one more update with the newest edits.
   */
  async function update(apply: boolean) {
    if (busy === 'update') {
      again = true;
      againApply ||= apply;
      return;
    }
    if (busy) return;
    let doApply = apply;
    do {
      again = false;
      const used = edits;
      const applyNow = doApply && stacked;
      const r = await track(() => startRun(scope(), !applyNow, { options, force: stacked ? false : force, edits: used }), 'update');
      if (r) {
        run = r;
        if (applyNow) remember(r, used);
        save();
      }
      doApply = againApply;
      againApply = false;
    } while (again);
    pending = new Set();
  }

  function takeOut(f: ReportFrame) {
    if (!canEdit) return;
    choosing = null;
    edits = withRemove(edits, f.frameId);
    pending = new Set([...pending, f.frameId]);
    void update(true);
  }

  function addTo(frameId: string, target: StackRow) {
    if (!canEdit) return;
    choosing = null;
    edits = withJoin(edits, frameId, target.frameIds);
    pending = new Set([...pending, frameId]);
    void update(true);
  }

  async function undo() {
    const top = applied.at(-1);
    if (busy || !top) return;
    const r = await track(() => undoRun(top.id), 'undo');
    if (!r) return;
    applied = applied.slice(0, -1);
    const notes = r.summary?.notes ?? [];
    const prev = applied.at(-1);
    if (!prev) {
      // The stacking itself is undone: back to the start, the edits kept for another try.
      stacked = false;
      run = null;
      edits = top.edits;
      save();
      notice = `Undone: the photos are as they were before.${notes.length ? ` ${notes.join(' ')}` : ''}`;
      return;
    }
    edits = prev.edits;
    await update(false);
    notice = `Undone.${notes.length ? ` ${notes.join(' ')}` : ''}`;
  }

  /** The shots taken out of stacks before count too: preview again with them. */
  async function includeTakenApart() {
    force = true;
    await preview();
  }

  function setForce(on: boolean) {
    force = on;
    if (run?.dryRun && !stacked) run = null; // the preview was made with the other choice
  }

  function setOptions(o: CullOptions) {
    options = o;
    saveCullOptions(o);
    if (run?.dryRun && !stacked) run = null; // the preview was made with the other choice
  }

  // --- the stack window -------------------------------------------------------------------------------------
  function afterPick() {
    windowChanged = true;
    void update(false);
  }

  function afterDelete(result: { trashed: string[]; kept: StackFrame; warning: string | null }) {
    open = null;
    windowChanged = true;
    notice = `Kept ${result.kept.face.originalFileName}, moved ${plural(result.trashed.length, 'photo')} to Immich's trash.`;
    if (result.warning) runError = result.warning;
    void update(false);
  }

  function openInEditor(rawId: string) {
    location.assign(editorUrl(import.meta.env.BASE_URL, rawId, handoff?.context ?? 'timeline', location.pathname + location.search));
  }

  // --- showing it ----------------------------------------------------------------------------------------------
  const infoOf = (r: StackRow, f: ReportFrame): CullInfo => ({
    groupId: r.groupId,
    frameId: f.frameId,
    role: f.role,
    reason: f.reason,
    rank: f.rank,
    groupSize: r.shots.length,
    pinned: f.pinned,
    metrics: f.metrics,
  });

  function details(r: StackRow): string {
    const aside = r.rejected.lighting + r.rejected.blur + r.rejected.eyes;
    const parts = [r.runnerUps && plural(r.runnerUps, 'runner-up'), aside && `${aside} set aside`].filter(Boolean);
    return parts.length ? parts.join(' · ') : 'all good';
  }

  function onWindowPointer(e: PointerEvent) {
    if (choosing && !(e.target as Element | null)?.closest('.single')) choosing = null;
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && choosing && !open) choosing = null;
  }
</script>

<svelte:window onpointerdown={onWindowPointer} onkeydown={onKey} />

{#snippet shot(r: StackRow, f: ReportFrame)}
  {@const info = infoOf(r, f)}
  {@const badge = badgeFor(info)}
  <li class="shot" class:best={f.frameId === r.best.frameId} class:pending={pending.has(f.frameId)}>
    <button class="pic" disabled={!stacked} onclick={() => (open = f.faceId)} title={`${tooltipFor(f.name, info)}${f.joined ? '\nAdded by you' : ''}`}>
      <img use:img={thumbUrl(f.faceId)} alt={f.name} draggable="false" />
      {#if badge}<span class="badge {badge.tone}">{badge.icon}</span>{/if}
      {#if f.joined}<span class="added" aria-label="Added by you">+</span>{/if}
    </button>
    <button class="minus" onclick={() => takeOut(f)} disabled={!canEdit || pending.has(f.frameId)} aria-label={`Take ${f.name} out of this stack`} title={`Take ${f.name} out of this stack`}
      >−</button
    >
  </li>
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
          <CullOptionsFields {options} status={culler} disabled={!!busy || stacked} onChange={setOptions} />
          <label class="force" title="Photos you took out of a stack, or whose stack you deleted, in Immich. The culler leaves them alone unless you include them here.">
            <input type="checkbox" checked={force} disabled={!!busy || stacked} onchange={(e) => setForce(e.currentTarget.checked)} />
            Include previously stacked pictures
          </label>
          {#if culler?.eyes === false}<p class="dim small">Faces, eyes and smiles are off: the culler has no face models.</p>{/if}
          {#if culler?.people === false}<p class="dim small">People without a visible face aren't found: the culler has no people model.</p>{/if}

          {#if busy}
            <p class="progress">
              {busy === 'preview' ? 'Checking' : busy === 'apply' ? 'Stacking' : busy === 'undo' ? 'Undoing' : 'Updating'}: {runPhase(progress)}
            </p>
          {/if}
          {#if runError}<p class="err">{runError}</p>{/if}
          {#if notice}<p class="ok">{notice}</p>{/if}

          <div class="buttons">
            {#if stacked}
              {#if applied.length}
                <button
                  onclick={undo}
                  disabled={!!busy || windowChanged}
                  title={windowChanged ? 'Stacks were changed in the stack window since, so this page can no longer undo its changes' : 'Undo the last change'}
                >
                  Undo
                </button>
              {/if}
              <span class="spacer"></span>
              <a class="button primary" href={backUrl}>Back to Immich</a>
            {:else}
              <button onclick={preview} disabled={!!busy}>Preview</button>
              <span class="spacer"></span>
              <button class="primary" onclick={stack} disabled={!!busy || (!!run?.dryRun && !changes && !hasEdits(edits))}>Stack and pick the best</button>
            {/if}
          </div>
        </div>

        {#if run}
          <section class="result" aria-label={stacked ? 'Stacks' : 'Preview'}>
            <p><strong>{stacked ? 'Done' : 'Preview'}:</strong> {describeRun(run.summary && { ...run.summary, takenApart })}.</p>
            {#if run.summary?.errors}
              <p class="err">{plural(run.summary.errors, 'change')} in Immich failed; the culler's log has the details.</p>
            {:else if !stacked}
              <p class="dim">
                {changes ? `Nothing has changed yet. Stacking makes ${plural(changes, 'change')} in Immich (stacks, tags, reject flags).` : 'Immich is already up to date.'}
              </p>
            {/if}
            {#if rows.length}
              <p class="dim small">
                − takes a shot out of its stack; click a single photo to add it to the stack before or after it.{stacked ? ' Click a stack to compare its shots.' : ''}
              </p>
            {/if}
            {#if takenApart && !run.force}
              <div class="note">
                <p>
                  {plural(takenApart, 'shot was', 'shots were')} left alone: their stacks were taken apart in Immich before (or they were taken out of
                  one), and the culler doesn't stack them again on its own.
                </p>
                {#if !stacked}<button onclick={includeTakenApart} disabled={!!busy}>Include them</button>{/if}
              </div>
            {/if}
            {#if ignored.length}
              <p class="warn small">
                Not done: {ignored.map((x) => `${names.get(x.frameId) ?? x.frameId} (${x.why})`).join(', ')}.
              </p>
            {/if}

            {#if rows.length}
              <ul class="rows">
                {#each rows as r (r.kind === 'stack' ? r.groupId : `s-${r.singles[0]?.frameId}`)}
                  {#if r.kind === 'stack'}
                    <li class="row stack-row">
                      <div class="lead">
                        <button class="lead-pic" disabled={!stacked} onclick={() => (open = r.best.faceId)} title={stacked ? 'Compare the shots of this stack' : r.best.name}>
                          <img use:img={thumbUrl(r.best.faceId)} alt={r.best.name} draggable="false" />
                          <span class="count">{r.shots.length}</span>
                        </button>
                        <span class="caption">★ {r.best.pinned ? 'Your pick' : 'Best'} of {r.shots.length}</span>
                        <span class="sub">{details(r)} · {clock(r.taken)}</span>
                      </div>
                      <ul class="shots">
                        {#each r.shots as f (f.frameId)}
                          {@render shot(r, f)}
                        {/each}
                      </ul>
                    </li>
                  {:else}
                    <li class="row singles-row">
                      <span class="sub">{r.singles.length === 1 ? 'Single photo' : `${r.singles.length} single photos`} · {clock(r.taken)}</span>
                      <ul class="shots">
                        {#each r.singles as s (s.frameId)}
                          {@const choices = choosing === s.frameId ? stackChoices(rows, s.frameId) : null}
                          <li class="shot single" class:pending={pending.has(s.frameId)}>
                            <button
                              class="pic"
                              onclick={() => (choosing = choosing === s.frameId ? null : s.frameId)}
                              disabled={!canEdit || s.pending || pending.has(s.frameId)}
                              aria-expanded={choosing === s.frameId}
                              title={s.pending ? `${s.name}: waiting for Immich's preview` : `${s.name}${s.leftAlone ? ' (taken out of a stack before)' : ''}\nClick to add it to a stack`}
                            >
                              <img use:img={thumbUrl(s.faceId)} alt={s.name} draggable="false" />
                              {#if s.leftAlone}<span class="tag">taken out</span>{/if}
                            </button>
                            {#if choices}
                              <div class="choose" role="dialog" aria-label={`Add ${s.name} to a stack`}>
                                <p class="small">Add {s.name} to</p>
                                {#each [['the stack before', choices.before], ['the stack after', choices.after]] as const as [label, target] (label)}
                                  {#if target}
                                    <button onclick={() => addTo(s.frameId, target)}>
                                      <img use:img={thumbUrl(target.best.faceId)} alt="" draggable="false" />
                                      <span>{label} <span class="dim">· {plural(target.shots.length, 'shot')} · {clock(target.taken)}</span></span>
                                    </button>
                                  {/if}
                                {/each}
                                {#if !choices.before && !choices.after}<p class="dim small">There's no stack before or after it.</p>{/if}
                              </div>
                            {/if}
                          </li>
                        {/each}
                      </ul>
                    </li>
                  {/if}
                {/each}
              </ul>
            {:else if !takenApart || run.force}
              <p class="dim">No photos to show.</p>
            {/if}
          </section>
        {/if}
      </div>
    {/if}
  </main>
</div>

{#if open}
  <StackViewer assetId={open} canCull onClose={() => (open = null)} onOpenInEditor={openInEditor} onPicked={afterPick} onDeleted={afterDelete} />
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
    width: 960px;
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

  /* The rows: a stack (its preferred shot large, all its shots beside it) or single photos. */
  .rows {
    list-style: none;
    margin: 12px 0 0;
    padding: 0;
    display: grid;
    gap: 10px;
  }
  .row {
    padding: 10px 12px;
    border: 1px solid var(--line);
    border-radius: 8px;
  }
  .stack-row {
    display: grid;
    grid-template-columns: 220px 1fr;
    gap: 16px;
    background: var(--panel);
  }
  .singles-row {
    display: grid;
    gap: 6px;
    border-style: dashed;
  }
  .lead {
    display: grid;
    gap: 2px;
    align-content: start;
  }
  .lead-pic {
    position: relative;
    display: block;
    padding: 0;
    border: none;
    background: none;
  }
  .lead-pic:disabled {
    opacity: 1;
    cursor: default;
  }
  .lead-pic img {
    display: block;
    width: 220px;
    aspect-ratio: 4 / 3;
    object-fit: cover;
    border-radius: 6px;
    background: var(--panel-2);
  }
  .lead-pic:not(:disabled):hover img,
  .lead-pic:focus-visible img {
    outline: 2px solid var(--accent);
  }
  .count {
    position: absolute;
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
    margin-top: 4px;
    color: var(--text-bright);
  }
  .sub {
    color: var(--text-dim);
    font-size: 12px;
  }
  .shots {
    list-style: none;
    margin: 0;
    padding: 6px 6px 0 0;
    display: flex;
    flex-wrap: wrap;
    gap: 12px 10px;
    align-content: flex-start;
  }
  .shot {
    position: relative;
    width: 96px;
  }
  .shot.pending {
    opacity: 0.4;
  }
  .pic {
    position: relative;
    display: block;
    padding: 0;
    border: none;
    background: none;
  }
  .pic:disabled {
    opacity: 1;
    cursor: default;
  }
  .pic img {
    display: block;
    width: 96px;
    height: 72px;
    object-fit: cover;
    border-radius: 4px;
    background: var(--panel-2);
  }
  .shot.best .pic img {
    outline: 2px solid #ffd54a;
    outline-offset: 1px;
  }
  .pic:not(:disabled):hover img,
  .pic:focus-visible img {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .badge {
    position: absolute;
    top: 3px;
    left: 3px;
    min-width: 15px;
    height: 15px;
    padding: 0 2px;
    border-radius: 8px;
    font-size: 10px;
    line-height: 15px;
    text-align: center;
    background: rgba(0, 0, 0, 0.6);
  }
  .badge.best {
    color: #ffd54a;
  }
  .badge.runner-up {
    color: #cfd8e3;
  }
  .badge.rejected {
    color: #fff;
    background: rgba(200, 50, 50, 0.85);
  }
  .added {
    position: absolute;
    left: 3px;
    bottom: 3px;
    width: 15px;
    height: 15px;
    border-radius: 8px;
    font-size: 11px;
    line-height: 15px;
    text-align: center;
    color: #0b1220;
    background: var(--ok);
  }
  .tag {
    position: absolute;
    left: 3px;
    bottom: 3px;
    padding: 0 4px;
    border-radius: 3px;
    font-size: 10px;
    color: var(--text-bright);
    background: rgba(0, 0, 0, 0.65);
  }
  .minus {
    position: absolute;
    top: -7px;
    right: -7px;
    width: 22px;
    height: 22px;
    padding: 0;
    border: 2px solid var(--bg-view);
    border-radius: 50%;
    background: var(--danger);
    color: #fff;
    font-size: 15px;
    font-weight: 700;
    line-height: 16px;
  }
  .minus:hover:not(:disabled) {
    color: #fff;
    filter: brightness(1.15);
  }
  .choose {
    position: absolute;
    z-index: 5;
    top: 100%;
    left: 0;
    width: 250px;
    margin-top: 6px;
    padding: 8px;
    display: grid;
    gap: 6px;
    background: var(--panel-2);
    border: 1px solid var(--line);
    border-radius: 6px;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.5);
  }
  .choose p {
    margin: 0;
  }
  .choose button {
    display: flex;
    gap: 8px;
    align-items: center;
    width: 100%;
    padding: 4px;
    text-align: left;
  }
  .choose img {
    width: 48px;
    height: 36px;
    object-fit: cover;
    border-radius: 3px;
  }
  @media (pointer: coarse) {
    .buttons button,
    .buttons .button {
      padding: 10px 16px;
    }
    .force {
      min-height: 32px;
    }
    .minus {
      width: 30px;
      height: 30px;
      top: -10px;
      right: -10px;
      line-height: 24px;
    }
    .choose button {
      min-height: 44px;
    }
  }
  @media (max-width: 699px) {
    .stack-row {
      grid-template-columns: 1fr;
    }
    .lead-pic img {
      width: 100%;
    }
  }
  @media (max-width: 499px) {
    main {
      padding: 16px;
    }
    .note {
      flex-direction: column;
      align-items: stretch;
    }
    .choose {
      width: min(250px, calc(100vw - 48px));
    }
  }
</style>
