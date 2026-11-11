<script lang="ts">
  // Lightroom's Copy Settings / New Preset dialog: tick the setting groups to include.
  import { GROUPS, type GroupId } from '@immich-raw/recipe';
  import { untrack } from 'svelte';

  interface Props {
    title: string;
    confirmLabel: string;
    initial: GroupId[];
    withName?: boolean;
    nameDefault?: string;
    folders?: string[];
    onConfirm: (groups: GroupId[], name?: string, folder?: string) => void;
    onCancel: () => void;
  }

  let { title, confirmLabel, initial, withName = false, nameDefault = '', folders = [], onConfirm, onCancel }: Props = $props();

  // The dialog is created fresh each time it opens, so the initial values are read once.
  let checked = $state<Record<GroupId, boolean>>(untrack(() => Object.fromEntries(GROUPS.map((g) => [g.id, initial.includes(g.id)])) as Record<GroupId, boolean>));
  let name = $state(untrack(() => nameDefault));
  let folder = $state(untrack(() => folders[0] ?? 'User Presets'));
  const titleId = `dlg-${Math.random().toString(36).slice(2, 8)}`;

  const selected = $derived(GROUPS.filter((g) => checked[g.id]).map((g) => g.id));
  const canConfirm = $derived(selected.length > 0 && (!withName || name.trim().length > 0));

  function setAll(on: boolean) {
    for (const g of GROUPS) checked[g.id] = on;
  }

  function confirm() {
    if (!canConfirm) return;
    if (withName) onConfirm(selected, name.trim(), folder.trim() || 'User Presets');
    else onConfirm(selected);
  }

  function onKey(e: KeyboardEvent) {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    } else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault();
      confirm();
    }
  }

  function autofocus(node: HTMLElement, enabled = true) {
    if (!enabled) return;
    queueMicrotask(() => {
      node.focus();
      if (node instanceof HTMLInputElement) node.select();
    });
  }
</script>

<div class="backdrop" role="presentation" onclick={onCancel} onkeydown={onKey}>
  <div class="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={onKey} use:autofocus={!withName}>
    <h2 id={titleId}>{title}</h2>

    {#if withName}
      <label class="field">
        <span>Preset name</span>
        <input bind:value={name} use:autofocus placeholder="Untitled preset" />
      </label>
      <label class="field">
        <span>Folder</span>
        <input bind:value={folder} list="{titleId}-folders" />
        <datalist id="{titleId}-folders">
          {#each folders as f (f)}<option value={f}></option>{/each}
        </datalist>
      </label>
    {/if}

    <fieldset>
      <legend>Settings to include</legend>
      {#each GROUPS as g (g.id)}
        <label class="check">
          <input type="checkbox" bind:checked={checked[g.id]} />
          {g.label}
        </label>
      {/each}
    </fieldset>

    <div class="buttons">
      <button onclick={() => setAll(true)}>Check All</button>
      <button onclick={() => setAll(false)}>Check None</button>
      <span class="spacer"></span>
      <button onclick={onCancel}>Cancel</button>
      <button class="primary" onclick={confirm} disabled={!canConfirm}>{confirmLabel}</button>
    </div>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 100;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .dialog {
    width: 360px;
    max-width: calc(100vw - 32px);
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 16px 18px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
    outline: none;
  }
  h2 {
    margin: 0 0 12px;
    font-size: 14px;
    color: var(--text-bright);
  }
  .field {
    display: grid;
    grid-template-columns: 88px 1fr;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }
  .field input {
    font: inherit;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 4px;
    padding: 4px 8px;
  }
  .field input:focus {
    outline: none;
    border-color: var(--accent);
  }
  fieldset {
    border: 1px solid var(--line);
    border-radius: 6px;
    margin: 10px 0 14px;
    padding: 8px 12px;
    display: grid;
    gap: 4px;
  }
  legend {
    color: var(--text-dim);
    font-size: 11px;
    padding: 0 4px;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 22px;
    cursor: pointer;
  }
  .check input {
    accent-color: var(--accent);
  }
  .buttons {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .spacer {
    flex: 1;
  }
</style>
