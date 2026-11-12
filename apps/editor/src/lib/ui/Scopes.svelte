<script lang="ts">
  // The scope above the panels (histogram, waveform, RGB parade or vectorscope), a switch between
  // them, and the camera settings.
  import type { Histogram as HistogramData, ScopeData, ScopeKind } from '@immich-raw/pipeline';
  import Histogram from './Histogram.svelte';
  import ScopePlot from './ScopePlot.svelte';

  let {
    kind,
    histogram,
    data,
    clipping,
    onToggleClipping,
    onKind,
    info,
  }: {
    kind: ScopeKind;
    histogram: HistogramData | null;
    data: ScopeData | null;
    clipping: boolean;
    onToggleClipping: () => void;
    onKind: (kind: ScopeKind) => void;
    info: string;
  } = $props();

  const KINDS: { kind: ScopeKind; label: string; icon: string }[] = [
    { kind: 'histogram', label: 'Histogram', icon: 'M4 20v-6M8 20V8M12 20v-9M16 20V5M20 20v-8' },
    { kind: 'waveform', label: 'Waveform', icon: 'M3 15l3-5 3 7 3-11 3 9 3-6 3 4' },
    { kind: 'parade', label: 'RGB parade', icon: 'M3 5h5v14H3zM9.5 5h5v14h-5zM16 5h5v14h-5z' },
    { kind: 'vectorscope', label: 'Vectorscope', icon: 'M12 3a9 9 0 1 0 0 18 9 9 0 1 0 0-18M12 7v10M7 12h10' },
  ];
</script>

<div class="scopes">
  {#if kind === 'histogram'}
    <Histogram {histogram} {clipping} {onToggleClipping} />
  {:else}
    <ScopePlot {kind} data={data?.kind === kind ? data : null} />
  {/if}
  <div class="foot">
    <div class="info">{info}</div>
    <div class="kinds" role="group" aria-label="Scope">
      {#each KINDS as k (k.kind)}
        <button class="icon" class:on={k.kind === kind} title={k.label} aria-label={k.label} aria-pressed={k.kind === kind} onclick={() => onKind(k.kind)}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d={k.icon} /></svg>
        </button>
      {/each}
    </div>
  </div>
</div>

<style>
  .scopes {
    background: #161616;
    padding: 6px 8px 4px;
    border-bottom: 1px solid #111;
  }
  .foot {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 2px;
  }
  .info {
    flex: 1;
    min-width: 0;
    color: var(--text-dim);
    font-size: 11px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .kinds {
    flex: none;
    display: flex;
    gap: 1px;
  }
  .kinds button {
    padding: 2px 4px;
    background: none;
    border-color: transparent;
    color: var(--text-dim);
  }
  .kinds button.on {
    color: var(--text-bright);
    background: var(--panel-2);
  }
</style>
