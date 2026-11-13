<script lang="ts">
  // Filmstrip of the RAWs around the current one (same album, person or day). With the culler
  // service installed it also shows its stacks: the photos of a stack sit together, best first,
  // each with a badge saying why it lost. A stack's number opens the stack window.
  // Each thumbnail shows the photo as edited (its draft, else its saved JPEG) with its stars, pick,
  // reject and edit marks; the filters leave photos out of the strip and of ← → ↑ ↓.
  import { getAllTags, type AssetResponseDto } from '@immich/sdk';
  import { untrack } from 'svelte';
  import { apiUrl, authHeaders, hasApiKey } from '../immich/api.ts';
  import { captureTime, loadFilmstrip, loadTagged } from '../immich/context.ts';
  import { editStates } from '../immich/edit-state.ts';
  import { factsOf, noteFacts, setTagRoot, currentTagRoot } from '../immich/photo-facts.svelte.ts';
  import { rejectTagIds } from '../immich/shot-flags.ts';
  import { NO_FILTER, factBadges, filterActive, filterStrip, normalizeFilter, stripNeighbours, type Neighbours, type StripFilter } from '../immich/strip-view.ts';
  import { drafts } from '../drafts/drafts.svelte.ts';
  import { arrangeGroups, badgeFor, tooltipFor } from '../immich/cull-view.ts';
  import { cullerStatus, lookupCull, makeBest, waitForRun, type CullInfo, type CullerStatus } from '../immich/culler.ts';
  import { looks } from '../immich/looks.ts';
  import { draftPhotos } from '../drafts/drafts.svelte.ts';
  import type { StackFrame } from '../immich/stack-view.ts';
  import CullPanel from './CullPanel.svelte';
  import StackViewer from './StackViewer.svelte';

  interface Props {
    ctx: string | null;
    current: AssetResponseDto;
    /** `asset`: the photo's info from the filmstrip's list, when it has it. */
    onSelect: (id: string, asset?: AssetResponseDto) => void;
    /** Where ← → ↑ ↓ go, and the photos to get ready (strip-view.ts). */
    onNeighbours?: (n: Neighbours) => void;
    /** The user may change stacks (owner of the photo). */
    canCull?: boolean;
    /** What the culler decided for the photo being edited. */
    onCurrentCull?: (info: CullInfo | null) => void;
    /** Start collapsed until the user opens it (phones, where the photo needs the room). */
    startCollapsed?: boolean;
    /** The stack window is open on the stack of this photo (null: closed). */
    stackFor?: string | null;
    /** The photo being edited has unsaved changes (the stack window warns before deleting it). */
    unsaved?: boolean;
    /** "Delete others" in the stack window moved the photo being edited to the trash. */
    onCurrentDeleted?: (kept: StackFrame) => void;
    /** Saves the drafts of these photos to Immich (absent: the user can't save here). */
    onSaveDrafts?: (assetIds: Set<string>) => void;
    /** The saved JPEG of the photo being edited (its thumbnail follows a save). */
    currentRenderId?: string | null;
  }

  let {
    ctx,
    current,
    onSelect,
    onNeighbours,
    canCull = false,
    onCurrentCull,
    startCollapsed = false,
    stackFor = $bindable(null),
    unsaved = false,
    onCurrentDeleted,
    onSaveDrafts,
    currentRenderId = null,
  }: Props = $props();

  const COLLAPSED_KEY = 'raw-editor.filmstrip.collapsed';
  const STACKS_KEY = 'raw-editor.filmstrip.stacksCollapsed';
  const FILTER_KEY = 'raw-editor.filmstrip.filter';
  const HEIGHT_KEY = 'raw-editor.filmstrip.height';
  const readJson = (key: string): unknown => {
    try {
      return JSON.parse(localStorage.getItem(key) ?? 'null');
    } catch {
      return null;
    }
  };
  const writeJson = (key: string, v: unknown) => {
    try {
      localStorage.setItem(key, JSON.stringify(v));
    } catch {
      // storage blocked: only this page remembers it
    }
  };
  const readFlag = (key: string, fallback = false) => {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : v === '1';
    } catch {
      return fallback;
    }
  };
  const writeFlag = (key: string, on: boolean) => {
    try {
      localStorage.setItem(key, on ? '1' : '0');
    } catch {
      // storage blocked: only this page remembers it
    }
  };

  let items = $state<AssetResponseDto[]>([]);
  let loading = $state(true);
  let collapsed = $state(readFlag(COLLAPSED_KEY, untrack(() => startCollapsed)));
  let loadedCtx: string | null | undefined = undefined;

  let culler = $state<CullerStatus | null>(null);
  let cull = $state<Record<string, CullInfo>>({});
  let stacksCollapsed = $state(readFlag(STACKS_KEY));
  let panelOpen = $state(false);
  let busyGroup = $state<string | null>(null);
  let cullError = $state<string | null>(null);

  const groupIds = $derived([...new Set(Object.values(cull).map((i) => i.groupId))]);
  const collapsedGroups = $derived(new Set(stacksCollapsed ? groupIds : []));
  let filter = $state<StripFilter>(normalizeFilter(readJson(FILTER_KEY)));
  /** The reject tags have been read: they, not the culler's verdict, say what is rejected. */
  let rejectsKnown = $state(false);
  const filtering = $derived(filterActive(filter));
  const arranged = $derived(arrangeGroups(items, cull, collapsedGroups, current.id));
  /** The cells shown: the arranged strip with the filters applied (the open photo always stays). */
  const strip = $derived(filterStrip(arranged, filter, factsOf, current.id));
  const index = $derived(strip.findIndex((s) => s.asset.id === current.id));
  /** Thumbnail height (px), dragged at the strip's top edge. */
  let thumbH = $state(Math.min(200, Math.max(48, Number(readJson(HEIGHT_KEY)) || 64)));
  /** Photos of the filmstrip with a draft, the open one also with changes not in its draft yet. */
  const withDrafts = $derived(new Set(items.filter((a) => draftPhotos.has(a.id) || (a.id === current.id && unsaved)).map((a) => a.id)));

  // Load once per context; reload only if the current asset is not in the list.
  $effect(() => {
    const c = ctx;
    const id = current.id;
    const cur = $state.snapshot(current) as AssetResponseDto;
    if (c === loadedCtx && untrack(() => items.some((a) => a.id === id))) return;
    loadedCtx = c;
    loading = true;
    let cancelled = false;
    loadFilmstrip(c, cur).then((list) => {
      if (cancelled) return;
      items = list;
      loading = false;
      for (const a of list) noteFacts(a.id, { rating: a.exifInfo?.rating && a.exifInfo.rating > 0 ? a.exifInfo.rating : null, favorite: a.isFavorite });
      void refreshCull(list).then(() => loadRejected(c, cur, list));
    });
    return () => {
      cancelled = true;
    };
  });

  /** Which photos carry a reject tag (the culler's or a manual one). */
  async function loadRejected(c: string | null, cur: AssetResponseDto, list: AssetResponseDto[]) {
    try {
      const tagIds = rejectTagIds(currentTagRoot(), await getAllTags());
      const rejected = await loadTagged(c, cur, tagIds);
      for (const a of list) noteFacts(a.id, { rejected: rejected.has(a.id) });
      rejectsKnown = true;
    } catch (e) {
      console.warn('Filmstrip: could not read the reject tags', e);
    }
  }

  async function refreshCull(list = items) {
    culler = await cullerStatus();
    setTagRoot(culler?.tagRoot);
    if (!culler) return;
    try {
      cull = (await lookupCull(list.map((a) => a.id))) ?? {};
    } catch (e) {
      cullError = e instanceof Error ? e.message : String(e);
    }
  }

  $effect(() => {
    const n = stripNeighbours(strip, index);
    untrack(() => onNeighbours?.(n));
  });

  // Filtering by edits needs to know them for every photo, not just the ones scrolled to.
  $effect(() => {
    if (filter.edits === 'edited' || filter.edits === 'unedited') for (const a of items) untrack(() => void learnEdited(a.id));
  });

  function setFilter(patch: Partial<StripFilter>) {
    filter = { ...filter, ...patch };
    writeJson(FILTER_KEY, filter);
  }

  async function learnEdited(id: string): Promise<string | null> {
    const state = await editStates.get(id);
    noteFacts(id, { edited: !!state.stored });
    return state.renderId;
  }

  // The strip's top edge sets the thumbnails' height.
  function resize(e: PointerEvent) {
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const y0 = e.clientY;
    const h0 = thumbH;
    const move = (m: PointerEvent) => (thumbH = Math.min(200, Math.max(48, Math.round(h0 + y0 - m.clientY))));
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      writeJson(HEIGHT_KEY, thumbH);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  }

  // What the photos around this one and the rest of its stack look like gets ready (looks.ts),
  // so switching to one of them shows it at once, also to the photos of a collapsed stack.
  $effect(() => {
    const i = index;
    if (i < 0) return;
    const near = [i + 1, i - 1, i + 2, i - 2].map((k) => strip[k]?.asset).filter((a): a is AssetResponseDto => !!a);
    const gid = cull[current.id]?.groupId;
    const mates = gid ? items.filter((a) => a.id !== current.id && cull[a.id]?.groupId === gid) : [];
    const wanted = new Map([...near, ...mates].map((a) => [a.id, $state.snapshot(a) as AssetResponseDto]));
    untrack(() => looks.prefetch([...wanted.values()]));
  });

  $effect(() => {
    const info = cull[current.id] ?? null;
    untrack(() => onCurrentCull?.(info));
  });

  function toggle() {
    collapsed = !collapsed;
    writeFlag(COLLAPSED_KEY, collapsed);
  }

  function toggleAllStacks() {
    stacksCollapsed = !stacksCollapsed;
    writeFlag(STACKS_KEY, stacksCollapsed);
  }

  function openFromStack(rawId: string) {
    stackFor = null;
    if (rawId !== current.id) onSelect(rawId);
  }

  function afterDelete(trashed: string[], kept: StackFrame, warning: string | null) {
    stackFor = null;
    const gone = new Set(trashed);
    items = items.filter((a) => !gone.has(a.id));
    cullError = warning;
    if (gone.has(current.id)) onCurrentDeleted?.(kept);
    else void refreshCull();
  }

  async function pick(gid: string, assetId: string) {
    busyGroup = gid;
    cullError = null;
    try {
      const run = await waitForRun(await makeBest(gid, assetId));
      if (run.status === 'failed') cullError = run.error ?? 'Could not change the best photo';
      await refreshCull();
    } catch (e) {
      cullError = e instanceof Error ? e.message : String(e);
    } finally {
      busyGroup = null;
    }
  }

  const thumbUrl = (id: string) => apiUrl(`/assets/${id}/thumbnail?size=thumbnail`);

  /**
   * The photo as edited, once it scrolls into view: its draft's picture (kept in this browser),
   * else its saved JPEG's thumbnail, else the RAW's. With an API key <img> can't send the header,
   * so Immich's thumbnails are fetched as blobs.
   */
  function thumb(node: HTMLImageElement, p: { id: string; draft: boolean; render: string | null }) {
    let objectUrl: string | null = null;
    let io: IntersectionObserver | null = null;
    let wanted = p;
    const show = (url: string, own: boolean) => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = own ? url : null;
      node.src = url;
    };
    const fill = async (q: typeof p) => {
      const draft = q.draft ? await drafts.get(q.id, null).catch(() => null) : null;
      if (wanted !== q) return;
      if (draft?.thumb) return show(URL.createObjectURL(draft.thumb), true);
      const id = q.render ?? (await learnEdited(q.id)) ?? q.id;
      if (wanted !== q) return;
      if (!hasApiKey()) return show(thumbUrl(id), false);
      const b = await fetch(thumbUrl(id), { headers: authHeaders() })
        .then((r) => (r.ok ? r.blob() : null))
        .catch(() => null);
      if (b && wanted === q) show(URL.createObjectURL(b), true);
    };
    const load = (q: typeof p) => {
      wanted = q;
      io?.disconnect();
      io = new IntersectionObserver(
        (entries) => {
          if (!entries.some((e) => e.isIntersecting)) return;
          io?.disconnect();
          void fill(q);
        },
        { root: node.closest('.strip'), rootMargin: '0px 300px' },
      );
      io.observe(node);
    };
    load(p);
    return {
      update: load,
      destroy() {
        io?.disconnect();
        if (objectUrl) URL.revokeObjectURL(objectUrl);
      },
    };
  }

  function centreIf(node: HTMLElement, isCurrent: boolean) {
    const run = (c: boolean) => c && node.scrollIntoView({ block: 'nearest', inline: 'center' });
    queueMicrotask(() => run(isCurrent));
    return { update: run };
  }

  const label = (a: AssetResponseDto) => {
    const t = captureTime(a);
    return t ? `${a.originalFileName} · ${new Date(t).toLocaleString(undefined, { timeZone: 'UTC' })}` : a.originalFileName;
  };
