<script lang="ts">
  // Filmstrip of the RAWs around the current one (same album, person or day). With the culler
  // service installed it also shows its stacks: the photos of a stack sit together, best first,
  // each with a badge saying why it lost. A stack's number opens the stack window.
  import type { AssetResponseDto } from '@immich/sdk';
  import { untrack } from 'svelte';
  import { apiUrl, authHeaders, hasApiKey } from '../immich/api.ts';
  import { captureTime, loadFilmstrip } from '../immich/context.ts';
  import { arrangeGroups, badgeFor, tooltipFor } from '../immich/cull-view.ts';
  import { cullerStatus, lookupCull, makeBest, waitForRun, type CullInfo, type CullerStatus } from '../immich/culler.ts';
  import type { StackFrame } from '../immich/stack-view.ts';
  import CullPanel from './CullPanel.svelte';
  import StackViewer from './StackViewer.svelte';

  interface Props {
    ctx: string | null;
    current: AssetResponseDto;
    onSelect: (id: string) => void;
    onNeighbours?: (prev: string | null, next: string | null) => void;
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
  }: Props = $props();

  const COLLAPSED_KEY = 'raw-editor.filmstrip.collapsed';
  const STACKS_KEY = 'raw-editor.filmstrip.stacksCollapsed';
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
  const strip = $derived(arrangeGroups(items, cull, collapsedGroups, current.id));
  const index = $derived(strip.findIndex((s) => s.asset.id === current.id));

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
      void refreshCull(list);
    });
    return () => {
      cancelled = true;
    };
  });

  async function refreshCull(list = items) {
    culler = await cullerStatus();
    if (!culler) return;
    try {
      cull = (await lookupCull(list.map((a) => a.id))) ?? {};
    } catch (e) {
      cullError = e instanceof Error ? e.message : String(e);
    }
  }

  $effect(() => {
    const i = index;
    const prev = i > 0 ? strip[i - 1]!.asset.id : null;
    const next = i >= 0 && i < strip.length - 1 ? strip[i + 1]!.asset.id : null;
    untrack(() => onNeighbours?.(prev, next));
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

  // Session cookie: a plain lazy <img>. API key: <img> can't send the header, so fetch the
  // thumbnail as a blob once it scrolls into view.
  function thumb(node: HTMLImageElement, id: string) {
    let objectUrl: string | null = null;
    let io: IntersectionObserver | null = null;
    const load = (assetId: string) => {
      io?.disconnect();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = null;
      if (!hasApiKey()) {
        node.loading = 'lazy';
        node.src = thumbUrl(assetId);
        return;
      }
      io = new IntersectionObserver(
        (entries) => {
          if (!entries.some((e) => e.isIntersecting)) return;
          io?.disconnect();
          fetch(thumbUrl(assetId), { headers: authHeaders() })
            .then((r) => (r.ok ? r.blob() : null))
            .then((b) => {
              if (!b) return;
              objectUrl = URL.createObjectURL(b);
              node.src = objectUrl;
            })
            .catch(() => {});
        },
        { root: node.closest('.strip'), rootMargin: '0px 300px' },
      );
      io.observe(node);
    };
    load(id);
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
    {#if cullError}<span class="err" title={cullError}>{cullError}</span>{/if}
    <span class="count">
      {#if loading}loading…{:else if index >= 0}{index + 1} of {strip.length}{:else}{strip.length}{/if}
    </span>
    {#if panelOpen}
      <CullPanel {ctx} {current} status={culler} onClose={() => (panelOpen = false)} onChanged={() => refreshCull()} />
    {/if}
  </div>
  {#if !collapsed}
    <div class="strip" role="listbox" aria-label="Photos">
      {#each strip as s (s.asset.id)}
        {@const a = s.asset}
        {@const badge = badgeFor(s.info)}
        {@const g = s.group}
        <div class="slot" class:grouped={!!g} class:gfirst={g?.first} class:glast={g?.last} class:busy={g && busyGroup === g.id}>
          <button
            class="cell"
            class:current={a.id === current.id}
            class:rejected={badge?.tone === 'rejected'}
            role="option"
            aria-selected={a.id === current.id}
            title={tooltipFor(label(a), s.info)}
            onclick={() => a.id !== current.id && onSelect(a.id)}
            use:centreIf={a.id === current.id}
          >
            <img alt={a.originalFileName} use:thumb={a.id} draggable="false" />
          </button>
          {#if badge}
            <span class="badge {badge.tone}" aria-label={badge.label}>{badge.icon}</span>
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
    height: 76px;
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
  .badge.rejected {
    color: #fff;
    background: rgba(200, 50, 50, 0.85);
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
