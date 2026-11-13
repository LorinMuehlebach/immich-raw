<script lang="ts">
  // The loading screen's progress: the step opening the photo is on, the time left for all of
  // them, and each step with how long it took or should take (estimates from earlier opens).
  import { activeStep, overallFraction, remainingText, stepDetail, type OpenStep } from '../state/open-progress.ts';

  interface Props {
    steps: OpenStep[];
    /** Shown before there are steps (while the Immich session is checked). */
    fallback: string;
  }

  let { steps, fallback }: Props = $props();

  let now = $state(performance.now());
  $effect(() => {
    const timer = setInterval(() => (now = performance.now()), 100);
    return () => clearInterval(timer);
  });

  // The bar never moves back when an estimate grows.
  let shown = 0;
  const fraction = $derived.by(() => (shown = Math.max(shown, overallFraction(steps, now))));
  const active = $derived(activeStep(steps));
</script>

<div class="open-progress">
  {#if steps.length}
    <div class="head">
      <span class="now" aria-live="polite">{active ? `${active.label}…` : 'Opening the photo…'}</span>
      <span class="left">{remainingText(steps, now)}</span>
    </div>
    <div class="bar" role="progressbar" aria-label="Opening the photo" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)}>
      <i style:width="{(fraction * 100).toFixed(1)}%"></i>
    </div>
    <ol>
      {#each steps as s (s.id)}
        {@const state = s.endedAt !== null ? 'done' : s.startedAt !== null ? 'active' : 'waiting'}
        <li class={state}>
          <span class="mark" aria-hidden="true">
            {#if state === 'done'}
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z" /></svg>
            {:else if state === 'active'}
              <span class="spinner"></span>
            {/if}
          </span>
          <span class="label">{s.label}</span>
          <span class="detail">{stepDetail(s, now)}</span>
        </li>
      {/each}
    </ol>
  {:else}
    <div class="head"><span class="now">{fallback}</span></div>
  {/if}
</div>

<style>
  .open-progress {
    width: 380px;
    max-width: calc(100% - 32px);
    background: rgba(38, 38, 38, 0.92);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 12px 14px;
    color: var(--text);
    font-size: 13px;
  }
  .head {
    display: flex;
    justify-content: space-between;
    gap: 12px;
  }
  .now {
    color: var(--text-bright);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .left {
    color: var(--text-dim);
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .bar {
    height: 4px;
    background: #3a3a3a;
    border-radius: 2px;
    margin: 8px 0 10px;
    overflow: hidden;
  }
  .bar i {
    display: block;
    height: 100%;
    background: var(--accent);
    transition: width 0.12s linear;
  }
  ol {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 4px;
  }
  li {
    display: grid;
    grid-template-columns: 16px 1fr auto;
    align-items: center;
    gap: 6px;
    font-size: 12px;
  }
  li.waiting {
    color: var(--text-dim);
  }
  li.done {
    color: var(--text-dim);
  }
  li.done .mark {
    color: var(--ok);
  }
  li.active .label {
    color: var(--text-bright);
  }
  .label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .detail {
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .mark {
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .spinner {
    width: 10px;
    height: 10px;
    border: 2px solid var(--accent);
    border-right-color: transparent;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation: none;
    }
    .bar i {
      transition: none;
    }
  }
</style>
