<script lang="ts">
  // The stack window: the shots of one culler stack, one at a time and large, with what the culler
  // measured. ← / → switch shots. The owner can make a shot the preferred one, or keep the
  // preferred shot and move all the others to Immich's trash.
  import { onDestroy, onMount } from 'svelte';
  import { apiUrl, authHeaders, hasApiKey } from '../immich/api.ts';
  import { captureTime, shotSettings } from '../immich/context.ts';
  import { badgeFor, metricRows } from '../immich/cull-view.ts';
  import { makeBest, waitForRun } from '../immich/culler.ts';
  import { deleteOthers, frameIndexOf, loadStackView, planDeleteOthers, preferredFrame, step, type StackFrame, type StackView } from '../immich/stack-view.ts';

  interface Props {
    /** A photo of the stack; the window starts on its shot. */
    assetId: string;
    /** The user may change the stack (owner of the photos). */
    canCull?: boolean;
    /** Fills the page (opened from Immich) instead of a window over the editor. */
    page?: boolean;
    /** The photo open in the editor: the delete confirmation says when it is one of the deleted. */
    editing?: { id: string; unsaved: boolean } | null;
    onClose: () => void;
    onOpenInEditor?: (rawId: string) => void;
    /** Another shot became the preferred one. */
    onPicked?: () => void;
    /** The other shots are in the trash. `warning`: the culler couldn't tidy up the stack. */
    onDeleted?: (result: { trashed: string[]; kept: StackFrame; warning: string | null }) => void;
  }

  let { assetId, canCull = false, page = false, editing = null, onClose, onOpenInEditor, onPicked, onDeleted }: Props = $props();

  let status = $state<'loading' | 'ready' | 'empty' | 'error'>('loading');
  let error = $state('');
  let view = $state.raw<StackView | null>(null);
  let index = $state(0);
  let busy = $state<'pick' | 'delete' | null>(null);
  let actionError = $state<string | null>(null);
  let confirming = $state(false);

  const cur = $derived(view?.frames[index] ?? null);
  const count = $derived(view?.frames.length ?? 0);
  const badge = $derived(badgeFor(cur?.info ?? null));
  const rows = $derived(cur ? metricRows(cur.info) : []);
  const settings = $derived(cur ? shotSettings((cur.raw ?? cur.face).exifInfo).join(' · ') : '');
  const isBest = $derived(cur?.info.role === 'best');
  const keep = $derived(view ? preferredFrame(view) : null);
  const plan = $derived(view && keep ? planDeleteOthers(view, keep.frameId) : null);
  const deletesEditing = $derived(!!editing && !!plan?.trashIds.includes(editing.id));

  const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

  async function load(startOn: string) {
    try {
      const v = await loadStackView(startOn);
      if (!v || v.frames.length < 2) {
        status = 'empty';
        return;
      }
      view = v;
      index = frameIndexOf(v, startOn);
      status = 'ready';
    } catch (e) {
      error = `Couldn't load the stack: ${message(e)}`;
      status = 'error';
    }
  }

  onMount(() => {
    void load(assetId);
  });

  function go(delta: number) {
    if (!busy) index = step(index, delta, count);
  }

  function close() {
    if (busy) return;
    onClose();
  }

  async function makePreferred() {
    const f = cur;
    if (!view || !f || !canCull || busy || f.info.role === 'best') return;
    busy = 'pick';
    actionError = null;
    try {
      const run = await waitForRun(await makeBest(view.groupId, f.pickId));
      if (run.status === 'failed') actionError = run.error ?? "Couldn't change the preferred shot";
      await load(f.pickId);
      onPicked?.();
    } catch (e) {
      actionError = message(e);
    } finally {
      busy = null;
    }
  }

  async function confirmDelete() {
    const v = view;
    const k = keep;
    if (!v || !k || busy) return;
    busy = 'delete';
    actionError = null;
    try {
      const result = await deleteOthers(v, k.frameId);
      confirming = false;
      onDeleted?.({ ...result, kept: k });
    } catch (e) {
      actionError = `Couldn't move the photos to the trash: ${message(e)}`;
    } finally {
      busy = null;
    }
  }

  function onKey(e: KeyboardEvent) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Escape') {
      if (confirming) {
        if (!busy) confirming = false;
      } else close();
    } else if (confirming || status !== 'ready') {
      return;
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      go(e.key === 'ArrowLeft' ? -1 : 1);
    } else if (e.key === 'Home' || e.key === 'End') {
      if (!busy) index = e.key === 'Home' ? 0 : count - 1;
    } else if (e.key.toLowerCase() === 'p') {
      void makePreferred();
    } else {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
  }

  // Swipe on the photo (touch and pen) to switch shots.
  let swipe: { id: number; x: number; y: number } | null = null;
  function swipeStart(e: PointerEvent) {
    if (e.pointerType !== 'mouse') swipe = { id: e.pointerId, x: e.clientX, y: e.clientY };
  }
  function swipeEnd(e: PointerEvent) {
    const s = swipe;
    swipe = null;
    if (!s || s.id !== e.pointerId) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1);
  }

  // Images. Session cookie: plain <img src>. API key: <img> can't send the header, so fetch each
  // image once as a blob; the object URLs live as long as the window.
  const previewUrl = (id: string) => apiUrl(`/assets/${id}/thumbnail?size=preview`);
  const thumbUrl = (id: string) => apiUrl(`/assets/${id}/thumbnail?size=thumbnail`);
  const blobs = new Map<string, Promise<string | null>>();

  function blobUrl(url: string): Promise<string | null> {
    let hit = blobs.get(url);
    if (!hit) {
      hit = fetch(url, { headers: authHeaders(), credentials: 'same-origin' })
        .then((r) => (r.ok ? r.blob() : null))
        .then((b) => (b ? URL.createObjectURL(b) : null))
        .catch(() => null);
      blobs.set(url, hit);
    }
    return hit;
  }

  function img(node: HTMLImageElement, url: string) {
    let wanted = url;
    const show = (u: string) => {
      wanted = u;
      if (!hasApiKey()) {
        node.src = u;
        return;
      }
      void blobUrl(u).then((b) => {
        if (b && wanted === u) node.src = b;
      });
    };
    show(url);
    return { update: show };
  }

  // Load the shots next to this one ahead, so switching is quick.
  $effect(() => {
    const v = view;
    if (!v) return;
    for (const f of [v.frames[index - 1], v.frames[index + 1]]) {
      if (!f) continue;
      if (hasApiKey()) void blobUrl(previewUrl(f.face.id));
      else new Image().src = previewUrl(f.face.id);
    }
  });

  onDestroy(() => {
    for (const p of blobs.values()) void p.then((u) => u && URL.revokeObjectURL(u));
  });

  function centreIf(node: HTMLElement, isCurrent: boolean) {
    const run = (c: boolean) => c && node.scrollIntoView({ block: 'nearest', inline: 'center' });
    queueMicrotask(() => run(isCurrent));
    return { update: run };
  }

  function autofocus(node: HTMLElement) {
    queueMicrotask(() => node.focus());
  }

  const when = (f: StackFrame) => {
    const t = captureTime(f.raw ?? f.face);
    return t ? new Date(t).toLocaleString(undefined, { timeZone: 'UTC' }) : '';
  };
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
</script>

