<script lang="ts">
  // History: every committed change, newest on top. Click a step to go back to it;
  // steps after the current one (undone) are dimmed until something new is changed.
  import Section from './Section.svelte';

  interface Props {
    steps: { label: string; at: string }[];
    /** Index of the current step in `steps`; later steps are the redo part. */
    index: number;
    onJump: (index: number) => void;
    onClear?: () => void;
  }

  let { steps, index, onJump, onClear }: Props = $props();

  const rows = $derived(steps.map((s, i) => ({ ...s, i })).reverse());

  const time = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };
</script>

<Section title="History" open={false}>
  {#snippet actions()}
    {#if onClear}
      <button class="small" title="Clear the history" disabled={steps.length < 2} onclick={onClear}>Clear</button>
    {/if}
  {/snippet}

  {#if !steps.length}
    <p class="empty">No changes yet.</p>
  {:else}
    <ol>
      {#each rows as s (s.i)}
        <li>
          <button class="step" class:current={s.i === index} class:future={s.i > index} title={time(s.at)} aria-current={s.i === index ? 'step' : undefined} onclick={() => onJump(s.i)}>
            {s.label}
          </button>
        </li>
      {/each}
    </ol>
  {/if}
</Section>

<style>
  .small {
    padding: 2px 8px;
    font-size: 11px;
  }
  .empty {
    color: var(--text-dim);
    font-size: 11px;
    margin: 0;
  }
  ol {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 240px;
    overflow-y: auto;
  }
  .step {
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    border-radius: 3px;
    padding: 3px 6px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .step:hover {
    background: var(--panel-2);
  }
  .step.current {
    background: #3a4a63;
    color: var(--text-bright);
  }
  .step.future {
    color: var(--text-dim);
    opacity: 0.6;
  }
  @media (pointer: coarse) {
    .step {
      padding: 9px 8px;
    }
  }
</style>
