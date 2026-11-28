<script lang="ts">
  // The edit in the header: the original or one of the RAW's virtual copies (Lightroom's). The
  // menu switches between them, makes a new copy (Ctrl+'), renames or deletes the one open, and
  // puts its JPEG in front of the RAW's stack in Immich.
  import { editor } from '../state/editor.svelte.ts';

  let { onSwitch }: { onSwitch: (copyId: string | null) => void } = $props();

  let open = $state(false);
  let renaming = $state(false);
  let draft = $state('');
  let confirmDelete = $state(false);
  const current = $derived(editor.copies.find((c) => c.id === editor.copyId) ?? null);

  function close() {
    open = false;
    renaming = false;
    confirmDelete = false;
  }

  function pick(id: string | null) {
    close();
    if (id !== editor.copyId) onSwitch(id);
  }

  function focus(node: HTMLInputElement) {
    node.focus();
    node.select();
  }

  // While open, Escape closes the menu, before the editor sees it (where it would leave the photo).
  $effect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    addEventListener('keydown', onKey, true);
    return () => removeEventListener('keydown', onKey, true);
  });
</script>

{#if editor.status === 'ready' && (editor.copies.length > 0 || !editor.readOnly)}
  <span class="copies">
    <button
      class="switch"
      class:copy={!!editor.copyId}
      onclick={() => (open ? close() : (open = true))}
      aria-haspopup="menu"
      aria-expanded={open}
      title="Virtual copies: several edits of this RAW, each saving its own JPEG in the stack"
    >
      {editor.editName}
      <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 10l5 5 5-5z" /></svg>
    </button>
    {#if open}
      <div class="shade" role="presentation" onpointerdown={close}></div>
      <div class="menu" role="menu" tabindex="-1">
        <button role="menuitemradio" aria-checked={!editor.copyId} onclick={() => pick(null)}>
          <span class="check">{editor.copyId ? '' : '✓'}</span>Original
        </button>
        {#each editor.copies as c (c.id)}
          <button role="menuitemradio" aria-checked={editor.copyId === c.id} onclick={() => pick(c.id)}>
            <span class="check">{editor.copyId === c.id ? '✓' : ''}</span>{c.name}{#if !c.renderId}<span class="dim">· not saved yet</span>{/if}
          </button>
        {/each}
        {#if !editor.readOnly}
          <hr />
          <button role="menuitem" onclick={() => (close(), editor.newVirtualCopy())}>
            <span class="check"></span>New virtual copy<kbd>Ctrl+'</kbd>
          </button>
          {#if current}
            {#if renaming}
              <form
                onsubmit={(e) => {
                  e.preventDefault();
                  void editor.renameCopy(current.id, draft);
                  close();
                }}
              >
                <input bind:value={draft} maxlength="60" aria-label="Name of the copy" use:focus />
              </form>
            {:else}
              <button role="menuitem" onclick={() => ((draft = current.name), (renaming = true))}><span class="check"></span>Rename…</button>
            {/if}
            <button
              role="menuitem"
              class:danger={confirmDelete}
              onclick={() => {
                if (!confirmDelete) return void (confirmDelete = true);
                close();
                void editor.deleteCopy(current.id);
              }}
            >
              <span class="check"></span>{confirmDelete ? `Delete ${current.name}${current.renderId ? ' and its JPEG' : ''}?` : 'Delete copy…'}
            </button>
          {/if}
          {#if editor.recipe.render}
            <button role="menuitem" onclick={() => (close(), editor.showInFront())} title="Make this edit's JPEG the photo Immich shows for the stack">
              <span class="check"></span>Show in front in Immich
            </button>
          {/if}
        {/if}
      </div>
    {/if}
  </span>
{/if}

<style>
  .copies {
    position: relative;
    flex: none;
  }
  .switch {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    font-size: 12px;
    background: none;
    color: var(--text-dim);
    white-space: nowrap;
  }
  .switch.copy {
    color: var(--accent);
    border-color: var(--accent);
  }
  .shade {
    position: fixed;
    inset: 0;
    z-index: 60;
  }
  .menu {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    z-index: 61;
    min-width: 220px;
    max-width: min(320px, calc(100vw - 24px));
    padding: 4px;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 6px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
    display: flex;
    flex-direction: column;
  }
  .menu button {
    display: flex;
    align-items: center;
    text-align: left;
    background: none;
    border: none;
    padding: 6px 8px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .menu button:hover:not(:disabled) {
    background: var(--panel-2);
  }
  .menu button.danger {
    color: var(--danger);
  }
  .check {
    display: inline-block;
    width: 18px;
    flex: none;
    color: var(--accent);
  }
  .dim {
    margin-left: 6px;
    color: var(--text-dim);
  }
  kbd {
    margin-left: auto;
    padding-left: 12px;
    color: var(--text-dim);
    font: inherit;
    font-size: 11px;
  }
  hr {
    border: none;
    border-top: 1px solid var(--line);
    margin: 4px 0;
  }
  form {
    padding: 4px 8px 4px 26px;
  }
  input {
    width: 100%;
    font: inherit;
    color: var(--text);
    background: var(--panel-2);
    border: 1px solid var(--line);
    border-radius: 4px;
    padding: 3px 6px;
  }
</style>
