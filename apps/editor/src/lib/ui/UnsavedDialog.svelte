<script lang="ts">
  // Asked when leaving the photo (back to Immich, another photo) with unsaved changes.
  interface Props {
    fileName: string;
    /** Saving is in progress (after Yes). */
    busy: boolean;
    onSave: () => void;
    onDiscard: () => void;
    onCancel: () => void;
  }

  let { fileName, busy, onSave, onDiscard, onCancel }: Props = $props();

  function onKey(e: KeyboardEvent) {
    e.stopPropagation();
    if (busy) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  }

  function autofocus(node: HTMLElement) {
    queueMicrotask(() => node.focus());
  }
</script>

<div class="backdrop" role="presentation" onclick={() => !busy && onCancel()} onkeydown={onKey}>
  <div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="unsaved-title" aria-describedby="unsaved-text" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={onKey}>
    <h2 id="unsaved-title">Save changes?</h2>
    <p id="unsaved-text">{fileName} has unsaved changes. Save them to Immich before leaving?</p>
    <div class="buttons">
      <button onclick={onCancel} disabled={busy}>Cancel</button>
      <span class="spacer"></span>
      <button onclick={onDiscard} disabled={busy} title="Leave and discard the changes">No</button>
      <button class="primary" onclick={onSave} disabled={busy} use:autofocus>{busy ? 'Saving…' : 'Yes'}</button>
    </div>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 110;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .dialog {
    width: 380px;
    max-width: calc(100vw - 32px);
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 16px 18px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
    outline: none;
  }
  h2 {
    margin: 0 0 8px;
    font-size: 14px;
    color: var(--text-bright);
  }
  p {
    margin: 0 0 14px;
    line-height: 1.45;
    overflow-wrap: anywhere;
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
