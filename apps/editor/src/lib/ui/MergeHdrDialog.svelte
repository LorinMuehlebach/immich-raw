<script lang="ts">
  // Merge to HDR: the bracket found around the photo, merged into one HDR DNG that is added to
  // Immich in front of the bracket. Without a bracket: HDR from this photo alone.
  import { editor } from '../state/editor.svelte.ts';

  const d = $derived(editor.hdrDialog);
  const busy = $derived(d?.phase === 'building' || d?.phase === 'saving');
  const included = $derived(d ? d.frames.filter((f) => f.include).length : 0);
  const span = $derived.by(() => {
    const evs = d?.frames.filter((f) => f.include).map((f) => f.ev) ?? [];
    return evs.length ? Math.max(...evs) - Math.min(...evs) : 0;
  });

  const evText = (ev: number) => (ev === 0 ? '0 EV' : `${ev > 0 ? '+' : '−'}${Math.abs(ev).toFixed(1).replace(/\.0$/, '')} EV`);

  function onKey(e: KeyboardEvent) {
    e.stopPropagation();
    if (e.key === 'Escape' && !busy) {
      e.preventDefault();
      editor.closeHdrDialog();
    }
  }

  function autofocus(node: HTMLElement) {
    queueMicrotask(() => node.focus());
  }
</script>

{#if d}
  <div class="backdrop" role="presentation" onclick={() => !busy && editor.closeHdrDialog()} onkeydown={onKey}>
    <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="hdr-title" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={onKey} use:autofocus>
      <h2 id="hdr-title">HDR</h2>

      {#if d.blocked}
        <p class="note">{d.blocked}</p>
        <div class="buttons"><span class="spacer"></span><button onclick={() => editor.closeHdrDialog()}>Close</button></div>
      {:else if d.phase === 'searching'}
        <p class="note">Looking for a bracket around this photo…</p>
        <div class="buttons"><span class="spacer"></span><button onclick={() => editor.closeHdrDialog()}>Cancel</button></div>
      {:else if d.phase === 'single'}
        <p class="note">{d.searchNote}</p>
        <p>
          A RAW holds more range than the screen shows. <b>HDR from this photo</b> compresses it: the highlights come down, the
          shadows come up and the detail stays. It sets the HDR slider (Basic › Tone) and Auto tone; you can change both after.
        </p>
        <p class="small">To merge a bracket, shoot it with the camera's exposure bracketing (or by hand, quickly, same framing) and upload all of its RAWs.</p>
        <div class="buttons">
          <span class="spacer"></span>
          <button onclick={() => editor.closeHdrDialog()}>Cancel</button>
          <button class="primary" onclick={() => editor.hdrFromPhoto()} disabled={editor.readOnly}>HDR from this photo</button>
        </div>
      {:else}
        <p class="intro">
          Merges the bracket into one HDR DNG with the range of all of them. It is added to Immich in front of the bracket, which stays as it is,
          and opens here to edit.
        </p>

        <fieldset disabled={busy}>
          <legend>Bracket ({included} of {d.frames.length}, {span.toFixed(1).replace(/\.0$/, '')} stops)</legend>
          {#each d.frames as f (f.id)}
            <label class="frame" class:off={!f.include}>
              <input type="checkbox" checked={f.include} onchange={() => editor.toggleHdrFrame(f.id)} disabled={f.include && included <= 2} />
              <span class="ev">{evText(f.ev)}</span>
              <span class="name">{f.fileName}{#if f.current} <i>(open)</i>{/if}</span>
              <span class="settings">{f.settings}</span>
            </label>
          {/each}
        </fieldset>

        <fieldset disabled={busy}>
          <legend>Options</legend>
          <label class="check">
            <input type="checkbox" checked={d.align} onchange={(e) => editor.setHdrOptions({ align: e.currentTarget.checked })} />
            <span><b>Align</b>: lines the shots up (for hand-held brackets; shifts only, not rotation).</span>
          </label>
          <label class="line">
            <span><b>Deghost</b>: where something moved between shots, use the middle one.</span>
            <select value={d.deghost} onchange={(e) => editor.setHdrOptions({ deghost: e.currentTarget.value as typeof d.deghost })}>
              <option value="off">Off</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </label>
        </fieldset>

        {#if busy}
          <div class="progress">
            <div class="label">{d.label}…</div>
            <div class="bar"><i style:width="{Math.round(d.fraction * 100)}%"></i></div>
          </div>
        {/if}

        {#if d.phase === 'error' && d.error}
          <p class="error">{d.error}</p>
        {/if}

        <p class="small">Takes a minute or two: every shot is decoded at full size. The DNG is about 3 times the size of one RAW.</p>

        <div class="buttons">
          <span class="spacer"></span>
          {#if d.phase === 'building'}
            <button onclick={() => editor.stopHdr()}>Stop</button>
          {:else}
            <button onclick={() => editor.closeHdrDialog()} disabled={busy}>Cancel</button>
          {/if}
          <button class="primary" onclick={() => editor.mergeHdr()} disabled={busy || included < 2}>{d.phase === 'error' ? 'Try again' : 'Merge'}</button>
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
    width: 500px;
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
  .frame {
    display: grid;
    grid-template-columns: 18px 56px 1fr;
    gap: 2px 6px;
    align-items: baseline;
    cursor: pointer;
  }
  .frame.off {
    opacity: 0.55;
  }
  .frame .ev {
    font-variant-numeric: tabular-nums;
    color: var(--text-bright);
  }
  .frame .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .frame .name i {
    color: var(--text-dim);
    font-style: normal;
  }
  .frame .settings {
    grid-column: 3;
    color: var(--text-dim);
    font-size: 11px;
  }
  .check {
    display: grid;
    grid-template-columns: 18px 1fr;
    gap: 6px;
    align-items: start;
    line-height: 1.4;
    cursor: pointer;
  }
  .line {
    display: flex;
    gap: 8px;
    align-items: center;
    justify-content: space-between;
    line-height: 1.4;
  }
  input[type='checkbox'] {
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
</style>