</script>

<div class="filmstrip" class:collapsed>
  <div class="head">
    <button class="toggle" onclick={toggle} aria-expanded={!collapsed} title={collapsed ? 'Show filmstrip' : 'Hide filmstrip'}>
      <span class="tri" class:open={!collapsed}>▸</span>
      Filmstrip
    </button>
    {#if culler && !collapsed}
      {#if groupIds.length}
        <button class="headbtn" onclick={toggleAllStacks} title={stacksCollapsed ? 'Show every photo of each stack' : 'Show only the best photo of each stack'}>
          {stacksCollapsed ? 'Expand stacks' : 'Collapse stacks'}
        </button>
      {/if}
      {#if canCull}
        <button class="headbtn" class:active={panelOpen} onclick={() => (panelOpen = !panelOpen)} title="Stack similar photos and pick the best of each">Auto-stack…</button>
      {/if}
    {/if}
    {#if onSaveDrafts && withDrafts.size && !collapsed}
      <button class="headbtn" onclick={() => onSaveDrafts(withDrafts)} title="Render the drafts of these photos and save them to Immich, one photo at a time">
        Save {withDrafts.size} {withDrafts.size === 1 ? 'draft' : 'drafts'}
      </button>
    {/if}
    {#if cullError}<span class="err" title={cullError}>{cullError}</span>{/if}
    {#if !collapsed}
      <span class="filters" class:on={filtering}>
        <select aria-label="Stars at least" title="Only photos with at least this many stars" value={filter.minRating} onchange={(e) => setFilter({ minRating: Number(e.currentTarget.value) })}>
          <option value={0}>★ any</option>
          {#each [1, 2, 3, 4, 5] as n (n)}<option value={n}>★ {n}+</option>{/each}
        </select>
        <button class="chip" class:active={filter.favorites} aria-pressed={filter.favorites} onclick={() => setFilter({ favorites: !filter.favorites })} title="Only picks (favourites)">♥</button>
        <button class="chip" class:active={filter.hideRejected} aria-pressed={filter.hideRejected} onclick={() => setFilter({ hideRejected: !filter.hideRejected })} title="Hide rejected photos">✕</button>
        <select aria-label="Edits" title="By edit" value={filter.edits} onchange={(e) => setFilter({ edits: e.currentTarget.value as StripFilter['edits'] })}>
          <option value="any">all</option>
          <option value="edited">edited</option>
          <option value="unedited">not edited</option>
          <option value="draft">drafts</option>
        </select>
        {#if filtering}<button class="chip" onclick={() => setFilter(NO_FILTER)} title="Show every photo again">clear</button>{/if}
      </span>
    {/if}
    <span class="count">
      {#if loading}loading…{:else if index >= 0}{index + 1} of {strip.length}{:else}{strip.length}{/if}{#if filtering && !loading}&nbsp;(of {arranged.length}){/if}
    </span>
    {#if panelOpen}
      <CullPanel {ctx} {current} status={culler} onClose={() => (panelOpen = false)} onChanged={() => refreshCull()} />
    {/if}
  </div>
  {#if !collapsed}
    <div class="resize" role="separator" aria-orientation="horizontal" aria-label="Thumbnail size" title="Drag to make the thumbnails bigger or smaller" onpointerdown={resize}></div>
    <div class="strip" role="listbox" aria-label="Photos" style:--thumb-h="{thumbH}px">
      {#each strip as s (s.asset.id)}
        {@const a = s.asset}
        {@const f = factsOf(a.id)}
        {@const culled = badgeFor(s.info)}
        <!-- A reject taken off (U, P, or in Immich) shows as such before the culler runs again. -->
        {@const badge = culled?.tone === 'rejected' && rejectsKnown && !f.rejected ? null : culled}
        {@const g = s.group}
        <div class="slot" class:grouped={!!g} class:gfirst={g?.first} class:glast={g?.last} class:busy={g && busyGroup === g.id}>
          <button
            class="cell"
            class:current={a.id === current.id}
            class:rejected={rejectsKnown ? f.rejected : badge?.tone === 'rejected'}
            role="option"
            aria-selected={a.id === current.id}
            title={tooltipFor(label(a), s.info)}
            onclick={() => a.id !== current.id && onSelect(a.id, $state.snapshot(a) as AssetResponseDto)}
            use:centreIf={a.id === current.id}
          >
            <img alt={a.originalFileName} use:thumb={{ id: a.id, draft: f.draft, render: a.id === current.id ? currentRenderId : null }} draggable="false" />
          </button>
          {#if badge}
            <span class="badge {badge.tone}" aria-label={badge.label}>{badge.icon}</span>
          {/if}
          {#if factBadges(f).length}
            <span class="facts">
              {#each factBadges(f) as b (b.tone)}<span class="fact {b.tone}" title={b.label} aria-label={b.label}>{b.icon}</span>{/each}
            </span>
          {/if}
          {#if g?.first}
            <button class="gcount" onclick={() => (stackFor = a.id)} title={`Compare the ${g.size} photos of this stack`}>
              {g.collapsed ? `+${g.hidden}` : g.size}
            </button>
          {/if}
          {#if canCull && g && !g.collapsed && s.info?.role !== 'best'}
            <button class="pick" disabled={busyGroup !== null} onclick={() => pick(g.id, a.id)} title="Make this the best photo of the stack" aria-label="Make this the best photo">★</button>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

{#if stackFor}
  <StackViewer
    assetId={stackFor}
    {canCull}
    editing={{ id: current.id, unsaved }}
    onClose={() => (stackFor = null)}
    onOpenInEditor={openFromStack}
    onPicked={() => refreshCull()}
    onDeleted={({ trashed, kept, warning }) => afterDelete(trashed, kept, warning)}
  />
{/if}

<style>
  .filmstrip {
    background: var(--panel);
    border-top: 1px solid #111;
    width: 100%;
    flex: none;
    user-select: none;
  }
  .head {
    position: relative;
    display: flex;
    align-items: center;
    gap: 6px;
    height: 22px;
    padding: 0 10px 0 4px;
  }
  .toggle {
    background: none;
    border: none;
    padding: 2px 6px;
    font-size: 11px;
    color: var(--text-dim);
  }
  .tri {
    display: inline-block;
    width: 12px;
    transition: transform 0.12s;
  }
  .tri.open {
    transform: rotate(90deg);
  }
  .headbtn {
    background: none;
    border: 1px solid transparent;
    border-radius: 3px;
    padding: 0 6px;
    height: 18px;
    font-size: 11px;
    color: var(--text-dim);
  }
  .headbtn:hover,
  .headbtn.active {
    color: var(--text-bright);
    border-color: var(--line);
  }
  .err {
    font-size: 11px;
    color: var(--danger);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 40%;
  }
  .count {
    margin-left: auto;
    color: var(--text-dim);
    font-size: 11px;
  }
  .strip {
    display: flex;
    gap: 4px;
    overflow-x: auto;
    overflow-y: hidden;
    padding: 2px 8px 8px;
    height: calc(var(--thumb-h, 64px) + 12px);
    scrollbar-width: thin;
  }
  .slot {
    position: relative;
    flex: none;
  }
  /* A stack: a coloured line under its photos, bridging the gaps between them. */
  .slot.grouped::after {
    content: '';
    position: absolute;
    left: 0;
    right: -4px;
    bottom: -5px;
    height: 2px;
    background: var(--stack, #c9a227);
    opacity: 0.8;
  }
  .slot.grouped.gfirst::after {
    left: 2px;
    border-top-left-radius: 2px;
    border-bottom-left-radius: 2px;
  }
  .slot.grouped.glast::after {
    right: 2px;
    border-top-right-radius: 2px;
    border-bottom-right-radius: 2px;
  }
  .slot.busy {
    opacity: 0.5;
  }
  .cell {
    width: calc(var(--thumb-h, 64px) * 1.31);
    height: var(--thumb-h, 64px);
    padding: 2px;
    background: #1b1b1b;
    border: 1px solid transparent;
    border-radius: 3px;
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: 0.75;
  }
  .cell:hover {
    opacity: 1;
    border-color: #555;
  }
  .cell.current {
    opacity: 1;
    border-color: var(--accent);
    background: #2a2f38;
  }
  .cell.rejected img {
    filter: saturate(0.5) brightness(0.8);
  }
  img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    display: block;
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
    pointer-events: none;
    background: rgba(0, 0, 0, 0.65);
  }
  .badge.best {
    color: #ffd54a;
  }
  .badge.runner-up {
    color: #cfd8e3;
  }
  .badge.bracket {
    color: #9fd3ff;
  }
  .badge.rejected {
    color: #fff;
    background: rgba(200, 50, 50, 0.85);
  }
  .facts {
    position: absolute;
    bottom: 3px;
    left: 3px;
    display: flex;
    gap: 2px;
    pointer-events: none;
  }
  .fact {
    height: 13px;
    padding: 0 3px;
    border-radius: 7px;
    font-size: 9px;
    line-height: 13px;
    background: rgba(0, 0, 0, 0.65);
    color: var(--text);
  }
  .fact.rating {
    color: #ffd54a;
  }
  .fact.favorite {
    color: #ff7a9a;
  }
  .fact.rejected {
    color: #fff;
    background: rgba(200, 50, 50, 0.85);
  }
  .fact.draft {
    color: #6db3ff;
  }
  .fact.edited {
    color: #b9e6a0;
  }
  .filters {
    display: flex;
    align-items: center;
    gap: 3px;
    margin-left: 8px;
  }
  .filters select {
    height: 18px;
    padding: 0 2px;
    font-size: 11px;
    background: transparent;
    color: var(--text-dim);
    border: 1px solid transparent;
    border-radius: 3px;
  }
  .filters select:hover,
  .filters select:focus {
    border-color: var(--line);
    color: var(--text-bright);
  }
  .filters.on {
    color: var(--accent);
  }
  .chip {
    height: 18px;
    padding: 0 5px;
    font-size: 11px;
    background: none;
    border: 1px solid transparent;
    border-radius: 3px;
    color: var(--text-dim);
  }
  .chip:hover {
    color: var(--text-bright);
    border-color: var(--line);
  }
  .chip.active {
    color: var(--text-bright);
    border-color: var(--accent);
  }
  .resize {
    height: 5px;
    margin-top: -3px;
    cursor: ns-resize;
    touch-action: none;
  }
  .resize:hover {
    background: var(--line);
  }
  .gcount {
    position: absolute;
    top: 3px;
    right: 3px;
    height: 15px;
    min-width: 15px;
    padding: 0 4px;
    border: none;
    border-radius: 8px;
    font-size: 10px;
    line-height: 15px;
    color: #111;
    background: var(--stack, #c9a227);
  }
  .pick {
    position: absolute;
    bottom: 3px;
    right: 3px;
    width: 18px;
    height: 18px;
    padding: 0;
    border: none;
    border-radius: 9px;
    font-size: 11px;
    line-height: 18px;
    color: #ffd54a;
    background: rgba(0, 0, 0, 0.7);
    display: none;
  }
  .slot:hover .pick:not(:disabled) {
    display: block;
  }
  /* No hover on touch screens: the star stays visible. */
  @media (hover: none) {
    .pick:not(:disabled) {
      display: block;
    }
  }
  @media (pointer: coarse) {
    .head {
      height: 34px;
    }
    .toggle {
      padding: 8px 8px;
      font-size: 12px;
    }
    .headbtn {
      height: 28px;
      padding: 0 10px;
      font-size: 12px;
    }
    .pick {
      width: 26px;
      height: 26px;
      border-radius: 13px;
      line-height: 26px;
      font-size: 14px;
    }
    .gcount {
      height: 20px;
      min-width: 20px;
      line-height: 20px;
      border-radius: 10px;
    }
  }
</style>