<svelte:window onkeydown={onKey} />

<div class="backdrop" class:page role="presentation" onclick={() => !page && close()}>
  <div class="window" role="dialog" aria-modal="true" aria-labelledby="stack-title" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={() => {}} use:autofocus>
    <header>
      <h2 id="stack-title">Stack{#if view}<span class="dim">{` · ${plural(count, 'shot', 'shots')}`}</span>{/if}</h2>
      {#if view}<span class="pos">{index + 1} of {count}</span>{/if}
      <span class="spacer"></span>
      {#if !page}
        <button class="icon close" onclick={close} disabled={!!busy} title="Close (Esc)" aria-label="Close">✕</button>
      {/if}
    </header>

    {#if status === 'loading'}
      <div class="msg">Loading the stack…</div>
    {:else if status === 'empty'}
      <div class="msg">This photo isn't in a stack the culler made, or the stack has only one shot left.</div>
    {:else if status === 'error'}
      <div class="msg err">{error}</div>
    {:else if view && cur}
      <div class="body">
        <div class="stage" role="presentation" onpointerdown={swipeStart} onpointerup={swipeEnd} onpointercancel={() => (swipe = null)}>
          {#key cur.face.id}
            <img class="photo" class:rejected={badge?.tone === 'rejected'} alt={cur.face.originalFileName} use:img={previewUrl(cur.face.id)} draggable="false" />
          {/key}
          {#if badge}<span class="badge {badge.tone}" aria-label={badge.label}>{badge.icon}</span>{/if}
          <button class="nav prev" onclick={() => go(-1)} disabled={index === 0 || !!busy} title="Previous shot (←)" aria-label="Previous shot">‹</button>
          <button class="nav next" onclick={() => go(1)} disabled={index === count - 1 || !!busy} title="Next shot (→)" aria-label="Next shot">›</button>
        </div>

        <aside class="info">
          <div class="name" title={cur.face.originalFileName}>{cur.face.originalFileName}</div>
          {#if when(cur)}<div class="dim">{when(cur)}</div>{/if}
          <dl>
            {#each rows as r (r.label)}
              <dt>{r.label}</dt>
              <dd class:bad={r.bad}>{r.value}</dd>
            {/each}
          </dl>
          {#if settings}<div class="dim">{settings}</div>{/if}
          <div class="files" title="The files of this shot">{cur.assets.map((a) => a.originalFileName).join(' · ')}</div>
          <div class="actions">
            {#if canCull}
              <button class:primary={!isBest} onclick={makePreferred} disabled={isBest || !!busy} title={isBest ? 'This is the preferred shot of the stack' : 'Put this shot in front of the stack (P)'}>
                {isBest ? '★ Preferred' : '★ Make preferred'}
              </button>
            {/if}
            {#if cur.raw && onOpenInEditor}
              {@const rawId = cur.raw.id}
              <button onclick={() => onOpenInEditor(rawId)} disabled={!!busy} title="Edit this shot's RAW">Open in editor</button>
            {/if}
          </div>
          {#if busy === 'pick'}<div class="dim">Updating the stack…</div>{/if}
          {#if actionError && !confirming}<div class="err">{actionError}</div>{/if}
        </aside>
      </div>

      <footer>
        <div class="thumbs" role="listbox" aria-label="Shots">
          {#each view.frames as f, i (f.frameId)}
            {@const b = badgeFor(f.info)}
            <button class="thumb" class:current={i === index} class:rejected={b?.tone === 'rejected'} role="option" aria-selected={i === index} title={`${f.face.originalFileName}${b ? `\n${b.label}` : ''}`} onclick={() => !busy && (index = i)} use:centreIf={i === index}>
              <img alt={f.face.originalFileName} use:img={thumbUrl(f.face.id)} draggable="false" />
              {#if b}<span class="badge small {b.tone}">{b.icon}</span>{/if}
            </button>
          {/each}
        </div>
        {#if canCull}
          <button class="danger" onclick={() => (confirming = true)} disabled={!!busy} title="Keep the preferred shot and move the others to Immich's trash">Delete others…</button>
        {/if}
      </footer>

      {#if confirming && keep && plan}
        <div class="confirm-back" role="presentation" onclick={() => !busy && (confirming = false)}>
          <div class="confirm" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={() => {}} use:autofocus>
            <h3 id="confirm-title">Delete the other shots?</h3>
            <div class="keep">
              <img alt={keep.face.originalFileName} use:img={thumbUrl(keep.face.id)} draggable="false" />
              <div>
                <div>Keep <b>{keep.face.originalFileName}</b> (★ preferred)</div>
                <div class="dim">and move the other {plural(plan.shots, 'shot', 'shots')} ({plural(plan.trashIds.length, 'file', 'files')}: RAWs, JPEGs and edits) to Immich's trash.</div>
              </div>
            </div>
            <p class="dim">You can restore them from Immich's trash until it is emptied.</p>
            {#if keep.frameId !== cur.frameId}
              <p class="note">To keep the shot shown instead, cancel and make it the preferred one first (P).</p>
            {/if}
            {#if view.unsorted.length}
              <p class="note">{plural(view.unsorted.length, 'other file', 'other files')} in this stack {view.unsorted.length === 1 ? "wasn't" : "weren't"} sorted by the culler and {view.unsorted.length === 1 ? 'stays' : 'stay'}.</p>
            {/if}
            {#if deletesEditing}
              <p class="note">The photo open in the editor is one of them{editing?.unsaved ? '; its unsaved changes will be lost' : ''}. The editor moves to the kept shot.</p>
            {/if}
            {#if actionError}<p class="err">{actionError}</p>{/if}
            <div class="buttons">
              {#if busy === 'delete'}<span class="dim">Moving to the trash…</span>{/if}
              <span class="spacer"></span>
              <button onclick={() => (confirming = false)} disabled={!!busy}>Cancel</button>
              <button class="danger" onclick={confirmDelete} disabled={!!busy || !plan.trashIds.length}>Move to trash</button>
            </div>
          </div>
        </div>
      {/if}
    {/if}
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 110;
    background: rgba(0, 0, 0, 0.7);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
  }
  .backdrop.page {
    position: static;
    height: 100%;
    padding: 0;
    background: none;
  }
  .window {
    position: relative;
    width: min(1400px, 100%);
    height: 100%;
    display: grid;
    grid-template-rows: auto minmax(0, 1fr) auto;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 8px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
    outline: none;
    overflow: hidden;
  }
  .page .window {
    width: 100%;
    border: none;
    border-radius: 0;
    box-shadow: none;
  }
  header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 8px 6px 14px;
    border-bottom: 1px solid #111;
  }
  h2 {
    margin: 0;
    font-size: 14px;
    color: var(--text-bright);
  }
  .pos,
  .dim {
    color: var(--text-dim);
  }
  .spacer {
    flex: 1;
  }
  .close {
    line-height: 1;
    padding: 4px 8px;
  }
  .msg {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 32px 16px;
    color: var(--text-dim);
    grid-row: 2 / 4;
  }
  .err {
    color: #ff8a80;
  }
  .body {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 280px;
    min-height: 0;
  }
  .stage {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 0;
    background: var(--bg-view);
    touch-action: pan-y;
    user-select: none;
  }
  .photo {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    display: block;
  }
  .photo.rejected {
    filter: saturate(0.8);
  }
  .nav {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    width: 40px;
    height: 64px;
    padding: 0;
    font-size: 28px;
    line-height: 1;
    border: none;
    border-radius: 6px;
    background: rgba(0, 0, 0, 0.45);
    color: #fff;
  }
  .nav:disabled {
    opacity: 0;
    pointer-events: none;
  }
  .nav:hover:not(:disabled) {
    background: rgba(0, 0, 0, 0.7);
  }
  .prev {
    left: 8px;
  }
  .next {
    right: 8px;
  }
  .badge {
    position: absolute;
    top: 10px;
    left: 10px;
    min-width: 24px;
    height: 24px;
    padding: 0 4px;
    border-radius: 12px;
    font-size: 15px;
    line-height: 24px;
    text-align: center;
    pointer-events: none;
    background: rgba(0, 0, 0, 0.65);
  }
  .badge.small {
    top: 3px;
    left: 3px;
    min-width: 15px;
    height: 15px;
    padding: 0 2px;
    border-radius: 8px;
    font-size: 10px;
    line-height: 15px;
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
  .info {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px 14px;
    border-left: 1px solid #111;
    overflow: auto;
    min-height: 0;
  }
  .name {
    color: var(--text-bright);
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  dl {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 4px 12px;
    margin: 4px 0;
  }
  dt {
    color: var(--text-dim);
  }
  dd {
    margin: 0;
    color: var(--text-bright);
  }
  dd.bad {
    color: var(--danger);
  }
  .files {
    color: var(--text-dim);
    font-size: 11px;
    overflow-wrap: anywhere;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 4px;
  }
  footer {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 10px;
    border-top: 1px solid #111;
    min-width: 0;
  }
  .thumbs {
    flex: 1;
    display: flex;
    gap: 4px;
    overflow-x: auto;
    padding: 2px;
    scrollbar-width: thin;
    min-width: 0;
  }
  .thumb {
    position: relative;
    flex: none;
    width: 84px;
    height: 64px;
    padding: 2px;
    background: #1b1b1b;
    border: 1px solid transparent;
    border-radius: 3px;
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: 0.75;
  }
  .thumb:hover {
    opacity: 1;
    border-color: #555;
  }
  .thumb.current {
    opacity: 1;
    border-color: var(--accent);
    background: #2a2f38;
  }
  .thumb.rejected img {
    filter: saturate(0.5) brightness(0.8);
  }
  .thumb img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    display: block;
  }
  button.danger {
    background: #b3261e;
    border-color: #b3261e;
    color: #fff;
    flex: none;
  }
  button.danger:hover:not(:disabled) {
    filter: brightness(1.1);
    color: #fff;
    border-color: #b3261e;
  }
  .confirm-back {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
  }
  .confirm {
    width: 440px;
    max-width: 100%;
    max-height: 100%;
    overflow: auto;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 16px 18px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
    outline: none;
  }
  h3 {
    margin: 0 0 10px;
    font-size: 14px;
    color: var(--text-bright);
  }
  .keep {
    display: flex;
    gap: 10px;
    align-items: center;
    margin-bottom: 10px;
    line-height: 1.45;
    overflow-wrap: anywhere;
  }
  .keep img {
    width: 72px;
    height: 54px;
    object-fit: contain;
    background: #1b1b1b;
    border-radius: 3px;
    flex: none;
  }
  .confirm p {
    margin: 0 0 10px;
    line-height: 1.45;
  }
  .note {
    color: #ffcc80;
  }
  .buttons {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  /* Phones and tablets held upright: the details go below the photo. */
  @media (max-width: 699px), (orientation: portrait) and (max-width: 1099px) {
    .backdrop {
      padding: 0;
    }
    .window {
      border: none;
      border-radius: 0;
    }
    .body {
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: minmax(200px, 1fr) auto;
    }
    .info {
      border-left: none;
      border-top: 1px solid #111;
      max-height: 40vh;
    }
  }
  @media (pointer: coarse) {
    .nav {
      width: 48px;
      height: 72px;
    }
    .close,
    .actions button,
    footer > button,
    .buttons button {
      min-height: 40px;
      padding: 8px 14px;
    }
    .thumb {
      width: 96px;
      height: 72px;
    }
  }
</style>
