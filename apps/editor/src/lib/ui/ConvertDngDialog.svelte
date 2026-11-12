<script lang="ts">
  // Convert to DNG: build and check the DNG first, then (after an explicit OK) replace the
  // original with it in Immich.
  import { editor } from '../state/editor.svelte.ts';

  const d = $derived(editor.dngDialog);
  const busy = $derived(d?.phase === 'building' || d?.phase === 'replacing');
  const saved = $derived(d && d.dngSize && d.originalSize ? d.originalSize - d.dngSize : 0);
  const smaller = $derived(saved > 0);
  let understood = $state(false);
  const canReplace = $derived(!!d && d.phase === 'ready' && !!d.verification?.ok && smaller && (d.deleteMode === 'trash' || understood));

  const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

  function onKey(e: KeyboardEvent) {
    e.stopPropagation();
    if (e.key === 'Escape' && !busy) {
      e.preventDefault();
      editor.closeDngDialog();
    }
  }

  function autofocus(node: HTMLElement) {
    queueMicrotask(() => node.focus());
  }
</script>

{#if d}
  <div class="backdrop" role="presentation" onclick={() => editor.closeDngDialog()} onkeydown={onKey}>
    <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dng-title" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={onKey} use:autofocus>
      <h2 id="dng-title">Convert to DNG</h2>

      {#if d.blocked}
        <p class="note">{d.blocked}</p>
        <div class="buttons"><span class="spacer"></span><button onclick={() => editor.closeDngDialog()}>Close</button></div>
      {:else}
        <p class="intro">Replaces the original RAW in Immich with a DNG to save space. Albums, stack, rating, tags and your edit move over to the DNG.</p>

        <fieldset disabled={busy}>
          <legend>Compression</legend>
          <label class="choice">
            <input type="radio" name="dng-mode" checked={d.mode === 'lossy'} onchange={() => editor.setDngOptions({ mode: 'lossy' })} />
            <span><b>Lossy</b>: usually a quarter of the size or less. Full resolution, compressed like a high-quality JPEG; editing still works, with a bit less room for strong pushes.</span>
          </label>
          <label class="choice">
            <input type="radio" name="dng-mode" checked={d.mode === 'lossless'} onchange={() => editor.setDngOptions({ mode: 'lossless' })} />
            <span><b>Lossless</b>: keeps the sensor data exactly. Saves space mainly for uncompressed RAWs.</span>
          </label>
        </fieldset>

        <fieldset disabled={busy}>
          <legend>The original RAW</legend>
          <label class="choice">
            <input type="radio" name="dng-delete" checked={d.deleteMode === 'permanent'} onchange={() => editor.setDngOptions({ deleteMode: 'permanent' })} />
            <span><b>Delete permanently</b>: frees the space now. It can't be recovered.</span>
          </label>
          <label class="choice">
            <input type="radio" name="dng-delete" checked={d.deleteMode === 'trash'} onchange={() => editor.setDngOptions({ deleteMode: 'trash' })} />
            <span><b>Move to Immich's trash</b>: the space is freed when the trash is emptied.</span>
          </label>
        </fieldset>

        {#if busy}
          <div class="progress">
            <div class="label">{d.label}…</div>
            <div class="bar"><i style:width="{Math.round(d.fraction * 100)}%"></i></div>
          </div>
        {/if}

        {#if d.phase === 'ready' && d.verification}
          <div class="result" class:bad={!d.verification.ok || !smaller}>
            <div><b>{mb(d.dngSize)}</b> instead of {mb(d.originalSize)}{#if smaller}: saves {mb(saved)} ({Math.round((saved / d.originalSize) * 100)} %){/if}.</div>
            <div>{d.verification.ok ? '✓' : '✗'} {d.verification.text}</div>
            {#if !smaller}<div>The DNG isn't smaller than the original, so converting wouldn't save space{d.mode === 'lossless' ? ' (try Lossy)' : ''}.</div>{/if}
          </div>
          {#if d.verification.ok && smaller && d.deleteMode === 'permanent'}
            <label class="confirm"><input type="checkbox" bind:checked={understood} /> I understand that the original RAW file will be deleted for good.</label>
          {/if}
        {/if}

        {#if d.phase === 'error' && d.error}
          <p class="error">{d.error}</p>
        {/if}

        <p class="small">Not carried over: face tags (Immich finds the faces again), likes and comments, memories.</p>

        <div class="buttons">
          <span class="spacer"></span>
          <button onclick={() => editor.closeDngDialog()} disabled={busy}>Cancel</button>
          {#if d.phase === 'ready'}
            <button class="danger" onclick={() => editor.replaceWithDng()} disabled={!canReplace}>Replace original</button>
          {:else}
            <button class="primary" onclick={() => editor.createDng()} disabled={busy}>{d.phase === 'error' ? 'Try again' : 'Create DNG'}</button>
          {/if}
        </div>
      {/if}
    </div>
  </div>
{/if}

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
    width: 460px;
    max-width: calc(100vw - 32px);
    max-height: calc(100vh - 32px);
    overflow: auto;
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
    margin: 0 0 10px;
    line-height: 1.45;
  }
  .small {
    color: var(--text-dim);
    font-size: 11px;
  }
  .note {
    color: var(--text);
  }
  fieldset {
    border: 1px solid var(--line);
    border-radius: 6px;
    margin: 0 0 10px;
    padding: 6px 10px 8px;
    display: grid;
    gap: 6px;
  }
  legend {
    color: var(--text-dim);
    font-size: 11px;
    padding: 0 4px;
  }
  .choice {
    display: grid;
    grid-template-columns: 18px 1fr;
    gap: 6px;
    align-items: start;
    line-height: 1.4;
    cursor: pointer;
  }
  .choice input,
  .confirm input {
    accent-color: var(--accent);
    margin: 2px 0 0;
  }
  .progress {
    margin: 4px 0 12px;
  }
  .progress .label {
    color: var(--text-dim);
    margin-bottom: 4px;
  }
  .bar {
    height: 4px;
    background: var(--bg);
    border-radius: 2px;
    overflow: hidden;
  }
  .bar i {
    display: block;
    height: 100%;
    background: var(--accent);
    transition: width 0.2s;
  }
  .result {
    border: 1px solid var(--line);
    border-left: 3px solid #4caf50;
    border-radius: 4px;
    padding: 8px 10px;
    margin-bottom: 10px;
    display: grid;
    gap: 4px;
    line-height: 1.4;
  }
  .result.bad {
    border-left-color: #e5534b;
  }
  .confirm {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    margin-bottom: 10px;
    line-height: 1.4;
    cursor: pointer;
  }
  .error {
    color: #ff8a80;
  }
  .buttons {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .spacer {
    flex: 1;
  }
  .danger {
    background: #b3261e;
    border-color: #b3261e;
    color: #fff;
  }
  .danger:disabled {
    opacity: 0.45;
  }
</style>
