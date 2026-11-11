<script lang="ts">
  // Collapsible panel section, like Lightroom's right-hand panels.
  import type { Snippet } from 'svelte';

  let { title, open = $bindable(true), children, actions }: { title: string; open?: boolean; children: Snippet; actions?: Snippet } = $props();
</script>

<section>
  <header>
    <button class="toggle" onclick={() => (open = !open)} aria-expanded={open}>
      <span class="tri" class:open>▸</span>
      {title}
    </button>
    {#if actions}<div class="actions">{@render actions()}</div>{/if}
  </header>
  {#if open}
    <div class="body">{@render children()}</div>
  {/if}
</section>

<style>
  section {
    border-bottom: 1px solid #111;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: var(--panel-2);
    padding: 0 8px 0 0;
  }
  .toggle {
    flex: 1;
    text-align: left;
    background: none;
    border: none;
    padding: 7px 10px;
    font-size: 12px;
    letter-spacing: 0.02em;
    color: var(--text-bright);
  }
  .tri {
    display: inline-block;
    width: 12px;
    color: var(--text-dim);
    transition: transform 0.12s;
  }
  .tri.open {
    transform: rotate(90deg);
  }
  .body {
    padding: 8px 12px 12px;
  }
  .actions {
    display: flex;
    gap: 6px;
  }
</style>
