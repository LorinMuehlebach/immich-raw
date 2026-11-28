<script lang="ts">
  // Asked when leaving the editor (back to Immich) while photos have drafts: they live only as
  // long as the page, so they are saved to Immich or dropped.
  interface Props {
    /** Photos with unsaved changes. */
    count: number;
    /** The photo's name when it is the only one. */
    fileName?: string | null;
    onSave: () => void;
    onDiscard: () => void;
    onCancel: () => void;
  }

  let { count, fileName = null, onSave, onDiscard, onCancel }: Props = $props();

  const what = $derived(count === 1 ? (fileName ?? 'A photo') : `${count} photos`);

  function onKey(e: KeyboardEvent) {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  }

  function autofocus(node: HTMLElement) {
    queueMicrotask(() => node.focus());
  }
</script>

<div class="backdrop" role="presentation" onclick={onCancel} onkeydown={onKey}>
  <div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="leave-title" aria-describedby="leave-text" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={onKey}>
    <h2 id="leave-title">Save the drafts?</h2>
    <p id="leave-text">
      {what}
      {count === 1 ? 'has' : 'have'} unsaved changes. They are kept only while the editor is open: save them to Immich before going back?
    </p>
    <div class="buttons">
      <button onclick={onCancel}>Cancel</button>
      <span class="spacer"></span>
      <button onclick={onDiscard} title="Go back to Immich; the unsaved changes are lost">Discard</button>
      <button class="primary" onclick={onSave} use:autofocus>{count === 1 ? 'Save' : `Save ${count}`}</button>
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
    width: 400px;
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
