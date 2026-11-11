<script lang="ts">
  // Snapshots: named versions of the settings for this photo. Click to apply.
  import Section from './Section.svelte';

  interface Snapshot {
    id: string;
    name: string;
    createdAt: string;
  }

  interface Props {
    snapshots: Snapshot[];
    onCreate: (name: string) => void;
    onApply: (id: string) => void;
    onRename: (id: string, name: string) => void;
    onDelete: (id: string) => void;
    disabled?: boolean;
  }

  let { snapshots, onCreate, onApply, onRename, onDelete, disabled = false }: Props = $props();

  let adding = $state(false);
  let newName = $state('');
  let renaming = $state<string | null>(null);
  let renameText = $state('');

  const sorted = $derived([...snapshots].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));

  // Lightroom names new snapshots after the current date and time.
  const stamp = () =>
    new Date().toLocaleString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });

  function startAdd() {
    newName = stamp();
    adding = true;
  }

  function finishAdd(ok: boolean) {
    if (ok && newName.trim()) onCreate(newName.trim());
    adding = false;
  }

  function finishRename(ok: boolean) {
    const id = renaming;
    renaming = null;
    if (ok && id && renameText.trim()) onRename(id, renameText.trim());
  }

  function remove(s: Snapshot) {
    if (confirm(`Delete the snapshot "${s.name}"?`)) onDelete(s.id);
  }

  function focusSelect(node: HTMLInputElement) {
    node.focus();
    node.select();
  }

  const keys = (done: (ok: boolean) => void) => (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Enter') done(true);
    if (e.key === 'Escape') done(false);
  };
</script>

<Section title="Snapshots" open={false}>
  {#snippet actions()}
    <button class="small" title="Create a snapshot of the current settings" aria-label="New snapshot" {disabled} onclick={startAdd}>+</button>
  {/snippet}

  {#if adding}
    <input class="edit" bind:value={newName} use:focusSelect onblur={() => finishAdd(true)} onkeydown={keys(finishAdd)} aria-label="Snapshot name" />
  {/if}

  {#if !sorted.length && !adding}
    <p class="empty">No snapshots. <b>+</b> saves the current settings under a name.</p>
  {/if}

  <ul>
    {#each sorted as s (s.id)}
      <li class="row">
        {#if renaming === s.id}
          <input class="edit" bind:value={renameText} use:focusSelect onblur={() => finishRename(true)} onkeydown={keys(finishRename)} aria-label="Snapshot name" />
        {:else}
          <button
            class="name"
            {disabled}
            title="Apply this snapshot (double-click to rename)"
            onclick={() => onApply(s.id)}
            ondblclick={() => {
              renaming = s.id;
              renameText = s.name;
            }}>{s.name}</button
          >
          <button class="icon del" title="Delete" aria-label="Delete {s.name}" onclick={() => remove(s)}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6zM19 4h-3.5l-1-1h-5l-1 1H5v2h14z" /></svg>
          </button>
        {/if}
      </li>
    {/each}
  </ul>
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
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .row {
    display: flex;
    align-items: center;
    height: 24px;
    border-radius: 3px;
  }
  .row:hover {
    background: var(--panel-2);
  }
  .name {
    flex: 1;
    min-width: 0;
    text-align: left;
    background: none;
    border: none;
    padding: 2px 6px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .del {
    display: none;
    padding: 1px 5px;
    background: none;
    border-color: transparent;
  }
  .row:hover .del,
  .row:focus-within .del {
    display: block;
  }
  /* No hover on touch screens: the delete button stays visible. */
  @media (hover: none) {
    .del {
      display: block;
    }
  }
  @media (pointer: coarse) {
    .row {
      height: 38px;
    }
  }
  .edit {
    width: 100%;
    font: inherit;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--accent);
    border-radius: 3px;
    padding: 2px 6px;
    outline: none;
    margin-bottom: 4px;
  }
</style>
